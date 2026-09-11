// ── Scope-guarded loading state for the Budget dashboard ────────────────────
//
// Why this module exists (regression guard, see budgetScope.test.ts):
//
// BudgetDashboard used to write every fetch result straight into state:
//
//     const [s, a, t, ...] = await Promise.all([...fetch(projectId)]);
//     setSummary(s); setByAgent(a); ...
//
// Dashboard keeps the SAME component instance across a project change, and
// nothing tied a response to the scope that asked for it, so two races showed
// one project's money under another project's name:
//
//  1. Out-of-order responses. Select project A, then B before A answers. B
//     resolves, then A resolves last and its setters win — A's cost, tokens,
//     charts, table and alerts render under the "B" header.
//  2. A failing reload. After A is displayed, select B and let any promise in
//     the Promise.all reject. The catch only console.error'd and `finally` set
//     loading=false, so A's figures stayed on screen under B's name with no
//     error shown. The `loading && !summary` guard never fired because summary
//     was still A's.
//
// Neither clearing the 30s interval nor unmounting cancels an in-flight
// request, so the fix cannot live in the effect cleanup alone: every response
// has to prove it is still wanted before it is allowed to write.
//
// The rules enforced by `budgetReducer`:
//  · every load is stamped with a monotonic `generation` and the `scope`
//    (project id) it was issued for;
//  · a `start` for a NEW scope wipes the project-scoped figures immediately,
//    so stale numbers never survive a scope change even for one frame;
//  · `success` / `failure` are DROPPED unless they match both the current
//    generation and the current scope — that covers `loading` too, so a late
//    loser cannot flip the spinner off for the load still running;
//  · a failure clears nothing that belongs to the current scope but does raise
//    `error`, so a scope whose load failed renders an explicit message instead
//    of the previous project's data.
//
// Only the project-scoped reads are wiped on a scope change. `config` (budget
// settings) and `currency` (general settings) are global — keeping them avoids
// flickering the budget bar for data that cannot be wrong.

import type {
  BudgetAlertsResponse,
  BudgetByAgentRow,
  BudgetConfig,
  BudgetDailyPoint,
  BudgetSummaryResponse,
  BudgetTimelinePoint,
} from '../types';

/**
 * What BudgetDashboard reads off GET /budget/summary.
 *
 * `total_calls` is NOT a field of BudgetSummaryResponse and never arrives: no
 * SELECT in api/src/services/database/tokenUsage.ts emits one (the only
 * per-call count the API produces anywhere is `request_count`, on
 * /budget/by-agent), so the "API Calls Today" card and its "Avg/call" line
 * always render 0 and '0'. Declared optional — never removed — so the reads in
 * the component keep their current output; the fix belongs on the API side.
 */
export type BudgetSummaryView = BudgetSummaryResponse & { total_calls?: number };

/** The figures that belong to one project scope and must never outlive it. */
export interface ScopedBudgetData {
  summary: BudgetSummaryView | null;
  byAgent: BudgetByAgentRow[];
  timeline: BudgetTimelinePoint[];
  daily: BudgetDailyPoint[];
  alerts: BudgetAlertsResponse | null;
}

/** One completed load: the scoped figures plus the two global reads. */
export interface LoadedBudget extends ScopedBudgetData {
  /** Budget settings are global, not per project. */
  config: Partial<BudgetConfig> | null;
  /** From /settings/general; absent when the server sends no currency. */
  currency?: string | null;
}

export interface BudgetState {
  /** The project id the figures in `scoped` were fetched for ('' = all projects). */
  scope: string;
  /** Stamp of the only load whose result may still be applied. */
  generation: number;
  loading: boolean;
  /** Set when the load for the CURRENT scope failed; cleared on the next start. */
  error: string | null;
  scoped: ScopedBudgetData;
  config: Partial<BudgetConfig> | null;
  currency: string;
}

export type BudgetAction =
  | { type: 'start'; scope: string; generation: number }
  | { type: 'success'; scope: string; generation: number; data: LoadedBudget }
  | { type: 'failure'; scope: string; generation: number; message: string }
  /** Optimistic local write after PUT /budget/config; global, so never guarded. */
  | { type: 'config'; config: Partial<BudgetConfig> };

export const EMPTY_SCOPED: ScopedBudgetData = {
  summary: null,
  byAgent: [],
  timeline: [],
  daily: [],
  alerts: null,
};

export function initialBudgetState(scope: string): BudgetState {
  return {
    scope,
    generation: 0,
    loading: true,
    error: null,
    scoped: EMPTY_SCOPED,
    config: null,
    currency: '$',
  };
}

/**
 * True when a response can no longer be shown: either a newer load has started
 * (higher generation) or the displayed scope has moved on.
 */
export function isStale(
  state: BudgetState,
  action: { scope: string; generation: number }
): boolean {
  return action.generation !== state.generation || action.scope !== state.scope;
}

export function budgetReducer(state: BudgetState, action: BudgetAction): BudgetState {
  switch (action.type) {
    case 'start': {
      // A start is always the newest intent, so it always takes the generation.
      const scopeChanged = action.scope !== state.scope;
      return {
        ...state,
        scope: action.scope,
        generation: action.generation,
        loading: true,
        // A refresh of the SAME scope keeps its error visible until it is
        // resolved; a scope change starts from a clean slate.
        error: scopeChanged ? null : state.error,
        // The heart of the fix: the previous project's figures are gone before
        // the new request is even in flight.
        scoped: scopeChanged ? EMPTY_SCOPED : state.scoped,
      };
    }
    case 'success': {
      if (isStale(state, action)) return state;
      const { config, currency, ...scoped } = action.data;
      return {
        ...state,
        loading: false,
        error: null,
        scoped,
        config: config ?? state.config,
        currency: currency || state.currency,
      };
    }
    case 'failure': {
      if (isStale(state, action)) return state;
      return {
        ...state,
        loading: false,
        error: action.message,
        // Whatever is on screen belongs to this scope, so it is not a lie; but
        // a scope change already wiped it, which is the case that mattered.
        scoped: state.scoped,
      };
    }
    case 'config':
      return { ...state, config: action.config };
    default:
      return state;
  }
}

/** What the dashboard renders for one scope, global reads included. */
export interface BudgetView extends ScopedBudgetData {
  config: Partial<BudgetConfig> | null;
  currency: string;
  loading: boolean;
  error: string | null;
}

/**
 * Project the state onto the scope the header is CURRENTLY showing.
 *
 * `start` is dispatched from an effect, i.e. one render after `projectId`
 * changes, so for that single frame `state.scope` still names the old project
 * while the header already names the new one. This selector closes that frame:
 * a mismatch renders as "empty and loading", never as the old figures.
 */
export function selectBudgetView(state: BudgetState, scope: string): BudgetView {
  const pending = state.scope !== scope;
  return {
    ...(pending ? EMPTY_SCOPED : state.scoped),
    config: state.config,
    currency: state.currency,
    loading: pending ? true : state.loading,
    error: pending ? null : state.error,
  };
}

/** The seven reads the dashboard issues per load, injectable for tests. */
export interface BudgetFetchers {
  summary(days: number, projectId: string): Promise<BudgetSummaryView>;
  byAgent(days: number, projectId: string): Promise<BudgetByAgentRow[]>;
  timeline(
    days: number,
    groupBy: 'day' | 'hour',
    projectId: string
  ): Promise<BudgetTimelinePoint[]>;
  daily(days: number, projectId: string): Promise<BudgetDailyPoint[]>;
  config(): Promise<BudgetConfig>;
  alerts(projectId: string): Promise<BudgetAlertsResponse>;
  settings(): Promise<{ currency?: string | null } | null | undefined>;
}

/**
 * Issue one load and dispatch its outcome, stamped with `generation` and
 * `scope`. Dispatching `start` is the CALLER's job: it has to happen
 * synchronously when the scope changes, not after the first await.
 *
 * Never throws — a rejection becomes a `failure` action.
 */
export async function runBudgetLoad(
  fetchers: BudgetFetchers,
  params: { scope: string; generation: number; timeRange: number },
  dispatch: (action: BudgetAction) => void,
  toMessage: (err: unknown) => string
): Promise<void> {
  const { scope, generation, timeRange } = params;
  try {
    const [summary, byAgent, timeline, daily, config, alerts, settings] = await Promise.all([
      fetchers.summary(1, scope),
      fetchers.byAgent(timeRange, scope),
      fetchers.timeline(timeRange, timeRange <= 2 ? 'hour' : 'day', scope),
      fetchers.daily(30, scope),
      fetchers.config(),
      fetchers.alerts(scope),
      fetchers.settings(),
    ]);
    dispatch({
      type: 'success',
      scope,
      generation,
      data: { summary, byAgent, timeline, daily, alerts, config, currency: settings?.currency },
    });
  } catch (err) {
    dispatch({
      type: 'failure',
      scope,
      generation,
      message: toMessage(err) || 'Failed to load budget data',
    });
  }
}
