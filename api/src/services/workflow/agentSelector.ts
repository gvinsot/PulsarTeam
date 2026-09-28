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

// Workflow actions and manual/automatic resumes share these reservations.
// A CLI can report idle while its task is still running. Live promises retain
// their reservation through cleanup; elapsed time alone must never free them.
const _agentRuns = new Map<string, { taskId: string; lockKey: string }>();
const _taskRuns = new Set<string>();

export function isAgentBusy(agentId: string): boolean {
  return _agentRuns.has(agentId) || _busyAgents.has(agentId);
}

/** The live task reservation, used to avoid interrupting a stale assignee. */
export function getAgentRunningTaskId(agentId: string): string | null {
  return _agentRuns.get(agentId)?.taskId || null;
}

export function isTaskRunning(taskId: string): boolean {
  return _taskRuns.has(taskId);
}

/** Synchronous check-and-reserve, before workspace preparation or prompt injection. */
export function reserveAgentForTask(agentId: string, taskId: string, lockKey: string) {
  if (isAgentBusy(agentId) || isTaskRunning(taskId)) return null;
  const token = acquireLock(lockKey);
  if (!token) return null;
  const run = { taskId, lockKey };
  _agentRuns.set(agentId, run);
  _taskRuns.add(taskId);
  console.log(`[AgentSelector] Reserved agent="${agentId}" task="${taskId}" lock="${lockKey}"`);
  return () => {
    if (_agentRuns.get(agentId) !== run) return;
    _agentRuns.delete(agentId);
    _taskRuns.delete(taskId);
    releaseLock(lockKey, token);
    console.log(`[AgentSelector] Released agent="${agentId}" task="${taskId}"`);
  };
}

// ── Lock management ─────────────────────────────────────────────────────────

function _evictStaleLocks() {
  const now = Date.now();
  for (const [key, entry] of _executionLocks) {
    if ([..._agentRuns.values()].some(run => run.lockKey === key)) continue;
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
  for (const run of _agentRuns.values()) {
    if (run.lockKey.startsWith(lockKeyPrefix)) return true;
  }
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
 * Whether an agent may work a task of `boardId`. The board is a fence: a task
 * is never handed to another board's agent, even one with the right role.
 * A task with no board (legacy/agent-level) is not restricted.
 */
export function isOnTaskBoard(agent: any, boardId: string | null | undefined): boolean {
  return !boardId || agent.boardId === boardId;
}

/**
 * Whether at least one idle, enabled agent exists (optionally matching a role)
 * on the task's board. Scoped like the selectors below, so an
 * `idle_agent_available` condition never goes green on an agent the following
 * action would refuse to draw from.
 */
export function hasIdleAgentWithRole(
  agents: Map<any, any>,
  role?: string,
  boardId: string | null = null
): boolean {
  for (const a of agents.values()) {
    if (
      a.status === 'idle' &&
      a.enabled !== false &&
      !isAgentBusy(a.id) &&
      (!role || (a.role || '').toLowerCase() === role.toLowerCase()) &&
      isOnTaskBoard(a, boardId)
    )
      return true;
  }
  return false;
}

// ── Agent selection ─────────────────────────────────────────────────────────

/**
 * Narrow `pool` to the candidates matching `predicate`, keeping the whole pool
 * when none match. Used for the project preference only — the board is a hard
 * filter (see isOnTaskBoard).
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
 * @param {string|null} boardId    - the task's board; only its agents are eligible
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

  // Step 1: match role + owner + board. The board is a fence: another board's
  // agent never picks up this task, even with the right role.
  const matching = allAgents.filter(
    (a: any) =>
      a.enabled !== false &&
      (a.role || '').toLowerCase() === role.toLowerCase() &&
      (!ownerId || !a.ownerId || a.ownerId === ownerId) &&
      isOnTaskBoard(a, boardId)
  );

  if (matching.length === 0) {
    console.log(
      `[AgentSelector] No agents with role="${role}" ownerId="${ownerId}" board="${boardId}"`
    );
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
    if (isAgentBusy(a.id)) {
      console.log(`[AgentSelector] Skipping "${a.name}" — busy in another transition`);
      return false;
    }
    return true;
  });

  if (eligibleAll.length === 0) {
    console.log(`[AgentSelector] No idle agent for role="${role}"`);
    return null;
  }

  // Step 3: prefer an agent already on the task's project, so we don't ship a
  // bug about repo X to an agent that lives in repo Y when a same-project
  // candidate is available. Falls back to the wider (same-board) pool: the
  // caller's repo-switch logic (executeRunAgent / _resumeActiveTask) moves the
  // picked agent to the task's repo before running.
  let eligible = eligibleAll;
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
 * Only available agents may receive automatic assignments, including while a
 * CLI reports idle during an active workflow or resume.
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
      (a.status === 'idle' || a.status === 'error') &&
      !isAgentBusy(a.id) &&
      (a.role || '').toLowerCase() === (role || '').toLowerCase() &&
      (!ownerId || !a.ownerId || a.ownerId === ownerId) &&
      isOnTaskBoard(a, boardId)
  );

  if (candidates.length === 0) return null;

  // Same rule as findAgentByRole: only the task's board, preferring the task's
  // project and falling back to the rest of the board.
  let pool = candidates;
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
