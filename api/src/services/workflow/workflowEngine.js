/**
 * WorkflowEngine — central orchestrator for task workflow transitions.
 *
 * Replaces the scattered logic that was duplicated between _checkAutoRefine
 * and _recheckConditionalTransitions in the old workflow.js.
 *
 * Flow:
 *   1. Task enters a column (via setTaskStatus or addTask)
 *   2. WorkflowEngine.processColumnEntry() is called
 *   3. The engine loads the workflow config for the task's board
 *   4. It finds matching transitions (on_enter / condition)
 *   5. It executes each action in the transition's action chain sequentially
 *   6. If an action is skipped (no agent), the task is flagged for retry
 *
 * The engine also provides recheckPendingTransitions() which is called
 * periodically by the task loop to retry pending transitions and evaluate
 * conditional triggers.
 */

import { getWorkflowForBoard, getAllBoardWorkflows } from '../configManager.js';
import { saveTaskToDb } from '../database.js';
import { executeAction } from './actionExecutor.js';
import {
  isValidTransition,
  evaluateAllConditions,
  getMatchingTransitions,
  columnExists,
  Trigger,
} from './taskStateMachine.js';
import { findAgentForAssignment } from './agentSelector.js';

// ── Cooldown for on_enter retries ───────────────────────────────────────────
const ON_ENTER_RETRY_COOLDOWN_MS = 3_000;
const ON_ENTER_MAX_RETRIES = 20;

/**
 * Process all transitions triggered when a task enters a column.
 *
 * This is the single entry point called by setTaskStatus and addTask.
 * It replaces the old _checkAutoRefine method.
 *
 * @param {Object} task          - { id, agentId, boardId, status, text, ... }
 * @param {Object} agentManager  - the AgentManager instance
 * @param {Object} [options]     - { by: string }
 */
export async function processColumnEntry(task, agentManager, { by = null } = {}) {
  const io = agentManager.io;

  console.log(`[WorkflowEngine] processColumnEntry: status="${task.status}" task="${task.id}" "${(task.title || task.text || '').slice(0, 60)}" by="${by || 'unknown'}"`);

  if (task.status === 'error') {
    console.log(`[WorkflowEngine] Skipping — task is in error status`);
    return;
  }

  let workflow;
  try {
    workflow = await getWorkflowForBoard(task.boardId);
  } catch (err) {
    console.error(`[WorkflowEngine] Failed to load workflow:`, err.message);
    return;
  }

  const ownerId = workflow.userId || agentManager.agents.get(task.agentId)?.ownerId || null;

  // Auto-assign by column role
  _autoAssignByColumn(task, workflow, agentManager, ownerId, io);

  // Find matching transitions for this column
  const transitions = getMatchingTransitions(workflow, task.status);
  if (transitions.length === 0) {
    console.log(`[WorkflowEngine] No transitions for status="${task.status}" task="${task.id}"`);
    return;
  }

  const originalStatus = task.status;

  for (const transition of transitions) {
    // If a previous action changed the status, stop processing
    if (task.status !== originalStatus) {
      console.log(`[WorkflowEngine] Task "${task.id}" moved from "${originalStatus}" to "${task.status}" — stopping`);
      break;
    }

    // Skip jira triggers (handled elsewhere)
    if (transition.trigger === Trigger.JIRA_TICKET) continue;

    // Evaluate conditions for conditional triggers
    if (transition.trigger === Trigger.CONDITION) {
      const allMet = evaluateAllConditions(
        transition.conditions || [],
        task,
        (agentId) => agentManager.agents.get(agentId),
        (role) => [...agentManager.agents.values()].some(
          a => a.status === 'idle' && a.enabled !== false && (!role || a.role === role)
        )
      );
      if (!allMet) {
        console.log(`[WorkflowEngine] Conditions not met for transition from="${transition.from}"`);
        continue;
      }
    }

    // Execute action chain
    const actions = transition.actions || [];
    console.log(`[WorkflowEngine] Transition matched: from="${transition.from}" trigger="${transition.trigger}" (${actions.length} actions) task="${task.id}"`);

    await _executeActionChain(actions, task, {
      agentManager,
      io,
      ownerId,
      workflow,
      originalStatus,
    });
  }
}

/**
 * Recheck all pending conditional transitions and on_enter retries.
 *
 * Called periodically by the task loop. Replaces _recheckConditionalTransitions.
 *
 * @param {Object} agentManager
 */
export async function recheckPendingTransitions(agentManager) {
  const io = agentManager.io;
  const LOCK_TTL_MS = 2 * 60 * 1000;

  // Evict stale condition processing locks
  if (agentManager._conditionProcessing) {
    const now = Date.now();
    for (const [key, timestamp] of agentManager._conditionProcessing) {
      if (now - timestamp > LOCK_TTL_MS) {
        console.warn(`[WorkflowEngine] Evicting stale condition lock: ${key}`);
        agentManager._conditionProcessing.delete(key);
      }
    }
  }

  let boardWorkflows;
  try {
    boardWorkflows = await getAllBoardWorkflows();
  } catch (err) {
    console.error(`[WorkflowEngine] Failed to load board workflows:`, err.message);
    return;
  }

  // Build a map of board → transitions that are condition-based or on_enter
  const boardTransMap = new Map();
  const boardWorkflowMap = new Map();

  for (const { boardId, workflow } of boardWorkflows) {
    const relevant = workflow.transitions
      .filter(isValidTransition)
      .filter(t => {
        if (t.trigger === Trigger.CONDITION && (t.conditions || []).length > 0) return true;
        if (t.trigger === Trigger.ON_ENTER) return true;
        return false;
      });
    if (relevant.length > 0) {
      boardTransMap.set(boardId, relevant);
      boardWorkflowMap.set(boardId, workflow);
    }
  }

  if (boardTransMap.size === 0) return;

  // Iterate all tasks across all agents
  for (const [agentId, agent] of agentManager.agents) {
    const agentTasks = agentManager._getAgentTasks(agentId);

    for (const task of agentTasks) {
      if (task.status === 'error') continue;

      const transitions = boardTransMap.get(task.boardId)
        || (boardTransMap.size === 1 ? [...boardTransMap.values()][0] : []);
      const matching = transitions.filter(t => t.from === task.status);
      if (matching.length === 0) continue;

      // Skip if assignee is busy (unless this is a pending on_enter retry)
      if (task.assignee && !task._pendingOnEnter) {
        const assigneeAgent = agentManager.agents.get(task.assignee);
        if (assigneeAgent && assigneeAgent.status === 'busy') continue;
      }

      for (const transition of matching) {
        // on_enter retries: only process if flagged as pending
        if (transition.trigger === Trigger.ON_ENTER && task._pendingOnEnter !== task.status) continue;

        // Evaluate conditions
        const allMet = evaluateAllConditions(
          transition.conditions || [],
          { ...task, agentId },
          (id) => agentManager.agents.get(id),
          (role) => [...agentManager.agents.values()].some(
            a => a.status === 'idle' && a.enabled !== false && (!role || a.role === role)
          )
        );
        if (!allMet) continue;

        // Acquire condition processing lock
        const lockKey = `${agentId}:${task.id}`;
        if (!agentManager._conditionProcessing) agentManager._conditionProcessing = new Map();
        if (agentManager._conditionProcessing.has(lockKey)) continue;
        agentManager._conditionProcessing.set(lockKey, Date.now());

        if (transition.trigger === Trigger.ON_ENTER) {
          // On-enter retry: flat cooldown with max retry count
          if (!agentManager._onEnterRetryTimestamps) agentManager._onEnterRetryTimestamps = new Map();
          if (!agentManager._onEnterRetryCounts) agentManager._onEnterRetryCounts = new Map();
          const retryKey = `${agentId}:${task.id}:lastRetry`;
          const retryCount = agentManager._onEnterRetryCounts.get(retryKey) || 0;

          // Max retries reached — give up
          if (retryCount >= ON_ENTER_MAX_RETRIES) {
            console.warn(`[WorkflowEngine] on_enter retry exhausted (${ON_ENTER_MAX_RETRIES} attempts) for "${(task.text || '').slice(0, 60)}" in status="${task.status}" — giving up`);
            const actualTask = agentManager._getAgentTasks(agentId).find(t => t.id === task.id);
            if (actualTask) {
              delete actualTask._pendingOnEnter;
              delete actualTask._completedActionIdx;
              actualTask.completedActionIdx = null;
              saveTaskToDb({ ...actualTask, agentId }).catch(() => {});
            }
            agentManager._onEnterRetryCounts.delete(retryKey);
            agentManager._onEnterRetryTimestamps.delete(retryKey);
            agentManager._conditionProcessing.delete(lockKey);
            break;
          }

          const lastRetry = agentManager._onEnterRetryTimestamps.get(retryKey) || 0;
          if (Date.now() - lastRetry < ON_ENTER_RETRY_COOLDOWN_MS) {
            agentManager._conditionProcessing.delete(lockKey);
            break;
          }
          agentManager._onEnterRetryTimestamps.set(retryKey, Date.now());
          agentManager._onEnterRetryCounts.set(retryKey, retryCount + 1);

          console.log(`[WorkflowEngine] on_enter retry ${retryCount + 1}/${ON_ENTER_MAX_RETRIES} for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`);

          // Re-run via processColumnEntry to respect completedActionIdx
          processColumnEntry({ ...task, agentId }, agentManager, { by: 'on-enter-retry' })
            .catch(err => console.error(`[WorkflowEngine] on_enter retry error:`, err.message))
            .finally(() => agentManager._conditionProcessing.delete(lockKey));
          break;
        }

        // Conditional transition: execute the action chain
        console.log(`[WorkflowEngine] Condition met for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`);

        const wf = boardWorkflowMap.get(task.boardId)
          || (boardWorkflowMap.size === 1 ? [...boardWorkflowMap.values()][0] : null);
        const ownerId = wf?.userId || agent.ownerId || null;

        _executeActionChain(transition.actions || [], { ...task, agentId }, {
          agentManager,
          io,
          ownerId,
          workflow: wf,
          originalStatus: task.status,
        })
          .catch(err => console.error(`[WorkflowEngine] Condition action error:`, err.message))
          .finally(() => agentManager._conditionProcessing.delete(lockKey));

        break; // only process the first matching transition per task
      }
    }
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Execute a chain of actions sequentially, respecting completedActionIdx for resume.
 */
async function _executeActionChain(actions, task, { agentManager, io, ownerId, workflow, originalStatus }) {
  // Resume from last completed action if this is a retry
  const rawIdx = task.completedActionIdx ?? task._completedActionIdx;
  const startIdx = typeof rawIdx === 'number' ? rawIdx + 1 : 0;

  if (startIdx > 0) {
    console.log(`[WorkflowEngine] Resuming chain from action ${startIdx}/${actions.length}`);
  }

  for (let i = startIdx; i < actions.length; i++) {
    const action = actions[i];

    const result = await executeAction(action, task, { agentManager, io, ownerId, workflow });

    if (result.skipped) {
      // Action could not run (no agent, lock held, etc.) — flag for retry
      const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
      if (actualTask) {
        actualTask._pendingOnEnter = actualTask.status;
        actualTask._completedActionIdx = i > 0 ? i - 1 : undefined;
        actualTask.completedActionIdx = i > 0 ? i - 1 : undefined;
        console.log(`[WorkflowEngine] Action ${i} skipped (${result.reason}) — flagged for retry`);
        await saveTaskToDb({ ...actualTask, agentId: task.agentId });
      }
      break;
    }

    if (result.executed) {
      // Track completed action index for chain resume
      const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
      if (actualTask) {
        actualTask._completedActionIdx = i;
        actualTask.completedActionIdx = i;
        if (actualTask._pendingOnEnter === originalStatus) {
          delete actualTask._pendingOnEnter;
          // Clear retry counter on success
          if (agentManager._onEnterRetryCounts) {
            agentManager._onEnterRetryCounts.delete(`${task.agentId}:${task.id}:lastRetry`);
          }
          if (agentManager._onEnterRetryTimestamps) {
            agentManager._onEnterRetryTimestamps.delete(`${task.agentId}:${task.id}:lastRetry`);
          }
        }
        await saveTaskToDb({ ...actualTask, agentId: task.agentId });
      }

      // Sync task state from memory (agent may have changed it)
      const freshTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
      if (freshTask) {
        task.text = freshTask.text;
        task.title = freshTask.title;
        task.status = freshTask.status;
        task.assignee = freshTask.assignee;
      }
    }

    // Stop chain if task errored
    if (task.status === 'error') {
      console.log(`[WorkflowEngine] Task "${task.id}" in error — stopping chain`);
      break;
    }

    // Stop chain if status changed (change_status or execute moved it)
    if (result.statusChanged || (action.mode === 'execute' && task.status !== originalStatus)) {
      console.log(`[WorkflowEngine] Task "${task.id}" status changed to "${task.status}" — stopping chain`);
      break;
    }
  }

  // Clean up chain resume index
  const taskAfterChain = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (taskAfterChain && (typeof taskAfterChain._completedActionIdx === 'number' || typeof taskAfterChain.completedActionIdx === 'number')) {
    delete taskAfterChain._completedActionIdx;
    taskAfterChain.completedActionIdx = null;
    await saveTaskToDb({ ...taskAfterChain, agentId: task.agentId });
  }
}

/**
 * Auto-assign a task to an agent based on the column's autoAssignRole config.
 */
function _autoAssignByColumn(task, workflow, agentManager, ownerId, io) {
  const currentColumn = workflow.columns?.find(c => c.id === task.status);
  const colIndex = workflow.columns?.findIndex(c => c.id === task.status) ?? -1;
  const isFirstOrLast = colIndex === 0 || colIndex === (workflow.columns?.length || 0) - 1;

  if (!currentColumn?.autoAssignRole || isFirstOrLast) return;

  const autoAgent = findAgentForAssignment(
    agentManager.agents,
    currentColumn.autoAssignRole,
    ownerId,
    (agentId) => agentManager._getAgentTasks(agentId),
    task.id
  );

  if (autoAgent) {
    console.log(`[WorkflowEngine] Auto-assign: "${(task.text || '').slice(0, 60)}" → "${autoAgent.name}" (role: ${currentColumn.autoAssignRole})`);
    task.assignee = autoAgent.id;
    const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
    if (actualTask) {
      actualTask.assignee = autoAgent.id;
      saveTaskToDb({ ...actualTask, agentId: task.agentId });
    }
    // Enrich with assignee info for the frontend
    if (task.assignee) {
      const assigneeAgent = agentManager.agents.get(task.assignee);
      task.assigneeName = assigneeAgent?.name || null;
      task.assigneeIcon = assigneeAgent?.icon || null;
    }
    agentManager._emit('task:updated', { agentId: task.agentId, task });
  }
}
