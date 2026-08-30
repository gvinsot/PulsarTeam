// ── Budget and token consumption ────────────────────────────────────────────
//
// Two facts settle every "is this a string or a number?" question in this file:
//
//  1. node-postgres returns bigint (SUM of INTEGER, COUNT, COUNT DISTINCT) as a
//     JS STRING, but every budget DAO pipes its rows through parseNumericFields
//     (api/src/services/database/tokenUsage.ts:5-14) before res.json. And `cost`
//     is REAL, not NUMERIC, so sum(real) is float4 which node-postgres parses to
//     a number natively. No pg.types.setTypeParser call exists anywhere in
//     api/src. Conclusion: declare `number`, never `number | string`.
//  2. parseNumericFields does NOT add COALESCE, so nullability survives it — and
//     only the /summary query has COALESCE. The three GROUPED queries do not,
//     which is why their SUM columns are nullable here and the summary's are not.
//
// Cross-domain note: the /agents/tasks/stats/agent-time payload is NOT a budget
// shape (it reports milliseconds from task history and never reads
// token_usage_log). It lives in project.ts as AgentTimeSeries.

/** Only two levels are ever pushed: 'critical' at >= 100% and 'warning' at
 *  >= alertThreshold. The API's own local annotation is a looser
 *  `{ level: string }`, but the consumer branches on === 'critical'. */
export type BudgetAlertLevel = 'critical' | 'warning';

/**
 * /budget/timeline accepts groupBy as a FREE string and narrows it with
 * `groupBy === 'hour' ? 'hour' : 'day'`, so any other value is accepted with a
 * 200 and silently returns daily buckets. Request-side type only.
 */
export type BudgetTimelineGroupBy = 'day' | 'hour';

/**
 * The budget settings object: returned by GET /budget/config, embedded in
 * /budget/summary, and the accepted PUT /budget/config body.
 * Produced by api/src/routes/budget.ts:111.
 *
 * The index signature is required, not lazy: the PUT zod schema is
 * `.passthrough()`, so any extra key sent is persisted verbatim and comes back on
 * GET — and BudgetDashboard re-sends whatever it received. A closed two-field
 * object would be a lie about the wire.
 *
 * Beware the divergent defaults when budget_config is absent from the settings
 * cache: /budget/summary falls back to dailyBudget 0, while /budget/config and
 * /budget/alerts fall back to 10.0.
 */
export interface BudgetConfig {
  [key: string]: unknown;
  /** z.coerce.number().min(0).default(0) on write. A value written outside this
   *  route is NOT schema-checked — the route only null-checks it with `||`. */
  dailyBudget: number;
  /** Percentage, z.coerce.number().min(0).max(100).default(80). */
  alertThreshold: number;
}

/**
 * GET /budget/summary — today's (or N-day) token totals plus the embedded budget
 * configuration. Produced by api/src/routes/budget.ts:75.
 *
 * This is the ONE query with COALESCE(...,0) on every aggregate, so nothing here
 * is nullable. There is NO `total_calls` field: no SELECT in tokenUsage.ts emits
 * one (the only COUNT(*) is request_count, on /by-agent), which is why the
 * dashboard's "API Calls Today" card always shows 0.
 */
export interface BudgetSummaryResponse {
  /** REAL/float4 sum → a JS number natively. */
  total_cost: number;
  /** bigint → string from pg, converted back to a number by parseNumericFields
   *  before res.json. */
  total_input: number;
  total_output: number;
  total_context: number;
  /** Always present. Note its dailyBudget default differs from /budget/config's. */
  budgetConfig: BudgetConfig;
}

/**
 * One row of GET /budget/by-agent, and of BudgetAlertsResponse.byAgent: totals
 * grouped by (provider, model).
 * Produced by api/src/services/database/tokenUsage.ts:187.
 *
 * SAME SHAPE, TWO MEANINGS: /budget/by-agent runs the rows through
 * enrichProviderNames, replacing the raw provider type with the LLM-config
 * DISPLAY NAME, while /budget/alerts returns them un-enriched ('vllm' vs
 * 'My Local Model').
 */
export interface BudgetByAgentRow {
  /** GROUP BY key on a nullable TEXT column, so a NULL group is possible.
   *  CAVEAT: parseNumericFields coerces ANY all-digit string to a number, so a
   *  provider literally named '4' arrives as the number 4. Typed `string | null`
   *  because that case is pathological and harmless at every render site; see the
   *  module report if it ever bites. */
  provider: string | null;
  /** Same nullability and same all-digit caveat as provider. Writers always send
   *  a non-empty string, so NULL only comes from legacy rows. */
  model: string | null;
  /** COUNT(DISTINCT agent_id) — never null. */
  agent_count: number;
  /** SUM without COALESCE (unlike /summary) → NULL when every row in the group has
   *  a NULL input_tokens. Non-null in practice, nullable by schema. */
  total_input: number | null;
  total_output: number | null;
  total_context: number | null;
  /** SUM(cost) with no COALESCE → nullable. This is the one the dashboard divides
   *  by request_count WITHOUT a guard. */
  total_cost: number | null;
  /** COUNT(*) — never null. The only per-call count the API produces anywhere. */
  request_count: number;
}

/**
 * One row of GET /budget/timeline: totals per (time bucket, agent name).
 * Produced by api/src/services/database/tokenUsage.ts:212.
 *
 * `groupBy` does NOT change this shape — the SELECT list is identical for both
 * values; only the truncation unit of `period` changes.
 */
export interface BudgetTimelinePoint {
  /** date_trunc() over a TIMESTAMPTZ → a JS Date → a FULL ISO 8601 string
   *  ('2026-08-29T00:00:00.000Z'), NOT 'YYYY-MM-DD'. Non-nullable: rows with a
   *  NULL recorded_at are excluded by the WHERE clause. */
  period: string;
  /** Nullable GROUP BY key; same all-digit coercion caveat as
   *  BudgetByAgentRow.provider. */
  agent_name: string | null;
  /** Note the key names differ from /by-agent and /daily: input_tokens here,
   *  total_input there. SUM without COALESCE → nullable. */
  input_tokens: number | null;
  output_tokens: number | null;
  context_tokens: number | null;
  total_cost: number | null;
}

/**
 * One row of GET /budget/daily.
 * Produced by api/src/services/database/tokenUsage.ts:234.
 */
export interface BudgetDailyPoint {
  /** Same date_trunc caveat as BudgetTimelinePoint.period: a full ISO timestamp,
   *  not a date-only string — which is why `d.day?.slice(5)` renders
   *  '08-29T00:00:00.000Z' instead of '08-29'. Non-nullable. */
  day: string;
  total_input: number | null;
  total_output: number | null;
  total_context: number | null;
  total_cost: number | null;
}

/**
 * A single budget-threshold alert. Produced by api/src/routes/budget.ts:142.
 */
export interface BudgetAlert {
  level: BudgetAlertLevel;
  /** Pre-formatted, dollar-signed and localised server-side; the frontend renders
   *  it raw and applies its own currency symbol elsewhere. */
  message: string;
}

/**
 * GET /budget/alerts — threshold alerts plus today's spend and the
 * per-(provider, model) breakdown. Produced by api/src/routes/budget.ts:153.
 */
export interface BudgetAlertsResponse {
  /** Always an array, empty when dailyBudget is 0 or spend is under threshold. */
  alerts: BudgetAlert[];
  /** `todaySummary?.total_cost || 0`. */
  todayCost: number;
  /** Copied from the stored budget_config; guaranteed numeric only for configs
   *  written through PUT. */
  dailyBudget: number;
  /** Over a 1-day window, and NOT enriched — see BudgetByAgentRow. */
  byAgent: BudgetByAgentRow[];
}

/** PUT /budget/config success body. Produced by api/src/routes/budget.ts:127. */
export interface BudgetConfigUpdateResponse {
  success: true;
}

/** One zod issue in a 400 validation body. */
export interface BudgetConfigErrorDetail {
  /** The dotted zod path, or the literal '<root>'. */
  path: string;
  message: string;
  code: string;
}

/**
 * Non-2xx bodies of PUT /budget/config, surfaced by the api client as
 * `new Error(data.error)` with a `.status` property.
 * Produced by api/src/lib/validate.ts:20 and the two auth middlewares.
 *
 * Worth knowing: the ⚙️ Settings button and the edit modal are rendered for every
 * authenticated user, but the route is gated by requireRole('admin'), so a
 * non-admin fills the form and gets the 403 below.
 */
export interface BudgetConfigErrorResponse {
  error:
    | 'Validation failed'
    | 'Insufficient permissions'
    | 'Authentication required'
    | 'Failed to persist budget config';
  /** Present only on the 400 validation body. */
  details?: BudgetConfigErrorDetail[];
}
