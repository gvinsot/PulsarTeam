import { getPool } from './connection.js';

/** Convert PostgreSQL bigint/numeric string fields to JavaScript numbers */
function parseNumericFields(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'string' && /^-?\d+(\.\d+)?$/.test(out[key])) {
      out[key] = Number(out[key]);
    }
  }
  return out;
}

// Token summary cache (refreshed periodically)
const _tokenSummaryCache = {};

export async function recordTokenUsage(agentId, agentName, provider, model, inputTokens, outputTokens, cost, userId = null, contextTokens = 0, idempotencyKey = null) {
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
        [agentId, agentName, provider, model, inputTokens, outputTokens, cost, userId, contextTokens || 0, idempotencyKey]
      );
      return true;
    }
    await pool.query(
      `INSERT INTO token_usage_log (agent_id, agent_name, provider, model, input_tokens, output_tokens, cost, user_id, context_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [agentId, agentName, provider, model, inputTokens, outputTokens, cost, userId, contextTokens || 0]
    );
    return true;
  } catch (err) {
    console.error('Failed to record token usage:', err.message);
    return false;
  }
}

export function getTokenUsageSummary(days = 1) {
  const pool = getPool();
  if (!pool) return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  return parseNumericFields(_tokenSummaryCache[days]) || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
}

/** Async per-user (or global when userId is null) token usage summary */
export async function getTokenUsageSummaryAsync(days = 1, userId = null) {
  const pool = getPool();
  if (!pool) return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  if (!userId) return parseNumericFields(_tokenSummaryCache[days]) || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(cost), 0) as total_cost,
              COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(context_tokens), 0) as total_context
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1 AND user_id = $2`,
      [days, userId]
    );
    return parseNumericFields(result.rows[0]) || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  } catch (err) {
    console.error('Failed to get token summary for user:', err.message);
    return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  }
}

export async function getTokenUsageByAgent(days = 30, userId = null) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const userFilter = userId ? ' AND user_id = $2' : '';
    const params = userId ? [days, userId] : [days];
    const result = await pool.query(
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
    console.error('Failed to get token usage by agent:', err.message);
    return [];
  }
}

export async function getTokenUsageTimeline(days = 7, groupBy = 'day', userId = null) {
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
    console.error('Failed to get token usage timeline:', err.message);
    return [];
  }
}

export async function getDailyTokenUsage(days = 30, userId = null) {
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
    console.error('Failed to get daily token usage:', err.message);
    return [];
  }
}

export async function refreshTokenSummaryCache() {
  const pool = getPool();
  if (!pool) return;
  for (const days of [1, 7, 30]) {
    try {
      const result = await pool.query(
        `SELECT COALESCE(SUM(cost), 0) as total_cost,
                COALESCE(SUM(input_tokens), 0) as total_input,
                COALESCE(SUM(output_tokens), 0) as total_output,
                COALESCE(SUM(context_tokens), 0) as total_context
         FROM token_usage_log
         WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1`,
        [days]
      );
      _tokenSummaryCache[days] = parseNumericFields(result.rows[0]) || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
    } catch (err) {
      console.error('Failed to refresh token summary cache:', err.message);
    }
  }
}
