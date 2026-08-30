import { getPool } from './connection.js';
import { errorMessage } from '../../lib/errors.js';

/**
 * Convert PostgreSQL bigint/numeric string fields to JavaScript numbers.
 *
 * `SUM()`/`COUNT()` over an INTEGER column widens to BIGINT, which the driver
 * hands back as a lossless string; the aggregate rows below mix those with
 * plain text columns (provider, agent_name, …), so what is numeric is only
 * knowable per query.
 *
 * Declared shape-preserving because that is what it does: the key set is
 * untouched and only values are coerced, so the row type a caller states —
 * e.g. `UsageByAgentRow`, whose counters are `number` precisely because this
 * pass ran — survives the call. TypeScript cannot say "same keys, the
 * string-valued ones narrowed to number", so the signature is split from a
 * looser implementation rather than typed `Record<string, unknown>` in and
 * out, which would erase every field name at the call site.
 */
function parseNumericFields<T extends Record<string, unknown>>(row: T): T;
function parseNumericFields(row: Record<string, unknown>) {
  if (!row) return row;
  const out: Record<string, unknown> = { ...row };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = Number(value);
    }
  }
  return out;
}

/** The budget summary the /budget routes read, with every aggregate numeric. */
export interface TokenSummary {
  total_cost: number;
  total_input: number;
  total_output: number;
  total_context: number;
}

/**
 * The same four aggregates as the driver delivers them: `SUM()` over the
 * INTEGER token columns widens to BIGINT, which pg keeps as a lossless string,
 * while `SUM()` over the REAL `cost` column widens to float8, which pg parses
 * to a number.
 */
type TokenSummaryRow = {
  total_cost: number;
  total_input: string;
  total_output: string;
  total_context: string;
};

/** A zeroed summary — what every no-pool / no-row path returns. */
function emptyTokenSummary(): TokenSummary {
  return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
}

/**
 * The typed counterpart of parseNumericFields for the summary queries: those
 * select exactly the four COALESCE(SUM(...)) columns above, so each one is a
 * plain decimal literal and Number() reproduces what the generic pass did.
 */
function toTokenSummary(row: TokenSummaryRow | undefined): TokenSummary {
  if (!row) return emptyTokenSummary();
  return {
    total_cost: Number(row.total_cost),
    total_input: Number(row.total_input),
    total_output: Number(row.total_output),
    total_context: Number(row.total_context),
  };
}

// Token summary cache (refreshed periodically), keyed by the day window.
const _tokenSummaryCache: Record<number, TokenSummary | undefined> = {};

// agent_name / provider / model are nullable columns, but both call sites
// (agentManager._recordUsage and the internal token-usage route) resolve them
// to a string with an 'unknown' fallback before getting here.
export async function recordTokenUsage(
  agentId: string,
  agentName: string,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  userId: string | null = null,
  contextTokens = 0,
  idempotencyKey: string | null = null
) {
  const pool = getPool();
  if (!pool) return false;
  try {
    if (idempotencyKey) {
      // Idempotent insert: retried reports with the same key hit the partial
      // unique index and are skipped — already recorded counts as success.
      await pool.query(
        `INSERT INTO token_usage_log (agent_id, agent_name, provider, model, input_tokens, output_tokens, cost, user_id, context_tokens, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          agentId,
          agentName,
          provider,
          model,
          inputTokens,
          outputTokens,
          cost,
          userId,
          contextTokens || 0,
          idempotencyKey,
        ]
      );
      return true;
    }
    await pool.query(
      `INSERT INTO token_usage_log (agent_id, agent_name, provider, model, input_tokens, output_tokens, cost, user_id, context_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        agentId,
        agentName,
        provider,
        model,
        inputTokens,
        outputTokens,
        cost,
        userId,
        contextTokens || 0,
      ]
    );
    return true;
  } catch (err) {
    console.error('Failed to record token usage:', errorMessage(err));
    return false;
  }
}

/**
 * All-time token totals grouped by agent_id. Returns a Map keyed by agent id
 * with `{ input, output }` sums from token_usage_log — the same source of
 * truth the budget dashboard reads. Used to surface an agent's lifetime token
 * consumption on the agents view, including CLI runners that report usage
 * out-of-band (via the internal token-usage endpoint) rather than inline on
 * the chat stream.
 */
export async function getTotalTokensByAgentId(): Promise<
  Map<string, { input: number; output: number }>
> {
  const pool = getPool();
  const out = new Map<string, { input: number; output: number }>();
  if (!pool) return out;
  try {
    const result = await pool.query(
      `SELECT agent_id,
              COALESCE(SUM(input_tokens), 0)  AS input,
              COALESCE(SUM(output_tokens), 0) AS output
       FROM token_usage_log
       WHERE agent_id IS NOT NULL
       GROUP BY agent_id`
    );
    for (const row of result.rows) {
      out.set(row.agent_id, { input: Number(row.input) || 0, output: Number(row.output) || 0 });
    }
  } catch (err) {
    console.error('Failed to get total tokens by agent:', errorMessage(err));
  }
  return out;
}

/** All-time token totals for a single agent from token_usage_log. */
export async function getTotalTokensForAgent(
  agentId: string
): Promise<{ input: number; output: number }> {
  const pool = getPool();
  if (!pool || !agentId) return { input: 0, output: 0 };
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(input_tokens), 0)  AS input,
              COALESCE(SUM(output_tokens), 0) AS output
       FROM token_usage_log
       WHERE agent_id = $1`,
      [agentId]
    );
    const row = result.rows[0] || {};
    return { input: Number(row.input) || 0, output: Number(row.output) || 0 };
  } catch (err) {
    console.error('Failed to get total tokens for agent:', errorMessage(err));
    return { input: 0, output: 0 };
  }
}

export function getTokenUsageSummary(days = 1): TokenSummary {
  const pool = getPool();
  if (!pool) return emptyTokenSummary();
  // The cache already holds converted rows (refreshTokenSummaryCache runs each
  // through toTokenSummary), so this is a lookup with a zeroed fallback.
  return _tokenSummaryCache[days] || emptyTokenSummary();
}

/** Async per-user (or global when userId is null) token usage summary */
export async function getTokenUsageSummaryAsync(
  days = 1,
  userId: string | null = null
): Promise<TokenSummary> {
  const pool = getPool();
  if (!pool) return emptyTokenSummary();
  if (!userId) return _tokenSummaryCache[days] || emptyTokenSummary();
  try {
    const result = await pool.query<TokenSummaryRow>(
      `SELECT COALESCE(SUM(cost), 0) as total_cost,
              COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(context_tokens), 0) as total_context
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1 AND user_id = $2`,
      [days, userId]
    );
    return toTokenSummary(result.rows[0]);
  } catch (err) {
    console.error('Failed to get token summary for user:', errorMessage(err));
    return emptyTokenSummary();
  }
}

/**
 * One row of the provider/model rollup, after parseNumericFields. `SUM()`
 * yields NULL for a group whose values are all NULL, which the nullable
 * token/cost columns still allow, so the aggregates stay nullable.
 */
export type UsageByAgentRow = {
  provider: string | null;
  model: string | null;
  agent_count: number;
  total_input: number | null;
  total_output: number | null;
  total_context: number | null;
  total_cost: number | null;
  request_count: number;
};

export async function getTokenUsageByAgent(
  days = 30,
  userId: string | null = null
): Promise<UsageByAgentRow[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const userFilter = userId ? ' AND user_id = $2' : '';
    const params = userId ? [days, userId] : [days];
    // The generic names the row as it leaves this function, i.e. after the
    // parseNumericFields pass below turns the BIGINT counters from lossless
    // strings into numbers. Naming it here is what keeps the field names —
    // budget.ts reads `provider`/`model` off these rows.
    const result = await pool.query<UsageByAgentRow>(
      `SELECT provider, model,
              COUNT(DISTINCT agent_id) as agent_count,
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
              SUM(context_tokens) as total_context, SUM(cost) as total_cost,
              COUNT(*) as request_count
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1${userFilter}
       GROUP BY provider, model
       ORDER BY total_cost DESC`,
      params
    );
    return result.rows.map(parseNumericFields);
  } catch (err) {
    console.error('Failed to get token usage by agent:', errorMessage(err));
    return [];
  }
}

export async function getTokenUsageTimeline(
  days = 7,
  groupBy = 'day',
  userId: string | null = null
) {
  const pool = getPool();
  if (!pool) return [];
  const trunc = groupBy === 'hour' ? 'hour' : 'day';
  try {
    const userFilter = userId ? ' AND user_id = $3' : '';
    const params = userId ? [trunc, days, userId] : [trunc, days];
    const result = await pool.query(
      `SELECT date_trunc($1, recorded_at) as period, agent_name,
              SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
              SUM(context_tokens) as context_tokens, SUM(cost) as total_cost
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $2${userFilter}
       GROUP BY period, agent_name ORDER BY period`,
      params
    );
    return result.rows.map(parseNumericFields);
  } catch (err) {
    console.error('Failed to get token usage timeline:', errorMessage(err));
    return [];
  }
}

export async function getDailyTokenUsage(days = 30, userId: string | null = null) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const userFilter = userId ? ' AND user_id = $2' : '';
    const params = userId ? [days, userId] : [days];
    const result = await pool.query(
      `SELECT date_trunc('day', recorded_at) as day,
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
              SUM(context_tokens) as total_context, SUM(cost) as total_cost
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1${userFilter}
       GROUP BY day ORDER BY day`,
      params
    );
    return result.rows.map(parseNumericFields);
  } catch (err) {
    console.error('Failed to get daily token usage:', errorMessage(err));
    return [];
  }
}

export async function refreshTokenSummaryCache() {
  const pool = getPool();
  if (!pool) return;
  for (const days of [1, 7, 30]) {
    try {
      const result = await pool.query<TokenSummaryRow>(
        `SELECT COALESCE(SUM(cost), 0) as total_cost,
                COALESCE(SUM(input_tokens), 0) as total_input,
                COALESCE(SUM(output_tokens), 0) as total_output,
                COALESCE(SUM(context_tokens), 0) as total_context
         FROM token_usage_log
         WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1`,
        [days]
      );
      _tokenSummaryCache[days] = toTokenSummary(result.rows[0]);
    } catch (err) {
      console.error('Failed to refresh token summary cache:', errorMessage(err));
    }
  }
}
