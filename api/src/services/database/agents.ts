import { getPool } from './connection.js';
import { errorMessage } from '../../lib/errors.js';

/**
 * What persistence needs off an agent. The object is stored whole in the
 * `data` JSONB column and these three fields are mirrored into indexed
 * columns; `saveAgent` accepts this narrow shape so a caller can persist a
 * partially-built agent without satisfying the whole record.
 */
type PersistableAgent = {
  id: string;
  ownerId?: string | null;
  boardId?: string | null;
};

/**
 * The canonical agent record — what `agentManager.agents` holds and what every
 * consumer of an agent reads.
 *
 * Unlike `TaskRow`/`Task`, there is no column-by-column mapping to derive from:
 * an agent is stored WHOLE in the `agents.data` JSONB column, so this declares
 * the fields the codebase actually reads rather than a schema. The index
 * signature carries the rest — reading an undeclared field yields `unknown`
 * instead of silently `any`, so it has to be narrowed at the point of use. Add
 * a field here when you need it typed.
 */
export interface Agent {
  id: string;
  name: string;
  role?: string;
  status?: string;
  enabled?: boolean;
  ownerId?: string | null;
  boardId?: string | null;
  /** Repo the agent is currently working in ("owner/repo"), null when none. */
  project: string | null;
  runner?: string | null;
  permissions?: unknown;
  llmConfigId?: string | null;
  contextLength?: number;
  conversationHistory?: unknown[];
  // Per-agent LLM overrides, used when the agent names no llmConfigId (or as
  // the ceiling when it does) — see AgentManager.resolveLlmConfig.
  maxTokens?: number;
  isReasoning?: boolean;
  temperature?: number | null;
  costPerInputToken?: number | null;
  costPerOutputToken?: number | null;
  /** Realtime voice name (OpenAI realtime sessions) — see routes/realtime.ts. */
  voice?: string | null;
  /** Per-agent TTS voice override — see routes/externalVoice.ts. */
  ttsVoiceId?: string | null;
  [key: string]: unknown;
}

/**
 * An `agents` row as the queries below select it: the whole agent object in
 * `data`, plus the indexed `board_id` column when the query asks for it.
 */
interface AgentRow {
  data: Agent;
  board_id?: string | null;
  owner_id?: string | null;
}

/**
 * Convert an `agents` row to the in-memory agent object.
 *
 * `board_id` and `owner_id` are MIRRORS, not separate facts: `saveAgent` writes
 * each column and its JSONB copy from the same object, in the same statement.
 * So they diverge in exactly two ways, and the `??` chain answers both:
 *
 *   1. The row predates the columns (migrations.ts, 202601010003 added owner_id
 *      and board_id). The column is NULL and the JSONB copy is the only record
 *      of the owner, so a NULL column must NOT win — letting it win would
 *      orphan every agent created before that migration.
 *   2. Something wrote the column alone. `owner_id` is
 *      `REFERENCES users(id) ON DELETE SET NULL` (baseSchema.ts), so deleting a
 *      user NULLs it while the JSONB keeps the now-dangling id; a hand-written
 *      `UPDATE agents SET owner_id = …` does the reverse. A non-NULL column is
 *      the more recent value AND the one the foreign key vouches for, so it
 *      wins over the JSONB copy.
 *
 * That leaves one case the chain cannot decide on its own: a NULL column next
 * to a JSONB id pointing at a deleted user is byte-for-byte a case-1 legacy
 * row. The difference simply is not in this table, so it is not guessed here —
 * whoever needs it resolves the id against `users` (routes/agents.ts
 * GET /orphans, which is what the `ownerExists` flag reports).
 *
 * Every SELECT feeding this must name the columns, or the fixup silently reads
 * `undefined` and the JSONB copy always wins.
 */
export function rowToAgent(row: AgentRow): Agent {
  const agent = row.data;
  agent.boardId = row.board_id ?? agent.boardId ?? null;
  agent.ownerId = row.owner_id ?? agent.ownerId ?? null;
  return agent;
}

export async function getAllAgents(): Promise<Agent[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query<AgentRow>(
      'SELECT data, board_id, owner_id FROM agents ORDER BY created_at'
    );
    return result.rows.map(rowToAgent);
  } catch (err) {
    console.error('Failed to load agents:', errorMessage(err));
    return [];
  }
}

export async function getAgentById(id: string): Promise<Agent | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query<AgentRow>(
      'SELECT data, board_id, owner_id FROM agents WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return rowToAgent(row);
  } catch (err) {
    console.error('Failed to load agent:', errorMessage(err));
    return null;
  }
}

export async function saveAgent(agent: PersistableAgent) {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO agents (id, data, owner_id, board_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, owner_id = $3, board_id = $4, updated_at = NOW()`,
      [agent.id, JSON.stringify(agent), agent.ownerId || null, agent.boardId || null]
    );
  } catch (err) {
    console.error('Failed to save agent:', errorMessage(err));
  }
}

export async function deleteAgentFromDb(id: string) {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query('DELETE FROM agents WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete agent:', errorMessage(err));
  }
}

// ── Agent board_id helpers ─────────────────────────────────────────────────

export async function getAgentsByBoard(boardId: string): Promise<Agent[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    // Selects the mirrored columns and goes through rowToAgent like every other
    // listing. It used to select `data` alone, on the stated grounds that no
    // caller read ownerId — which was wrong: userProvisioning.ts:31 compares
    // `agent.ownerId` to decide whether a user already has a developer agent.
    // Reading that off the JSONB alone resurrects a deleted owner (the FK's
    // ON DELETE SET NULL clears the column but not the blob), so provisioning
    // would skip a user who no longer owns anything.
    const result = await pool.query<AgentRow>(
      'SELECT data, owner_id, board_id FROM agents WHERE board_id = $1 ORDER BY created_at',
      [boardId]
    );
    return result.rows.map(rowToAgent);
  } catch (err) {
    console.error('Failed to get agents by board:', errorMessage(err));
    return [];
  }
}
