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

/**
 * The two optional narrowings every budget query supports.
 *
 * `userId` restricts to one user's rows (non-admins only see their own).
 * `projectId` restricts to the usage produced by the agents of that project:
 * token_usage_log.agent_id (TEXT) → agents.id → agents.board_id →
 * boards.project_id. Both are additive — they AND together.
 */
export interface UsageScope {
  userId?: string | null;
  projectId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SQL expression resolving the task the agent (placeholder `p`, a uuid or
 * NULL) is working on right now, used to stamp each token_usage_log row with
 * its task. Mirrors the lookup order of chat.ts _assembleMessages: the task
 * whose action this agent is running (covers delegated executions), else the
 * agent's oldest started active task (getActiveTaskForExecutor). NULL when the
 * agent is idle or chatting freely.
 */
const taskForAgentSql = (p: string) => `COALESCE(
           (SELECT t.id FROM tasks t
             WHERE t.action_running_agent_id = ${p}::uuid AND t.action_running IS TRUE
               AND t.deleted_at IS NULL AND t.is_template IS NOT TRUE
             ORDER BY t.started_at DESC NULLS LAST LIMIT 1),
           (SELECT t.id FROM tasks t
             WHERE (t.assignee = ${p}::uuid OR (t.assignee IS NULL AND t.agent_id = ${p}::uuid))
               AND t.status NOT IN ('done','backlog','error')
               AND t.started_at IS NOT NULL
               AND t.deleted_at IS NULL AND t.is_template IS NOT TRUE
             ORDER BY t.started_at ASC LIMIT 1))`;

/**
 * Build the trailing `AND ...` clauses shared by the four budget queries.
 *
 * `nextIndex` is the first free `$n` placeholder — each query binds its own
 * leading parameters (trunc unit, day window) first — and the returned params
 * must be appended to those in the same order.
 *
 * The project clause compares `agents.id::text` to `agent_id` rather than
 * casting `agent_id` to UUID: agent_id is a free-form TEXT column and a
 * non-UUID value (a deleted agent, an out-of-band runner id) would make the
 * cast throw for the whole query instead of simply not matching.
 */
function usageScopeFilter(scope: UsageScope, nextIndex: number) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope.userId) {
    params.push(scope.userId);
    clauses.push(` AND user_id = $${nextIndex + params.length - 1}`);
  }
  if (scope.projectId) {
    params.push(scope.projectId);
    clauses.push(
      ` AND agent_id IN (
           SELECT a.id::text FROM agents a
           JOIN boards b ON b.id = a.board_id
           WHERE b.project_id = $${nextIndex + params.length - 1}::uuid
         )`
    );
  }
  return { clause: clauses.join(''), params };
}

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
  // token_usage_log.agent_id is free TEXT; only a uuid can match a task column
  // (casting anything else would fail the whole insert).
  const agentUuid = UUID_RE.test(agentId) ? agentId : null;
  try {
    if (idempotencyKey) {
      // Idempotent insert: retried reports with the same key hit the partial
      // unique index and are skipped — already recorded counts as success.
      await pool.query(
        `INSERT INTO token_usage_log (agent_id, agent_name, provider, model, input_tokens, output_tokens, cost, user_id, context_tokens, idempotency_key, task_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${taskForAgentSql('$11')})
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
          agentUuid,
        ]
      );
      return true;
    }
    await pool.query(
      `INSERT INTO token_usage_log (agent_id, agent_name, provider, model, input_tokens, output_tokens, cost, user_id, context_tokens, task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${taskForAgentSql('$10')})`,
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
        agentUuid,
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

/**
 * Async token usage summary, optionally narrowed to a user and/or a project.
 * With no narrowing at all it serves the periodically refreshed cache; any
 * scope means the cached (global) totals do not apply and the query runs.
 */
export async function getTokenUsageSummaryAsync(
  days = 1,
  userId: string | null = null,
  projectId: string | null = null
): Promise<TokenSummary> {
  const pool = getPool();
  if (!pool) return emptyTokenSummary();
  if (!userId && !projectId) return _tokenSummaryCache[days] || emptyTokenSummary();
  try {
    const scope = usageScopeFilter({ userId, projectId }, 2);
    const result = await pool.query<TokenSummaryRow>(
      `SELECT COALESCE(SUM(cost), 0) as total_cost,
              COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(context_tokens), 0) as total_context
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1${scope.clause}`,
      [days, ...scope.params]
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
  userId: string | null = null,
  projectId: string | null = null
): Promise<UsageByAgentRow[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const scope = usageScopeFilter({ userId, projectId }, 2);
    const params = [days, ...scope.params];
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
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1${scope.clause}
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
  userId: string | null = null,
  projectId: string | null = null
) {
  const pool = getPool();
  if (!pool) return [];
  const trunc = groupBy === 'hour' ? 'hour' : 'day';
  try {
    const scope = usageScopeFilter({ userId, projectId }, 3);
    const params = [trunc, days, ...scope.params];
    const result = await pool.query(
      `SELECT date_trunc($1, recorded_at) as period, agent_name,
              SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
              SUM(context_tokens) as context_tokens, SUM(cost) as total_cost
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $2${scope.clause}
       GROUP BY period, agent_name ORDER BY period`,
      params
    );
    return result.rows.map(parseNumericFields);
  } catch (err) {
    console.error('Failed to get token usage timeline:', errorMessage(err));
    return [];
  }
}

export async function getDailyTokenUsage(
  days = 30,
  userId: string | null = null,
  projectId: string | null = null
) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const scope = usageScopeFilter({ userId, projectId }, 2);
    const params = [days, ...scope.params];
    const result = await pool.query(
      `SELECT date_trunc('day', recorded_at) as day,
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
              SUM(context_tokens) as total_context, SUM(cost) as total_cost
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1${scope.clause}
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

/** An execution run of a task, used to attribute legacy (untagged) usage rows. */
export interface TaskUsageWindow {
  agentName: string;
  start: string;
  end: string;
}

/** Token spend of one agent on one task (GET /tasks/:id/costs). */
export interface TaskUsageByAgentRow {
  agent_id: string;
  agent_name: string | null;
  input_tokens: number;
  output_tokens: number;
  context_tokens: number;
  cost: number;
  request_count: number;
  /** True when (some of) the rows were matched by execution window rather than
   *  by their task_id stamp — i.e. usage recorded before task attribution. */
  estimated: boolean;
}

/**
 * Token spend attributed to a task, grouped by agent.
 *
 * Rows stamped with `task_id` (see taskForAgentSql) are exact. Untagged rows —
 * everything recorded before the column existed — are attributed when the
 * same agent recorded them during one of the task's execution runs
 * (`windows`). EXISTS rather than a join so overlapping runs never count a
 * row twice.
 */
export async function getTaskTokenUsage(
  taskId: string,
  windows: TaskUsageWindow[] = []
): Promise<TaskUsageByAgentRow[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT agent_id,
              MAX(agent_name)                      AS agent_name,
              COALESCE(SUM(input_tokens), 0)       AS input_tokens,
              COALESCE(SUM(output_tokens), 0)      AS output_tokens,
              COALESCE(SUM(context_tokens), 0)     AS context_tokens,
              COALESCE(SUM(cost), 0)               AS cost,
              COUNT(*)                             AS request_count,
              BOOL_OR(task_id IS NULL)             AS estimated
       FROM token_usage_log u
       WHERE u.task_id = $1::uuid
          OR (u.task_id IS NULL AND EXISTS (
                SELECT 1 FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[]) AS w(name, s, e)
                 WHERE u.agent_name = w.name AND u.recorded_at BETWEEN w.s AND w.e))
       GROUP BY agent_id
       ORDER BY cost DESC`,
      [taskId, windows.map(w => w.agentName), windows.map(w => w.start), windows.map(w => w.end)]
    );
    return result.rows.map(row => ({
      ...parseNumericFields(row),
      agent_name: row.agent_name ?? null,
      cost: Number(row.cost) || 0,
      estimated: !!row.estimated,
    })) as TaskUsageByAgentRow[];
  } catch (err) {
    console.error('Failed to get task token usage:', errorMessage(err));
    return [];
  }
}
