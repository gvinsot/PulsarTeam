// Regression guard: the Budget dashboard must never show one project's money
// under another project's name.
//
// The bug (BudgetDashboard.tsx, before budgetScope.ts existed): `loadData`
// awaited a Promise.all of seven reads and then called setSummary/setByAgent/…
// unconditionally. Dashboard keeps the SAME component instance across a project
// change, and no response carried the scope it was fetched for, so:
//
//   · select A, select B before A answers, let B resolve then A → A's figures
//     overwrote B's under the "B" header;
//   · select B after A was displayed and let any of the seven reads reject →
//     the catch only console.error'd, `finally` set loading=false, and A's
//     figures stayed on screen under B with no error at all (the
//     `loading && !summary` guard could not fire — summary was still A's).
//
// Clearing the 30s interval does not abort an in-flight request, so these tests
// drive the real `runBudgetLoad` + `budgetReducer` with DEFERRED fetchers and
// resolve them out of order, exactly as the browser can.
//
// Run with `npm test` from frontend/.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  budgetReducer,
  initialBudgetState,
  runBudgetLoad,
  selectBudgetView,
  EMPTY_SCOPED,
  type BudgetAction,
  type BudgetFetchers,
  type BudgetState,
  type LoadedBudget,
} from '../budgetScope.ts';
import type { BudgetConfig } from '../../types';

const ALL_PROJECTS = '';
const A = 'project-a';
const B = 'project-b';

/** A distinguishable payload for one scope: every scoped surface is filled. */
function payload(scope: string, cost: number): LoadedBudget {
  return {
    summary: {
      total_cost: cost,
      total_input: cost * 10,
      total_output: cost * 20,
      total_context: cost * 30,
      budgetConfig: { dailyBudget: 10, alertThreshold: 80 },
    },
    // table + "Active Agents" card + doughnut
    byAgent: [
      {
        provider: scope,
        model: `model-${scope}`,
        agent_count: 1,
        total_input: cost * 10,
        total_output: cost * 20,
        total_context: cost * 30,
        total_cost: cost,
        request_count: 3,
      },
    ],
    // "Token Usage per Agent" line chart
    timeline: [
      {
        period: '2026-09-11T00:00:00.000Z',
        agent_name: `agent-${scope}`,
        input_tokens: cost * 10,
        output_tokens: cost * 20,
        context_tokens: cost * 30,
        total_cost: cost,
      },
    ],
    // daily cost trend + token breakdown charts
    daily: [
      {
        day: '2026-09-11T00:00:00.000Z',
        total_input: cost * 10,
        total_output: cost * 20,
        total_context: cost * 30,
        total_cost: cost,
      },
    ],
    // alert banners
    alerts: {
      alerts: [{ level: 'critical', message: `${scope} over budget` }],
      todayCost: cost,
      dailyBudget: 10,
      byAgent: [],
    },
    config: { dailyBudget: 10, alertThreshold: 80 },
    currency: '€',
  };
}

interface Deferred {
  /** Resolve every one of the seven reads with this scope's payload. */
  resolve(): void;
  /** Reject exactly ONE read of the Promise.all, like a single failing route. */
  rejectOne(message: string): void;
  fetchers: BudgetFetchers;
}

/** Fetchers that answer nothing until the test says so. */
function deferredFetchers(data: LoadedBudget): Deferred {
  let settle!: (value: LoadedBudget) => void;
  const gate = new Promise<LoadedBudget>(res => {
    settle = res;
  });
  // Only `byAgent` reads this second gate: rejecting it mimics one route of the
  // Promise.all failing while the other six succeed.
  let failOne!: (err: unknown) => void;
  const oneGate = new Promise<never>((_res, rej) => {
    failOne = rej;
  });
  // Nothing awaits oneGate unless byAgent is called, so keep Node quiet.
  oneGate.catch(() => {});

  return {
    resolve: () => settle(data),
    rejectOne: message => {
      failOne(new Error(message));
      // The six healthy reads still answer.
      settle(data);
    },
    fetchers: {
      summary: () => gate.then(d => d.summary!),
      byAgent: () => Promise.race([gate.then(d => d.byAgent), oneGate]),
      timeline: () => gate.then(d => d.timeline),
      daily: () => gate.then(d => d.daily),
      config: () => gate.then(d => d.config as BudgetConfig),
      alerts: () => gate.then(d => d.alerts!),
      settings: () => gate.then(d => ({ currency: d.currency })),
    },
  };
}

/** Stands in for the component: one reducer, one monotonic generation ref. */
class Harness {
  state: BudgetState;
  private generation = 0;
  private dispatch = (action: BudgetAction) => {
    this.state = budgetReducer(this.state, action);
  };

  constructor(scope = ALL_PROJECTS) {
    this.state = initialBudgetState(scope);
  }

  /** Exactly what BudgetDashboard's `loadData` does, minus React. */
  load(scope: string, data: LoadedBudget, timeRange = 7) {
    const generation = ++this.generation;
    this.dispatch({ type: 'start', scope, generation });
    const gate = deferredFetchers(data);
    const done = runBudgetLoad(
      gate.fetchers,
      { scope, generation, timeRange },
      this.dispatch,
      err => (err instanceof Error ? err.message : String(err))
    );
    return { ...gate, done };
  }

  /** What the header currently showing `scope` would render. */
  view(scope: string) {
    return selectBudgetView(this.state, scope);
  }
}

/** Let every already-settled promise chain run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// ── 1. Out-of-order responses ───────────────────────────────────────────────

test('A answering after B never overwrites B (the reported race)', async () => {
  const h = new Harness(A);
  const loadA = h.load(A, payload(A, 111));
  // The user switches to B while A is still in flight.
  const loadB = h.load(B, payload(B, 222));

  loadB.resolve();
  await loadB.done;
  loadA.resolve();
  await loadA.done;
  await flush();

  const view = h.view(B);
  assert.equal(view.summary?.total_cost, 222, "B's cost must survive A's late answer");
  assert.equal(view.byAgent[0]?.provider, B);
  assert.equal(view.timeline[0]?.agent_name, `agent-${B}`);
  assert.equal(view.daily[0]?.total_cost, 222);
  assert.equal(view.alerts?.alerts[0]?.message, `${B} over budget`);
  assert.equal(view.loading, false);
  assert.equal(view.error, null);
});

test('a stale load cannot flip `loading` off for the load still running', async () => {
  const h = new Harness(A);
  const loadA = h.load(A, payload(A, 111));
  const loadB = h.load(B, payload(B, 222));

  // A loses the race and answers first; B is still pending.
  loadA.resolve();
  await loadA.done;
  await flush();

  assert.equal(h.view(B).loading, true, 'B is still loading');
  assert.equal(h.view(B).summary, null, "A's summary must not leak in");

  loadB.resolve();
  await loadB.done;
  assert.equal(h.view(B).loading, false);
  assert.equal(h.view(B).summary?.total_cost, 222);
});

test('a stale FAILURE cannot raise an error on the new scope', async () => {
  const h = new Harness(A);
  const loadA = h.load(A, payload(A, 111));
  const loadB = h.load(B, payload(B, 222));

  loadA.rejectOne('A blew up');
  await loadA.done;
  loadB.resolve();
  await loadB.done;
  await flush();

  const view = h.view(B);
  assert.equal(view.error, null, "A's failure belongs to A, not to B");
  assert.equal(view.summary?.total_cost, 222);
  assert.equal(view.loading, false);
});

// ── 2. The new scope's load fails ───────────────────────────────────────────

test("B failing after A was displayed shows an error, not A's figures", async () => {
  const h = new Harness(A);
  const loadA = h.load(A, payload(A, 111));
  loadA.resolve();
  await loadA.done;
  assert.equal(h.view(A).summary?.total_cost, 111);

  const loadB = h.load(B, payload(B, 222));
  loadB.rejectOne('by-agent 500');
  await loadB.done;
  await flush();

  const view = h.view(B);
  assert.equal(view.summary, null, "A's cards must be gone");
  assert.deepEqual(view.byAgent, [], "A's table must be gone");
  assert.deepEqual(view.timeline, [], "A's per-agent chart must be gone");
  assert.deepEqual(view.daily, [], "A's trend charts must be gone");
  assert.equal(view.alerts, null, "A's alert banners must be gone");
  assert.equal(view.loading, false);
  assert.equal(view.error, 'by-agent 500', 'the failure must be explicit');
});

test('a failed refresh of the SAME scope keeps that scopedata and warns', async () => {
  const h = new Harness(A);
  const first = h.load(A, payload(A, 111));
  first.resolve();
  await first.done;

  // The 30s interval fires and this one fails.
  const refresh = h.load(A, payload(A, 999));
  refresh.rejectOne('network down');
  await refresh.done;
  await flush();

  const view = h.view(A);
  assert.equal(view.summary?.total_cost, 111, 'still A, so still truthful');
  assert.equal(view.error, 'network down');
  assert.equal(view.loading, false);
});

// ── 3. All Projects → a project ─────────────────────────────────────────────

test('switching All Projects → a project wipes the global figures at once', async () => {
  const h = new Harness(ALL_PROJECTS);
  const all = h.load(ALL_PROJECTS, payload('all', 500));
  all.resolve();
  await all.done;
  assert.equal(h.view(ALL_PROJECTS).summary?.total_cost, 500);

  // The moment the scope changes, before any response arrives:
  const scoped = h.load(A, payload(A, 111));
  const mid = h.view(A);
  // No global figure may survive the switch, not even for one frame.
  assert.equal(mid.summary, null);
  assert.deepEqual(mid.byAgent, EMPTY_SCOPED.byAgent);
  assert.deepEqual(mid.timeline, EMPTY_SCOPED.timeline);
  assert.deepEqual(mid.daily, EMPTY_SCOPED.daily);
  assert.equal(mid.alerts, null);
  assert.equal(mid.loading, true);

  scoped.resolve();
  await scoped.done;
  assert.equal(h.view(A).summary?.total_cost, 111);
});

test('a project → All Projects switch is guarded the same way', async () => {
  const h = new Harness(A);
  const a = h.load(A, payload(A, 111));
  a.resolve();
  await a.done;

  const all = h.load(ALL_PROJECTS, payload('all', 500));
  assert.equal(h.view(ALL_PROJECTS).summary, null);
  all.resolve();
  await all.done;
  assert.equal(h.view(ALL_PROJECTS).summary?.total_cost, 500);
});

// ── 4. The render frame before the effect runs ──────────────────────────────

test('the frame between a projectId change and the load start renders empty', async () => {
  const h = new Harness(A);
  const a = h.load(A, payload(A, 111));
  a.resolve();
  await a.done;

  // React has re-rendered with projectId=B but the effect has not fired yet, so
  // state.scope is still A. selectBudgetView must not hand A's data to B.
  const view = h.view(B);
  assert.equal(view.summary, null);
  assert.deepEqual(view.byAgent, []);
  assert.equal(view.alerts, null);
  assert.equal(view.loading, true);
  assert.equal(view.error, null);
  // …while A's own state is untouched underneath.
  assert.equal(h.state.scoped.summary?.total_cost, 111);
});

// ── 5. Global reads are not scoped ──────────────────────────────────────────

test('currency and budget config survive a scope change', async () => {
  const h = new Harness(A);
  const a = h.load(A, payload(A, 111));
  a.resolve();
  await a.done;
  assert.equal(h.view(A).currency, '€');

  h.load(B, payload(B, 222));
  const mid = h.view(B);
  assert.equal(mid.currency, '€', 'currency is a global setting, not per project');
  assert.deepEqual(mid.config, { dailyBudget: 10, alertThreshold: 80 });
});

test('a config save is applied without a generation guard', () => {
  let state = initialBudgetState(A);
  state = budgetReducer(state, { type: 'config', config: { dailyBudget: 42 } });
  assert.deepEqual(state.config, { dailyBudget: 42 });
});

// ── 6. Reducer-level invariants ─────────────────────────────────────────────

test('a success stamped with an old generation is dropped outright', () => {
  const first = initialBudgetState(A);
  const started = budgetReducer(first, { type: 'start', scope: A, generation: 1 });
  const superseded = budgetReducer(started, { type: 'start', scope: A, generation: 2 });
  const late = budgetReducer(superseded, {
    type: 'success',
    scope: A,
    generation: 1,
    data: payload(A, 111),
  });
  assert.equal(late, superseded, 'same object: nothing was written');
});

test('a success for the right generation but the wrong scope is dropped', () => {
  let state = initialBudgetState(A);
  state = budgetReducer(state, { type: 'start', scope: B, generation: 1 });
  const late = budgetReducer(state, {
    type: 'success',
    scope: A,
    generation: 1,
    data: payload(A, 111),
  });
  assert.equal(late, state);
});

test('a same-scope refresh keeps the figures visible while it runs', () => {
  let state = initialBudgetState(A);
  state = budgetReducer(state, { type: 'start', scope: A, generation: 1 });
  state = budgetReducer(state, {
    type: 'success',
    scope: A,
    generation: 1,
    data: payload(A, 111),
  });
  state = budgetReducer(state, { type: 'start', scope: A, generation: 2 });
  // Same scope: nothing is wiped, so the dashboard does not blink to "Loading".
  assert.equal(state.scoped.summary?.total_cost, 111);
  assert.equal(state.loading, true);
});
