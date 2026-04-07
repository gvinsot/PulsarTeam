// ─── Workflow: _evaluateCondition, agentHasActiveTask, _checkAutoRefine,
//     _validTransition, _recheckConditionalTransitions ─────────────────────────
//
// Refactored: delegates to the new workflow/ module for all transition logic.
// This file now contains thin wrappers that call into WorkflowEngine.
//
import { saveAgent, saveTaskToDb } from '../database.js';
import {
  processColumnEntry,
  recheckPendingTransitions,
  isValidTransition,
  isActiveStatus,
  evaluateCondition as _evalCond,
  columnExists,
} from '../workflow/index.js';

/** @this {import('./index.js').AgentManager} */
export const workflowMethods = {

  /**
   * Evaluate a single workflow condition.
   * Delegates to the pure-logic evaluator in TaskStateMachine.
   */
  _evaluateCondition(cond, task) {
    // Special case: idle_agent_available needs access to agent list
    if (cond.field === 'idle_agent_available') {
      const role = cond.value;
      const found = [...this.agents.values()].some(a =>
        a.status === 'idle' && a.enabled !== false && (!role || a.role === role)
      );
      const result = cond.operator === 'neq' ? !found : found;
      if (result) console.log(`[Workflow] Condition: idle_agent_available role="${role}" => true`);
      return result;
    }
    return _evalCond(cond, task, (agentId) => this.agents.get(agentId));
  },

  agentHasActiveTask(agentId, excludeTaskId = null) {
    for (const [creatorId] of this.agents) {
      const tasks = this._getAgentTasks(creatorId);
      for (const task of tasks) {
        if (!isActiveStatus(task.status)) continue;
        if (excludeTaskId && task.id === excludeTaskId) continue;
        if (creatorId === agentId) return true;
        if (task.assignee === agentId) return true;
      }
    }
    return false;
  },

  _validTransition(t) {
    return isValidTransition(t);
  },

  _columnExists(workflow, columnId) {
    return columnExists(workflow, columnId);
  },

  /**
   * Main entry point when a task enters a column.
   * Delegates to WorkflowEngine.processColumnEntry.
   */
  _checkAutoRefine(task, { by = null } = {}) {
    console.log(`[Workflow] _checkAutoRefine: status="${task.status}" task="${task.id}" "${(task.title || task.text || '').slice(0, 60)}" by="${by || 'unknown'}"`);

    if (task.status === 'error') {
      console.log(`[Workflow] _checkAutoRefine: skipping — error status`);
      return;
    }

    // Fire-and-forget: processColumnEntry is async
    processColumnEntry(task, this, { by })
      .catch(err => console.error(`[Workflow] processColumnEntry failed:`, err.message));
  },

  /**
   * Periodic recheck of conditional transitions and on_enter retries.
   * Delegates to WorkflowEngine.recheckPendingTransitions.
   */
  _recheckConditionalTransitions() {
    recheckPendingTransitions(this)
      .catch(err => console.error(`[Workflow] recheckPendingTransitions failed:`, err.message));
  },
};