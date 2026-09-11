// ── Budget data is scoped to the selected project ────────────────────────────
//
// The web UI has a global project scope chip in the Dashboard header. Every
// other view honours it; the Budget view used to ignore it entirely and always
// render global (or, for a non-admin, user-wide) totals — so switching projects
// changed nothing on the cards, the charts or the LLM table.
//
// Two layers are locked in here:
//
//   • the DAO (services/database/tokenUsage.ts) — a `projectId` narrows
//     token_usage_log to the rows produced by that project's agents, via
//     agent_id → agents.id → agents.board_id → boards.project_id, and it ANDs
//     with the existing per-user filter rather than replacing it;
//   • the routes (routes/budget.ts) — every read forwards the query param, and
//     a malformed one is a 400 instead of a 500 from a failed UUID cast.
//
// Only the pg pool / the DAO module are faked; the SQL construction and the
// route handlers under test are the real ones.

import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';
import type { SessionClaims } from '../../middleware/session.js';

const PROJECT = '11111111-2222-3333-4444-555555555555';

/* ── Layer 1: the DAO builds the project filter ──────────────────────────── */

const queries: { text: string; params: unknown[] }[] = [];

const realConnection = await import('../database/connection.js');
mock.module('../database/connection.js', {
  namedExports: {
    ...realConnection,
    getPool: () => ({
      query: async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        return { rows: [], rowCount: 0 };
      },
    }),
  },
});

const tokenUsage = await import('../database/tokenUsage.js');

/** The most recent statement, with whitespace collapsed for readable matching. */
function lastQuery() {
  const q = queries[queries.length - 1];
  assert.ok(q, 'expected a query to have been issued');
  return { sql: q.text.replace(/\s+/g, ' '), params: q.params };
}

beforeEach(() => {
  queries.length = 0;
});

test('getTokenUsageByAgent scopes to the project agents when given a projectId', async () => {
  await tokenUsage.getTokenUsageByAgent(7, null, PROJECT);
  const { sql, params } = lastQuery();
  assert.match(sql, /AND agent_id IN \( SELECT a\.id::text FROM agents a/);
  assert.match(sql, /JOIN boards b ON b\.id = a\.board_id WHERE b\.project_id = \$2::uuid/);
  assert.deepEqual(params, [7, PROJECT]);
});

test('the project filter ANDs with the per-user filter, in placeholder order', async () => {
  await tokenUsage.getTokenUsageByAgent(30, 'user-A', PROJECT);
  const { sql, params } = lastQuery();
  assert.match(sql, /AND user_id = \$2/);
  assert.match(sql, /WHERE b\.project_id = \$3::uuid/);
  assert.deepEqual(params, [30, 'user-A', PROJECT]);
});

test('an absent projectId leaves the query exactly as it was', async () => {
  await tokenUsage.getTokenUsageByAgent(30, 'user-A');
  const { sql, params } = lastQuery();
  assert.match(sql, /AND user_id = \$2/);
  assert.doesNotMatch(sql, /project_id/);
  assert.deepEqual(params, [30, 'user-A']);
});

test('getTokenUsageTimeline places the project filter after its own two params', async () => {
  await tokenUsage.getTokenUsageTimeline(7, 'hour', null, PROJECT);
  const { sql, params } = lastQuery();
  assert.match(sql, /WHERE b\.project_id = \$3::uuid/);
  assert.deepEqual(params, ['hour', 7, PROJECT]);
});

test('getDailyTokenUsage scopes to the project', async () => {
  await tokenUsage.getDailyTokenUsage(30, null, PROJECT);
  const { sql, params } = lastQuery();
  assert.match(sql, /WHERE b\.project_id = \$2::uuid/);
  assert.deepEqual(params, [30, PROJECT]);
});

test('a project scope bypasses the global summary cache and queries', async () => {
  // Without any scope the summary is served from the periodically refreshed
  // cache, which holds GLOBAL totals — returning it for a project would report
  // every project's spend under one project's name.
  await tokenUsage.getTokenUsageSummaryAsync(1, null, PROJECT);
  const { sql, params } = lastQuery();
  assert.match(sql, /WHERE b\.project_id = \$2::uuid/);
  assert.deepEqual(params, [1, PROJECT]);

  queries.length = 0;
  await tokenUsage.getTokenUsageSummaryAsync(1, null, null);
  assert.equal(queries.length, 0, 'the unscoped summary must still come from the cache');
});

/* ── Layer 2: the routes forward and validate the query param ────────────── */

/** Every DAO call the budget routes make, in order, as (name, ...args). */
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
    getPool: () => null,
    getSetting: () => ({ dailyBudget: 0, alertThreshold: 80 }),
    getAllLlmConfigs: async () => [],
    getTokenUsageSummary: (...args: unknown[]) => {
      calls.push({ fn: 'getTokenUsageSummary', args });
      return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
    },
    getTokenUsageSummaryAsync: record('getTokenUsageSummaryAsync', {
      total_cost: 0,
      total_input: 0,
      total_output: 0,
      total_context: 0,
    }),
    getTokenUsageByAgent: record('getTokenUsageByAgent', []),
    getTokenUsageTimeline: record('getTokenUsageTimeline', []),
    getDailyTokenUsage: record('getDailyTokenUsage', []),
  },
});

const budgetRouter = (await import('../../routes/budget.js')).default;
const admin: SessionClaims = { userId: 'root', username: 'root', role: 'admin', csrf: 'test' };
const adminHarness = createRouteHarness(budgetRouter, admin);
const userHarness = createRouteHarness(budgetRouter, harnessUser({ userId: 'user-A' }));

/** The args of the first recorded call to `fn`. */
function argsOf(fn: string) {
  const call = calls.find(c => c.fn === fn);
  assert.ok(call, `expected ${fn} to have been called, got ${calls.map(c => c.fn).join(', ')}`);
  return call.args;
}

test('GET /summary forwards the project scope (even for an admin, who has no user scope)', async () => {
  calls.length = 0;
  const res = await adminHarness.get(`/summary?days=1&projectId=${PROJECT}`);
  assert.equal(res.status, 200);
  assert.deepEqual(argsOf('getTokenUsageSummaryAsync'), [1, null, PROJECT]);
});

test('GET /summary with no project still serves the cached global summary', async () => {
  calls.length = 0;
  const res = await adminHarness.get('/summary?days=1');
  assert.equal(res.status, 200);
  assert.deepEqual(argsOf('getTokenUsageSummary'), [1]);
});

test('GET /by-agent, /timeline and /daily forward the project scope alongside the user scope', async () => {
  calls.length = 0;
  assert.equal((await userHarness.get(`/by-agent?days=7&projectId=${PROJECT}`)).status, 200);
  assert.deepEqual(argsOf('getTokenUsageByAgent'), [7, 'user-A', PROJECT]);

  calls.length = 0;
  assert.equal(
    (await userHarness.get(`/timeline?days=7&groupBy=hour&projectId=${PROJECT}`)).status,
    200
  );
  assert.deepEqual(argsOf('getTokenUsageTimeline'), [7, 'hour', 'user-A', PROJECT]);

  calls.length = 0;
  assert.equal((await userHarness.get(`/daily?days=30&projectId=${PROJECT}`)).status, 200);
  assert.deepEqual(argsOf('getDailyTokenUsage'), [30, 'user-A', PROJECT]);
});

test('GET /alerts scopes both the spend figure and the breakdown to the project', async () => {
  calls.length = 0;
  const res = await adminHarness.get(`/alerts?projectId=${PROJECT}`);
  assert.equal(res.status, 200);
  assert.deepEqual(argsOf('getTokenUsageSummaryAsync'), [1, null, PROJECT]);
  assert.deepEqual(argsOf('getTokenUsageByAgent'), [1, null, PROJECT]);
});

test('an empty projectId means "All Projects", not a filter on the empty string', async () => {
  calls.length = 0;
  const res = await userHarness.get('/by-agent?days=7&projectId=');
  assert.equal(res.status, 200);
  assert.deepEqual(argsOf('getTokenUsageByAgent'), [7, 'user-A', null]);
});

test('a malformed projectId is a 400 on every read, and reaches no query', async () => {
  for (const path of [
    '/summary?projectId=not-a-uuid',
    '/by-agent?projectId=not-a-uuid',
    '/timeline?projectId=not-a-uuid',
    '/daily?projectId=not-a-uuid',
    '/alerts?projectId=not-a-uuid',
  ]) {
    calls.length = 0;
    const res = await userHarness.get(path);
    assert.equal(res.status, 400, `${path} should be rejected`);
    assert.deepEqual(await res.json(), { error: 'Invalid projectId' });
    assert.deepEqual(calls, [], `${path} must not reach the database`);
  }
});
