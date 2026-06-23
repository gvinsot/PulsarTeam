/**
 * TaskStateMachine — single source of truth for task state transitions.
 *
 * Responsibilities:
 *  - Validate whether a transition is allowed (guards)
 *  - Look up the configured actions for a column's on_enter / condition triggers
 *  - Provide a clear, declarative API consumed by the rest of the codebase
 *
 * This module is **pure logic** — it never performs I/O, never talks to agents,
 * and never touches the database.  Side-effects are handled by ActionExecutor.
 */

// ── Reserved / built-in statuses ────────────────────────────────────────────
const INACTIVE_STATUSES = new Set(['done', 'backlog', 'error']);

// ── Trigger types ───────────────────────────────────────────────────────────
export const Trigger = Object.freeze({
  ON_ENTER: 'on_enter',
  CONDITION: 'condition',
});

// ── Action types ────────────────────────────────────────────────────────────
export const ActionType = Object.freeze({
  RUN_AGENT: 'run_agent',
  CHANGE_STATUS: 'change_status',
  ASSIGN_AGENT: 'assign_agent',
  ASSIGN_AGENT_INDIVIDUAL: 'assign_agent_individual',
});

// ── Agent action modes ──────────────────────────────────────────────────────
export const AgentMode = Object.freeze({
  REFINE: 'refine',
  EXECUTE: 'execute',
  DECIDE: 'decide',
  TITLE: 'title',
  SET_TYPE: 'set_type',
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a status is considered "active" (i.e. not terminal, not backlog, not error).
 */
export function isActiveStatus(status) {
  return !INACTIVE_STATUSES.has(status);
}

/**
 * Validate that a column exists in the workflow.
 */
export function columnExists(workflow, columnId) {
  if (!workflow?.columns || !Array.isArray(workflow.columns)) return false;
  return workflow.columns.some(c => c.id === columnId);
}

/**
 * Validate a transition object from the workflow config.
 */
export function isValidTransition(transition) {
  return (
    transition &&
    typeof transition.from === 'string' &&
    typeof transition.trigger === 'string' &&
    Array.isArray(transition.actions)
  );
}

/**
 * Evaluate a single condition against a task + agents context.
 *
 * @param {Object} cond        - { field, operator, value }
 * @param {Object} task        - the task being evaluated
 * @param {Function} getAgent  - (agentId) => agent  — to resolve assignee info
 * @returns {boolean}
 */
export function evaluateCondition(cond, task, getAgent) {
  const assigneeAgent = task.assignee ? getAgent(task.assignee) : null;
  let fieldValue;

  switch (cond.field) {
    case 'creator_status':
    case 'owner_status':
      fieldValue = assigneeAgent?.status || 'none';
      break;
    case 'creator_enabled':
    case 'owner_enabled':
      fieldValue = assigneeAgent ? (assigneeAgent.enabled !== false ? 'true' : 'false') : 'false';
      break;
    case 'assignee_status':
      fieldValue = assigneeAgent?.status || 'none';
      break;
    case 'assignee_enabled':
      fieldValue = assigneeAgent ? (assigneeAgent.enabled !== false ? 'true' : 'false') : 'false';
      break;
    case 'assignee_role':
      fieldValue = assigneeAgent?.role || '';
      break;
    case 'task_has_assignee':
      fieldValue = task.assignee ? 'true' : 'false';
      break;
    // Note: 'idle_agent_available' is handled upstream in evaluateAllConditions
    // (it needs the agent list) and never reaches this switch via that path.
    default:
      fieldValue = '';
  }

  return cond.operator === 'neq'
    ? fieldValue !== cond.value
    : fieldValue === cond.value;
}

/**
 * Evaluate all conditions for a transition.
 *
 * @param {Array} conditions   - array of condition objects
 * @param {Object} task        - the task being evaluated
 * @param {Function} getAgent  - (agentId) => agent
 * @param {Function} hasIdleAgentWithRole - (role) => boolean (for idle_agent_available)
 * @returns {boolean}
 */
export function evaluateAllConditions(conditions, task, getAgent, hasIdleAgentWithRole) {
  if (!conditions || conditions.length === 0) return true;

  return conditions.every(cond => {
    if (cond.field === 'idle_agent_available') {
      const found = hasIdleAgentWithRole(cond.value);
      return cond.operator === 'neq' ? !found : found;
    }
    return evaluateCondition(cond, task, getAgent);
  });
}

/**
 * Get all transitions (on_enter + condition) for a given status.
 */
export function getMatchingTransitions(workflow, status) {
  if (!workflow?.transitions) return [];
  return workflow.transitions
    .filter(isValidTransition)
    .filter(t => t.from === status);
}

/**
 * Determine the set of "workflow-managed" statuses — columns that have
 * at least one run_agent action or conditional transition.  Used by the
 * task loop to avoid double-processing.
 */
export function getWorkflowManagedStatuses(allBoardWorkflows) {
  const managed = new Set();
  for (const { workflow } of allBoardWorkflows) {
    for (const t of workflow.transitions) {
      if (!isValidTransition(t)) continue;
      const hasAgentAction = (t.actions || []).some(a => a.type === ActionType.RUN_AGENT);
      const isConditional = t.trigger === Trigger.CONDITION && (t.conditions || []).length > 0;
      if (hasAgentAction || isConditional) {
        managed.add(t.from);
      }
    }
  }
  return managed;
}

// Action types that (re)assign the task's assignee when a column is entered.
const ASSIGNING_ACTIONS = new Set([
  ActionType.RUN_AGENT,
  ActionType.ASSIGN_AGENT,
  ActionType.ASSIGN_AGENT_INDIVIDUAL,
]);

/**
 * Determine the set of statuses (columns) whose ENTRY will (re)assign the
 * task's assignee — either via an on_enter/condition action that sets it
 * (run_agent / assign_agent / assign_agent_individual) or via the column's
 * autoAssignRole (which only fires for non-first/last columns; see
 * _autoAssignByColumn).
 *
 * Consumed by setTaskStatus to decide whether to clear the assignee on entry:
 * clearing is correct ONLY when the destination column is going to replace it.
 * Clearing unconditionally wiped the record of which agent took the task — that
 * was invisible while the assignee equalled the task owner (e.g. a batch's
 * member #1) but, for any other member, left the board showing nobody had
 * picked the task up.
 */
export function getReassigningStatuses(allBoardWorkflows) {
  const reassigning = new Set();
  for (const { workflow } of allBoardWorkflows) {
    for (const t of (workflow.transitions || [])) {
      if (!isValidTransition(t)) continue;
      if ((t.actions || []).some(a => ASSIGNING_ACTIONS.has(a.type))) {
        reassigning.add(t.from);
      }
    }
    const cols = workflow.columns || [];
    cols.forEach((col, idx) => {
      const isFirstOrLast = idx === 0 || idx === cols.length - 1;
      if (col?.autoAssignRole && !isFirstOrLast) reassigning.add(col.id);
    });
  }
  return reassigning;
}
