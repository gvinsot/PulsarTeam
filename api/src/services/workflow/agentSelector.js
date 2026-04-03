/**
 * AgentSelector — agent lookup and load-balancing for workflow transitions.
 *
 * Extracted from the old transitionProcessor.findAgentByRole so the selection
 * logic is reusable, testable, and decoupled from execution.
 */

// Lock to prevent concurrent execution of the same task (lockKey → timestamp)
const _executionLocks = new Map();
// Tracks which agents are currently running a transition (agentId → timestamp)
const _busyAgents = new Map();
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 min

// ── Lock management ─────────────────────────────────────────────────────────

function _evictStaleLocks() {
  const now = Date.now();
  for (const [key, ts] of _executionLocks) {
    if (now - ts > LOCK_TTL_MS) {
      console.warn(`[AgentSelector] Evicting stale execution lock: ${key} (age: ${Math.round((now - ts) / 1000)}s)`);
      _executionLocks.delete(key);
    }
  }
  for (const [key, ts] of _busyAgents) {
    if (now - ts > LOCK_TTL_MS) {
      console.warn(`[AgentSelector] Evicting stale busy-agent flag: ${key} (age: ${Math.round((now - ts) / 1000)}s)`);
      _busyAgents.delete(key);
    }
  }
}

/**
 * Try to acquire an execution lock for a task+mode combination.
 * Returns true if acquired, false if already held.
 */
export function acquireLock(lockKey) {
  _evictStaleLocks();
  if (_executionLocks.has(lockKey)) return false;
  _executionLocks.set(lockKey, Date.now());
  return true;
}

/**
 * Release an execution lock.
 */
export function releaseLock(lockKey) {
  _executionLocks.delete(lockKey);
}

/**
 * Mark an agent as busy for the duration of a transition.
 */
export function markAgentBusy(agentId) {
  _busyAgents.set(agentId, Date.now());
}

/**
 * Clear the busy flag for an agent.
 */
export function clearAgentBusy(agentId) {
  _busyAgents.delete(agentId);
}

/**
 * Check if an agent is currently busy in a transition.
 */
export function isAgentBusy(agentId) {
  _evictStaleLocks();
  return _busyAgents.has(agentId);
}

// ── Agent selection ─────────────────────────────────────────────────────────

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
 * @returns {Object|null}          - the selected agent, or null
 */
export function findAgentByRole(agents, role, ownerId = null, getAgentTasks = () => []) {
  const allAgents = Array.from(agents.values());

  // Step 1: match role + owner filter
  const matching = allAgents.filter(
    a =>
      a.enabled !== false &&
      (a.role || '').toLowerCase() === role.toLowerCase() &&
      (!ownerId || !a.ownerId || a.ownerId === ownerId)
  );

  if (matching.length === 0) {
    console.log(`[AgentSelector] No agents with role="${role}" ownerId="${ownerId}"`);
    return null;
  }

  // Step 2: filter to idle + not busy in another transition
  const eligible = matching.filter(a => {
    if (a.status !== 'idle') {
      console.log(`[AgentSelector] Skipping "${a.name}" — status: ${a.status}`);
      return false;
    }
    if (_busyAgents.has(a.id)) {
      console.log(`[AgentSelector] Skipping "${a.name}" — busy in another transition`);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    console.log(`[AgentSelector] No idle agent for role="${role}"`);
    return null;
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

  console.log(`[AgentSelector] Selected "${best.name}" (${bestCount} tasks) from ${eligible.length} eligible agents`);
  return best;
}

/**
 * Find the best agent for a role-based assignment (for assign_agent actions).
 * Same logic as findAgentByRole but does NOT filter on idle status (for pure assignment).
 */
export function findAgentForAssignment(agents, role, ownerId = null, getAgentTasks = () => [], excludeTaskId = null) {
  const allAgents = Array.from(agents.values());
  const candidates = allAgents.filter(
    a =>
      a.enabled !== false &&
      (a.role || '').toLowerCase() === (role || '').toLowerCase() &&
      (!ownerId || !a.ownerId || a.ownerId === ownerId)
  );

  if (candidates.length === 0) return null;

  let best = null;
  let minTasks = Infinity;

  for (const c of candidates) {
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
