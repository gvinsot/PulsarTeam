// ── /api/analytics route scoping ─────────────────────────────────────────────
//
// Admins see every board; everyone else only the boards they own or that are
// shared with them (same rule as GET /tasks). A malformed projectId is a 400,
// not a 500 from a failed UUID cast. The DAO is faked; the routes are real.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';
import type { SessionClaims } from '../../middleware/session.js';

const PROJECT = '11111111-2222-3333-4444-555555555555';
const BOARD = '66666666-7777-8888-9999-000000000000';

const calls: { fn: string; args: unknown[] }[] = [];
const record =
  (fn: string, result: unknown) =>
  async (...args: unknown[]) => {
    calls.push({ fn, args });
    return result;
  };

const realDb = await import('../database.js');
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    getBoardsByUser: async () => [{ id: BOARD }],
  },
});

const realAnalytics = await import('../database/analytics.js');
mock.module('../database/analytics.js', {
  namedExports: {
    ...realAnalytics,
    getBoardUsageStats: record('getBoardUsageStats', []),
    getTaskActivityTimeline: record('getTaskActivityTimeline', []),
    getTaskMixStats: record('getTaskMixStats', { total: 0, byType: [] }),
    getErrorStats: record('getErrorStats', { totalErrorEvents: 0 }),
  },
});

const router = (await import('../../routes/analytics.js')).default;
const admin: SessionClaims = { userId: 'root', username: 'root', role: 'admin', csrf: 'test' };
const adminHarness = createRouteHarness(router, admin);
const userHarness = createRouteHarness(router, harnessUser({ userId: 'user-A' }));

function argsOf(fn: string) {
  const call = calls.find(c => c.fn === fn);
  assert.ok(call, `expected ${fn} to have been called`);
  return call.args;
}

test('an admin is not board-restricted and the project scope is forwarded', async () => {
  calls.length = 0;
  const res = await adminHarness.get(`/boards?days=14&projectId=${PROJECT}`);
  assert.equal(res.status, 200);
  assert.deepEqual(argsOf('getBoardUsageStats'), [14, { boardIds: null, projectId: PROJECT }]);
  assert.deepEqual(argsOf('getTaskActivityTimeline'), [14, { boardIds: null, projectId: PROJECT }]);
});

test('a non-admin is restricted to their accessible boards', async () => {
  calls.length = 0;
  assert.equal((await userHarness.get('/tasks?days=7')).status, 200);
  assert.deepEqual(argsOf('getTaskMixStats'), [7, { boardIds: [BOARD], projectId: null }]);
  calls.length = 0;
  assert.equal((await userHarness.get('/errors')).status, 200);
  assert.deepEqual(argsOf('getErrorStats'), [30, { boardIds: [BOARD], projectId: null }]);
});

test('a malformed projectId is rejected with 400 before any query', async () => {
  calls.length = 0;
  const res = await adminHarness.get('/errors?projectId=not-a-uuid');
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('the day window is clamped', async () => {
  calls.length = 0;
  await adminHarness.get('/tasks?days=100000');
  assert.equal(argsOf('getTaskMixStats')[0], 365);
  calls.length = 0;
  await adminHarness.get('/tasks?days=-3');
  assert.equal(argsOf('getTaskMixStats')[0], 30);
});
