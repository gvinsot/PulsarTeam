/**
 * POST /api/contact — the public contact form inserts with a SERVER-HELD key.
 *
 * The visitor is anonymous; the credential is the `insert` API key provided as
 * the Docker secret HOME_FORM_KEY. What must hold:
 *
 *  1. The key is authorized by `authorizeScopedApiKey`, the same checks as
 *     POST /api/insert/tasks: the task lands on the KEY's board, nowhere else.
 *  2. No key, a revoked key, a non-insert key, or an owner who lost edit on
 *     the board: nothing is written, and the visitor gets a bland 503 rather
 *     than the reason (that belongs in the logs).
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteHarness } from './helpers/routeHarness.js';

// ── Key store and rows, faked at the same boundaries as apiKeyScopeMiddleware ──
const KEYS: Record<string, any> = {
  'key-contact': {
    id: 'k-contact',
    userId: 'user-a',
    scope: 'insert',
    boardId: 'board-support',
    legacy: false,
  },
  'key-management': {
    id: 'k-mgmt',
    userId: 'user-a',
    scope: 'management',
    boardId: null,
    legacy: false,
  },
  'key-shared': {
    id: 'k-shared',
    userId: 'user-a',
    scope: 'insert',
    boardId: 'board-shared',
    legacy: false,
  },
};
const USERS: Record<string, any> = {
  'user-a': { id: 'user-a', username: 'alice', role: 'advanced' },
};
const BOARDS: Record<string, any> = {
  'board-support': {
    id: 'board-support',
    name: 'Support',
    user_id: 'user-a',
    workflow: {
      columns: [
        { id: 'col-backlog', label: 'Backlog' },
        { id: 'col-tickets', label: 'Tickets' },
      ],
    },
  },
  'board-shared': { id: 'board-shared', name: 'Shared', user_id: 'user-b' },
};
const SHARES: Record<string, string | undefined> = { 'board-shared': 'read' };

const { scopeSatisfies } = await import('../apiKeyManager.js');

mock.module('../../services/apiKeyManager.js', {
  namedExports: {
    resolveApiKey: async (key: string) => KEYS[key] || null,
    scopeSatisfies,
    touchApiKey: async () => {},
    validateApiKey: async () => false,
  },
});

mock.module('../../services/database.js', {
  namedExports: {
    getUserById: async (id: string) => USERS[id] || null,
    getBoardById: async (id: string) => BOARDS[id] || null,
    getBoardShare: async (boardId: string) =>
      SHARES[boardId] ? { board_id: boardId, permission: SHARES[boardId] } : null,
    getProjectById: async () => null,
    hasProjectBoardAccess: async () => false,
  },
});

// The write itself is shared with the insert API and covered there; here we
// only need to see what the route hands it.
const inserts: any[] = [];
mock.module('../../services/mcp/taskInsertion.js', {
  namedExports: {
    createBoardTask: async (_mgr: unknown, actor: any, board: any, fields: any, source: any) => {
      inserts.push({ actor, board, fields, source });
      return { ok: true, task: { id: 'task-1' } };
    },
  },
});

const { contactRoutes } = await import('../../routes/contact.js');

const SUBMISSION = {
  email: 'jane@acme.test',
  phone: '+33 6 12 34 56 78',
  name: 'Jane',
  company: 'Acme',
  message: 'We need help.',
  type: 'contact',
};

/** A fresh router per call, so the per-IP rate limiter never carries over. */
async function submit(body: unknown = SUBMISSION) {
  inserts.length = 0;
  const res = await createRouteHarness(contactRoutes({}), null).post('/', body);
  return { status: res.status, body: await res.json() };
}

function withKey(value: string | undefined) {
  if (value === undefined) delete process.env.HOME_FORM_KEY;
  else process.env.HOME_FORM_KEY = value;
}

test('a submission becomes a task on the board of the server-held insert key', async () => {
  withKey('key-contact');
  const { status, body } = await submit();

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(inserts.length, 1);

  const [{ actor, board, fields, source }] = inserts;
  assert.equal(board.id, 'board-support', 'the board comes from the key, never the request');
  assert.equal(actor.userId, 'user-a', 'the task is written as the key owner');
  assert.equal(fields.status, 'col-tickets', 'the "Tickets" column is preferred');
  assert.equal(fields.task_type, 'feature');
  assert.match(fields.task, /^\[Contact Request\] Jane \(Acme\)/);
  assert.match(fields.task, /Email: jane@acme\.test/);
  assert.deepEqual(source, {
    type: 'website',
    scope: 'insert',
    apiKeyId: 'k-contact',
    name: 'Jane',
  });
});

test('without HOME_FORM_KEY nothing is written and the form answers 503', async () => {
  withKey(undefined);
  const { status, body } = await submit();
  assert.equal(status, 503);
  assert.equal(inserts.length, 0);
  assert.doesNotMatch(body.error, /key/i, 'the visitor is not told about the key');
});

test('a key that is unknown, not an insert key, or lost its board is refused', async () => {
  for (const key of ['key-revoked', 'key-management', 'key-shared']) {
    withKey(key);
    const { status } = await submit();
    assert.equal(status, 503, `${key} must not create a task`);
    assert.equal(inserts.length, 0, `${key} must not create a task`);
  }
});

test('an invalid phone is rejected before the key is even used', async () => {
  withKey('key-contact');
  const { status } = await submit({ ...SUBMISSION, phone: '12' });
  assert.equal(status, 400);
  assert.equal(inserts.length, 0);
});
