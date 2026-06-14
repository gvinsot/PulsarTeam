/**
 * Authorization Helper Tests (IDOR protection)
 *
 * Validates that checkBoardAccess() / checkProjectAccess() correctly enforce
 * read/edit/admin levels and that users cannot access another user's resources.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// ── In-memory fixtures backing the database mock ────────────────────────────
const boards: Record<string, any> = {
  'board-A':       { id: 'board-A', user_id: 'user-A', is_default: false, name: 'A board' },
  'board-B':       { id: 'board-B', user_id: 'user-B', is_default: false, name: 'B board' },
  'board-default': { id: 'board-default', user_id: 'user-A', is_default: true,  name: 'Default' },
};
const boardShares: Array<{ board_id: string; user_id: string; permission: 'read' | 'edit' | 'admin' }> = [
  { board_id: 'board-A', user_id: 'user-C', permission: 'read' },
  { board_id: 'board-A', user_id: 'user-D', permission: 'edit' },
];
const projects: Record<string, any> = {
  'proj-A': { id: 'proj-A', name: 'Project A', owner_id: 'user-A' },
  'proj-shared': { id: 'proj-shared', name: 'Shared Project', owner_id: 'user-A' },
  'proj-orphan': { id: 'proj-orphan', name: 'Orphan', owner_id: null },
};
const projectBoardMembers: Record<string, string[]> = {
  'proj-shared': ['user-C'],
};

// Stub database module BEFORE importing the middleware under test
mock.module('../database.js', {
  namedExports: {
    getBoardById: async (id: string) => boards[id] || null,
    getBoardShare: async (boardId: string, userId: string) =>
      boardShares.find(s => s.board_id === boardId && s.user_id === userId) || null,
    getProjectById: async (id: string) => projects[id] || null,
    hasProjectBoardAccess: async (projectId: string, userId: string) =>
      (projectBoardMembers[projectId] || []).includes(userId),
    isDatabaseConnected: () => true,
    // Other exports stubbed as no-ops so importing auth.ts doesn't blow up
    getUserByUsername: async () => null,
    getUserById: async () => null,
    createUser: async () => ({}),
    countUsers: async () => 0,
    getUserByGoogleId: async () => null,
    createGoogleUser: async () => ({}),
    linkGoogleId: async () => {},
    getUserByMicrosoftId: async () => null,
    createMicrosoftUser: async () => ({}),
    linkMicrosoftId: async () => {},
    getUserByGitHubId: async () => null,
    createGitHubUser: async () => ({}),
    linkGitHubId: async () => {},
    acceptTerms: async () => {},
    completeTutorial: async () => {},
  },
});

mock.module('../userProvisioning.js', {
  namedExports: { provisionNewUser: async () => {} },
});

mock.module('../../secrets.js', {
  namedExports: { readSecret: () => 'test-secret' },
});

const { checkBoardAccess, checkProjectAccess } = await import('../../middleware/authz.js');

// ── Board access ────────────────────────────────────────────────────────────

test('checkBoardAccess: owner has admin', async () => {
  const r = await checkBoardAccess('board-A', 'user-A', 'advanced', 'admin');
  assert.equal(r.ok, true);
  assert.equal(r.permission, 'admin');
  assert.equal(r.isOwner, true);
});

test('checkBoardAccess: stranger denied with 403', async () => {
  const r = await checkBoardAccess('board-A', 'user-B', 'advanced', 'read');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('checkBoardAccess: stranger CANNOT modify another user board (IDOR)', async () => {
  const r = await checkBoardAccess('board-A', 'user-B', 'advanced', 'edit');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('checkBoardAccess: read-only share blocked from edit', async () => {
  const r = await checkBoardAccess('board-A', 'user-C', 'advanced', 'edit');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('checkBoardAccess: read-only share allowed for read', async () => {
  const r = await checkBoardAccess('board-A', 'user-C', 'advanced', 'read');
  assert.equal(r.ok, true);
  assert.equal(r.permission, 'read');
});

test('checkBoardAccess: edit share allowed for edit', async () => {
  const r = await checkBoardAccess('board-A', 'user-D', 'advanced', 'edit');
  assert.equal(r.ok, true);
  assert.equal(r.permission, 'edit');
});

test('checkBoardAccess: admin role bypasses all checks', async () => {
  const r = await checkBoardAccess('board-A', 'user-Z', 'admin', 'admin');
  assert.equal(r.ok, true);
  assert.equal(r.permission, 'admin');
});

test('checkBoardAccess: missing boardId returns 400', async () => {
  const r = await checkBoardAccess(undefined, 'user-A', 'advanced', 'read');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('checkBoardAccess: unknown board returns 404', async () => {
  const r = await checkBoardAccess('does-not-exist', 'user-A', 'advanced', 'read');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('checkBoardAccess: default board readable by anyone', async () => {
  const r = await checkBoardAccess('board-default', 'user-Z', 'advanced', 'read');
  assert.equal(r.ok, true);
});

test('checkBoardAccess: default board NOT writable by non-admin', async () => {
  const r = await checkBoardAccess('board-default', 'user-Z', 'advanced', 'edit');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

// ── Project access ──────────────────────────────────────────────────────────

test('checkProjectAccess: stranger CANNOT read another user project (IDOR)', async () => {
  const r = await checkProjectAccess('proj-A', 'user-Z', 'basic', 'read');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('checkProjectAccess: project owner may read their project', async () => {
  const r = await checkProjectAccess('proj-A', 'user-A', 'basic', 'read');
  assert.equal(r.ok, true);
  assert.equal(r.isOwner, true);
});

test('checkProjectAccess: attached board member may read a shared project', async () => {
  const r = await checkProjectAccess('proj-shared', 'user-C', 'basic', 'read');
  assert.equal(r.ok, true);
  assert.equal(r.isOwner, false);
});

test('checkProjectAccess: only owner may edit', async () => {
  const r = await checkProjectAccess('proj-A', 'user-A', 'advanced', 'edit');
  assert.equal(r.ok, true);
  assert.equal(r.isOwner, true);
});

test('checkProjectAccess: non-owner CANNOT edit (IDOR)', async () => {
  const r = await checkProjectAccess('proj-A', 'user-B', 'advanced', 'edit');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('checkProjectAccess: non-owner CANNOT delete (IDOR)', async () => {
  const r = await checkProjectAccess('proj-A', 'user-B', 'advanced', 'admin');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('checkProjectAccess: admin role can edit any project', async () => {
  const r = await checkProjectAccess('proj-A', 'user-Z', 'admin', 'admin');
  assert.equal(r.ok, true);
});

test('checkProjectAccess: orphan project (owner_id null) cannot be edited by non-admin', async () => {
  const r = await checkProjectAccess('proj-orphan', 'user-Z', 'advanced', 'edit');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('checkProjectAccess: missing projectId returns 400', async () => {
  const r = await checkProjectAccess(undefined, 'user-A', 'advanced', 'read');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('checkProjectAccess: unknown project returns 404', async () => {
  const r = await checkProjectAccess('does-not-exist', 'user-A', 'advanced', 'read');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});
