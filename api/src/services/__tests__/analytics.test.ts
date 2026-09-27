// ── Analytics view: queries, error grouping and budget limits ───────────────
//
// The Analytics view (formerly "Budget") adds board usage, the task mix and an
// error analysis on top of spend, plus monthly and per-project budget limits.
// Locked in here:
//
//   • the analytics DAO scopes every query by the caller's boards and the
//     selected project, with placeholders numbered after the day window;
//   • error messages are normalised so repeats of one failure group together;
//   • the budget limit evaluation (daily + rolling 30-day, per project).
//
// Only the pg pool is faked; the SQL was additionally exercised against a real
// Postgres (PGlite) while developing.

import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const PROJECT = '11111111-2222-3333-4444-555555555555';
const BOARD = '66666666-7777-8888-9999-000000000000';

const queries: { text: string; params: unknown[] }[] = [];

const realConnection = await import('../database/connection.js');
mock.module('../database/connection.js', {
  namedExports: {
    ...realConnection,
    getPool: () => ({
      query: async (text: string, params: unknown[] = []) => {
        queries.push({ text: text.replace(/\s+/g, ' '), params });
        return { rows: [], rowCount: 0 };
      },
    }),
  },
});

const analytics = await import('../database/analytics.js');
const budget = await import('../../routes/budget.js');

beforeEach(() => {
  queries.length = 0;
});

/* ── Scope filter ─────────────────────────────────────────────────────────── */

test('analyticsScopeFilter numbers board then project placeholders after nextIndex', () => {
  const f = analytics.analyticsScopeFilter({ boardIds: [BOARD], projectId: PROJECT }, 2);
  assert.match(f.clause, /AND b\.id = ANY\(\$2::uuid\[\]\)/);
  assert.match(f.clause, /AND b\.project_id = \$3::uuid/);
  assert.deepEqual(f.params, [[BOARD], PROJECT]);
});

test('an admin scope (boardIds null) adds no board restriction', () => {
  const f = analytics.analyticsScopeFilter({ boardIds: null, projectId: null }, 2);
  assert.equal(f.clause, '');
  assert.deepEqual(f.params, []);
});

test('an empty board list still restricts (matches nothing) instead of widening', () => {
  const f = analytics.analyticsScopeFilter({ boardIds: [] }, 2);
  assert.match(f.clause, /ANY\(\$2::uuid\[\]\)/);
  assert.deepEqual(f.params, [[]]);
});

test('every analytics query binds the window first, then the scope', async () => {
  const scope = { boardIds: [BOARD], projectId: PROJECT };
  await analytics.getBoardUsageStats(7, scope);
  await analytics.getTaskActivityTimeline(7, scope);
  await analytics.getTaskMixStats(7, scope);
  await analytics.getErrorStats(7, scope);
  // board usage 1 + activity 1 + task mix 6 + errors 6
  assert.equal(queries.length, 14);
  for (const q of queries) {
    assert.deepEqual(q.params, [7, [BOARD], PROJECT], q.text);
    assert.match(q.text, /b\.project_id = \$3::uuid/);
    // Deleted tasks and recurring templates are never counted.
    if (/FROM tasks t/.test(q.text)) assert.match(q.text, /t\.deleted_at IS NULL/);
  }
});

test('error events come from history entries moving INTO the error column', async () => {
  await analytics.getErrorStats(30, {});
  const eventQuery = queries.find(q => /jsonb_array_elements/.test(q.text));
  assert.ok(eventQuery);
  assert.match(eventQuery.text, /h->>'status' = 'error'/);
});

/* ── Error message grouping ───────────────────────────────────────────────── */

test('normalizeErrorMessage masks ids, numbers and quoted values', () => {
  const a = analytics.normalizeErrorMessage(
    'Timeout after 3000ms for task 0f8fad5b-d9cb-469f-a165-70867728950e "build"'
  );
  const b = analytics.normalizeErrorMessage(
    'Timeout after 45ms for task 7c9e6679-7425-40de-944b-e07fc1f90ae7 "deploy"'
  );
  assert.equal(a, b);
  assert.equal(a, 'Timeout after <n>ms for task <id> <value>');
});

test('normalizeErrorMessage keeps only the first line and handles empties', () => {
  assert.equal(analytics.normalizeErrorMessage('Boom\n  at stack'), 'Boom');
  assert.equal(analytics.normalizeErrorMessage(null), '(no message)');
  assert.equal(analytics.normalizeErrorMessage(''), '(no message)');
});

/* ── Budget limits ────────────────────────────────────────────────────────── */

test('normalizeBudgetConfig upgrades a legacy config with no monthly / project limits', () => {
  const cfg = budget.normalizeBudgetConfig({ dailyBudget: 5, alertThreshold: 70 });
  assert.deepEqual(cfg, {
    dailyBudget: 5,
    monthlyBudget: 0,
    alertThreshold: 70,
    projectBudgets: {},
  });
});

test('normalizeBudgetConfig drops malformed values rather than trusting them', () => {
  const cfg = budget.normalizeBudgetConfig({
    dailyBudget: 'lots',
    monthlyBudget: -1,
    alertThreshold: 80,
    projectBudgets: { [PROJECT]: { dailyBudget: 2, monthlyBudget: 'x' }, other: null },
  });
  assert.equal(cfg.dailyBudget, 10);
  assert.equal(cfg.monthlyBudget, 0);
  assert.deepEqual(cfg.projectBudgets, { [PROJECT]: { dailyBudget: 2, monthlyBudget: 0 } });
});

test('evaluateLimits raises warning and critical alerts per period', () => {
  const alerts = budget.evaluateLimits(
    { dailyBudget: 10, monthlyBudget: 100 },
    { daily: 12, monthly: 85 },
    80
  );
  assert.deepEqual(
    alerts.map(a => [a.period, a.level]),
    [
      ['daily', 'critical'],
      ['monthly', 'warning'],
    ]
  );
  assert.match(alerts[0].message, /^Daily budget exceeded/);
  assert.match(alerts[1].message, /^Approaching 30-day budget/);
});

test('evaluateLimits ignores unset (0) limits and labels project alerts', () => {
  assert.deepEqual(
    budget.evaluateLimits({ dailyBudget: 0, monthlyBudget: 0 }, { daily: 99, monthly: 99 }, 80),
    []
  );
  const [alert] = budget.evaluateLimits(
    { dailyBudget: 0, monthlyBudget: 50 },
    { daily: 0, monthly: 60 },
    80,
    '[Acme] ',
    PROJECT
  );
  assert.equal(alert.projectId, PROJECT);
  assert.match(alert.message, /^\[Acme\] 30-day budget exceeded/);
});

test('getCostByProject windows the spend and optionally narrows to one user', async () => {
  await analytics.getCostByProject(30, 'user-A');
  const q = queries[queries.length - 1];
  assert.match(q.text, /GROUP BY b\.project_id/);
  assert.match(q.text, /AND u\.user_id = \$2/);
  assert.deepEqual(q.params, [30, 'user-A']);
});
