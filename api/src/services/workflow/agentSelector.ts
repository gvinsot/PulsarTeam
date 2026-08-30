/**
 * AgentSelector — agent lookup and load-balancing for workflow transitions.
 *
 * Extracted from the old transitionProcessor.findAgentByRole so the selection
 * logic is reusable, testable, and decoupled from execution.
 */

// Lock to prevent concurrent execution of the same task (lockKey → { ts, token })
const _executionLocks = new Map();
// Tracks which agents are currently running a transition (agentId → timestamp)
const _busyAgents = new Map();
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 min

// ── Lock management ─────────────────────────────────────────────────────────

function _evictStaleLocks() {
  const now = Date.now();
  for (const [key, entry] of _executionLocks) {
    if (now - entry.ts > LOCK_TTL_MS) {
      console.warn(
        `[AgentSelector] Evicting stale execution lock: ${key} (age: ${Math.round((now - entry.ts) / 1000)}s)`
      );
      _executionLocks.delete(key);
    }
  }
  for (const [key, ts] of _busyAgents) {
    if (now - ts > LOCK_TTL_MS) {
      console.warn(
        `[AgentSelector] Evicting stale busy-agent flag: ${key} (age: ${Math.round((now - ts) / 1000)}s)`
      );
      _busyAgents.delete(key);
    }
  }
}

/**
 * Try to acquire an execution lock for a task+mode combination.
 * Returns an owner token (truthy) if acquired, null if already held. Passing
 * the token back to releaseLock/refreshLock guarantees a stale invocation
 * cannot release or refresh a lock that was re-acquired by a successor.
 */
export function acquireLock(lockKey: string) {
  _evictStaleLocks();
  if (_executionLocks.has(lockKey)) return null;
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  _executionLocks.set(lockKey, { ts: Date.now(), token });
  return token;
}

/**
 * Release an execution lock. When a token is provided, the lock is only
 * released if it is still owned by that token.
 */
export function releaseLock(lockKey: string, token: string | null = null) {
  const entry = _executionLocks.get(lockKey);
  if (!entry) return;
  if (token && entry.token !== token) return;
  _executionLocks.delete(lockKey);
}

/**
 * Refresh an execution lock's timestamp so a live long-running action is not
 * evicted as stale. Only refreshes an existing entry (owned by `token` if given).
 */
export function refreshLock(lockKey: string, token: string | null = null) {
  const entry = _executionLocks.get(lockKey);
  if (!entry) return;
  if (token && entry.token !== token) return;
  entry.ts = Date.now();
}

/**
 * Check whether any fresh execution lock exists for keys starting with the
 * given prefix (e.g. `${agentId}:${taskId}:`) — i.e. an action is still live
 * for that task.
 */
export function hasLockForTask(lockKeyPrefix: string) {
  const now = Date.now();
  for (const [key, entry] of _executionLocks) {
    if (key.startsWith(lockKeyPrefix) && now - entry.ts <= LOCK_TTL_MS) return true;
  }
  return false;
}

/**
 * Mark an agent as busy for the duration of a transition.
 */
export function markAgentBusy(agentId: string) {
  _busyAgents.set(agentId, Date.now());
}

/**
 * Refresh the busy timestamp for an agent still mid-transition. No-op when the
 * agent has no busy flag (e.g. resume paths that never marked it busy).
 */
export function touchAgentBusy(agentId: string) {
  if (_busyAgents.has(agentId)) _busyAgents.set(agentId, Date.now());
}

/**
 * Clear the busy flag for an agent.
 */
export function clearAgentBusy(agentId: string) {
  _busyAgents.delete(agentId);
}

/**
 * Whether at least one idle, enabled agent exists (optionally matching a role).
 * Deliberately board-agnostic — like the selectors below, a board is a
 * preference, not a fence: an `idle_agent_available` condition must not go
 * green on a pool the following action would refuse to draw from.
 */
export function hasIdleAgentWithRole(agents: Map<any, any>, role?: string): boolean {
  for (const a of agents.values()) {
    if (a.status === 'idle' && a.enabled !== false && (!role || a.role === role)) return true;
  }
  return false;
}

// ── Agent selection ─────────────────────────────────────────────────────────

/**
 * Narrow `pool` to the candidates matching `predicate`, keeping the whole pool
 * when none match.
 *
 * Board and project are *preferences*, not filters: a workflow may name a role
 * whose agents live on another board (the role pickers offer every role the
 * user has an agent for), and hard-filtering there would strand the task with
 * no agent at all rather than run it slightly off-home.
 */
function _preferOrFallback(
  pool: any[],
  predicate: (a: any) => boolean,
  fallbackWarning: string
): any[] {
  const preferred = pool.filter(predicate);
  if (preferred.length > 0) return preferred;
  if (fallbackWarning) console.warn(fallbackWarning);
  return pool;
}

/**
 * Find the best available agent for a given role.
 *
 * "Available" = enabled AND idle AND not currently busy in another transition.
 * Load-balances by choosing the agent with the fewest total tasks.
 *
 * @param {Map} agents             - agentManager.agents
 * @param {string} role            - required role
 * @param {string|null} ownerId    - only consider agents owned by this user (or unowned)
 * @param {Function} getAgentTasks - (agentId) => Task[]
 * @param {string|null} boardId    - board to prefer (not a filter — see _preferOrFallback)
 * @returns {Object|null}          - the selected agent, or null
 */
export function findAgentByRole(
  agents: Map<any, any>,
  role: string,
  ownerId: string | null = null,
  getAgentTasks: (agentId: any) => any[] = () => [],
  boardId: string | null = null,
  taskProject: string | null = null
) {
  const allAgents = Array.from(agents.values()) as any[];

  // Step 1: match role + owner filter. The board is applied later as a
  // preference, so a role staffed only on another board still runs.
  const matching = allAgents.filter(
    (a: any) =>
      a.enabled !== false &&
      (a.role || '').toLowerCase() === role.toLowerCase() &&
      (!ownerId || !a.ownerId || a.ownerId === ownerId)
  );

  if (matching.length === 0) {
    console.log(`[AgentSelector] No agents with role="${role}" ownerId="${ownerId}"`);
    return null;
  }

  // Step 2: filter to idle/error + not busy in another transition.
  // We narrow to *eligible* agents BEFORE applying the project preference so
  // that an idle agent on a different repo can be picked (and later repo-
  // switched by the caller) when every same-project agent is busy. Doing the
  // project filter first would discard those idle candidates and leave the
  // task blocked waiting on a busy same-project agent.
  const eligibleAll = matching.filter((a: any) => {
    if (a.status !== 'idle' && a.status !== 'error') {
      console.log(`[AgentSelector] Skipping "${a.name}" — status: ${a.status}`);
      return false;
    }
    if (_busyAgents.has(a.id)) {
      console.log(`[AgentSelector] Skipping "${a.name}" — busy in another transition`);
      return false;
    }
    return true;
  });

  if (eligibleAll.length === 0) {
    console.log(`[AgentSelector] No idle agent for role="${role}"`);
    return null;
  }

  // Step 3: prefer the task's own board, then — inside that pool — an agent
  // already on the task's project, so we don't ship a bug about repo X to an
  // agent that lives in repo Y when a same-project candidate is available.
  // Both fall back to the wider pool: the caller's repo-switch logic
  // (executeRunAgent / _resumeActiveTask) moves the picked agent to the task's
  // repo before running.
  let eligible = eligibleAll;
  if (boardId) {
    eligible = _preferOrFallback(
      eligible,
      (a: any) => a.boardId === boardId,
      `[AgentSelector] No idle role="${role}" agent on board="${boardId}" — reusing an idle agent from another board`
    );
  }
  if (taskProject) {
    eligible = _preferOrFallback(
      eligible,
      (a: any) => a.project === taskProject,
      `[AgentSelector] No idle role="${role}" agent on project="${taskProject}" — will reuse an idle agent from another repo (it will be switched)`
    );
  }

  if (eligible.length === 1) return eligible[0];

  // Step 3: load-balance — pick the agent with the fewest assigned tasks
  let best = eligible[0];
  let bestCount = Infinity;

  for (const candidate of eligible) {
    let count = 0;
    for (const [agentId] of agents) {
      for (const t of getAgentTasks(agentId)) {
        if (t.assignee === candidate.id || (!t.assignee && agentId === candidate.id)) {
          count++;
        }
      }
    }
    if (count < bestCount) {
      bestCount = count;
      best = candidate;
    }
  }

  console.log(
    `[AgentSelector] Selected "${best.name}" (${bestCount} tasks) from ${eligible.length} eligible agents`
  );
  return best;
}

/**
 * Find the best agent for a role-based assignment (for assign_agent actions).
 * Same logic as findAgentByRole but does NOT filter on idle status (for pure assignment).
 */
export function findAgentForAssignment(
  agents: Map<any, any>,
  // Unlike findAgentByRole, this one lower-cases through `(role || '')`, so an
  // action with no role configured is a legitimate (match-nothing) call.
  role: string | undefined,
  ownerId: string | null = null,
  getAgentTasks: (agentId: any) => any[] = () => [],
  excludeTaskId: string | null = null,
  boardId: string | null = null,
  taskProject: string | null = null
) {
  const allAgents = Array.from(agents.values()) as any[];
  const candidates = allAgents.filter(
    (a: any) =>
      a.enabled !== false &&
      (a.role || '').toLowerCase() === (role || '').toLowerCase() &&
      (!ownerId || !a.ownerId || a.ownerId === ownerId)
  );

  if (candidates.length === 0) return null;

  // Same preference order as findAgentByRole: the task's board first, then the
  // task's project — each falling back to the wider pool rather than returning
  // nobody.
  let pool = candidates;
  if (boardId) {
    pool = _preferOrFallback(
      pool,
      (a: any) => a.boardId === boardId,
      `[AgentSelector] assign: no role="${role}" agent on board="${boardId}" — falling back to any board`
    );
  }
  if (taskProject) {
    pool = _preferOrFallback(
      pool,
      (a: any) => a.project === taskProject,
      `[AgentSelector] assign: no role="${role}" agent on project="${taskProject}" — falling back to any project`
    );
  }

  let best = null;
  let minTasks = Infinity;

  for (const c of pool) {
    let count = 0;
    for (const [agentId] of agents) {
      for (const t of getAgentTasks(agentId)) {
        if (t.id === excludeTaskId) continue;
        if (t.assignee === c.id || (!t.assignee && agentId === c.id)) count++;
      }
    }
    if (count < minTasks) {
      minTasks = count;
      best = c;
    }
  }

  return best;
}
