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
import { executeAction, recordReassign } from './actionExecutor.js';
import { markTaskError } from './taskErrors.js';
import { getCurrentEnvironment } from '../../lib/environment.js';
import {
  isValidTransition,
  evaluateAllConditions,
  getMatchingTransitions,
  columnExists,
  Trigger,
} from './taskStateMachine.js';
import { findAgentForAssignment, hasLockForTask, hasIdleAgentWithRole } from './agentSelector.js';

// ── Progressive cooldown for on_enter retries ──────────────────────────────
// Starts at 200ms and doubles each retry up to a 2s cap: 200ms, 400ms, 800ms, 1.6s, 2s…
// In production, the 5s task-loop poll interval dominates anyway, so the cooldown
// only matters when called at higher frequency (e.g. tests poll every 100ms).
const ON_ENTER_RETRY_INITIAL_MS = 200;
const ON_ENTER_RETRY_MAX_MS     = 2_000;

// ── Per-task processing lock ────────────────────────────────────────────────
// Prevents concurrent processColumnEntry calls for the same task, which can
// happen when executeChangeStatus triggers a nested _checkAutoRefine call
// while the parent chain is still running.
const _processingTasks = new Map(); // taskId → status being processed

// One-shot guard for the post-restart re-arm in recheckPendingTransitions.
let _startupReArmDone = false;

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

  if (task.isManual) {
    console.log(`[WorkflowEngine] Skipping — task is manual (no automatic agent processing)`);
    return;
  }

  // Respect a user Stop — without this, on_enter / condition transitions on
  // the current column would re-launch the agent within seconds of the user
  // pressing Stop. Only the durable executionStatus blocks here; the in-memory
  // 'stopped' signal is set by route handlers on any status change (to wake
  // the reminder loop / execution wait) and would otherwise block the new
  // column's workflow from starting.
  if (task.executionStatus === 'stopped') {
    console.log(`[WorkflowEngine] Skipping — task was stopped by user (executionStatus=stopped)`);
    return;
  }

  // ── Per-task lock: prevent concurrent processing ────────────────────────
  // When executeChangeStatus calls setTaskStatus with skipAutoRefine=false,
  // it triggers a nested processColumnEntry while the parent chain is still
  // running. This causes race conditions where multiple chains can move the
  // task concurrently, leading to tasks "jumping" columns or disappearing.
  // We defer the nested call so recheckPendingTransitions picks it up instead.
  if (_processingTasks.has(task.id)) {
    const currentlyProcessing = _processingTasks.get(task.id);
    console.log(`[WorkflowEngine] processColumnEntry: already processing task="${task.id}" (status="${currentlyProcessing}") — deferring for status="${task.status}"`);
    // Flag for deferred on_enter so recheckPendingTransitions picks it up
    const actualTask = agentManager._getAgentTasks(task.agentId)?.find(t => t.id === task.id);
    if (actualTask && task.status !== currentlyProcessing) {
      actualTask._pendingOnEnter = task.status;
      saveTaskToDb({ ...actualTask, agentId: task.agentId }).catch(() => {});
    }
    return;
  }
  _processingTasks.set(task.id, task.status);

  try {

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

    // Evaluate conditions for conditional triggers
    if (transition.trigger === Trigger.CONDITION) {
      const allMet = evaluateAllConditions(
        transition.conditions || [],
        task,
        (agentId) => agentManager.agents.get(agentId),
        (role) => hasIdleAgentWithRole(agentManager.agents, role)
      );
      if (!allMet) {
        console.log(`[WorkflowEngine] Conditions not met for transition from="${transition.from}"`);
        continue;
      }
    }

    // Execute action chain
    const actions = transition.actions || [];
    console.log(`[WorkflowEngine] Transition matched: from="${transition.from}" trigger="${transition.trigger}" (${actions.length} actions) task="${task.id}"`);

    const chainResult = await _executeActionChain(actions, task, {
      agentManager,
      io,
      ownerId,
      workflow,
      originalStatus,
    });

    // If an action in the chain was skipped (e.g., no idle agent), stop
    // processing further transitions for this column. Without this, a
    // subsequent transition could move the task forward (via change_status)
    // before the skipped action (e.g., run_agent) gets a chance to execute,
    // causing tasks to "jump" columns without being processed.
    if (chainResult?.skipped) {
      console.log(`[WorkflowEngine] Chain had skipped actions — deferring remaining transitions for task="${task.id}"`);
      break;
    }
  }

  } finally {
    _processingTasks.delete(task.id);
  }
}

/**
 * Evict stale condition processing locks that no longer guard a live chain.
 */
function _evictStaleConditionLocks(agentManager) {
  const LOCK_TTL_MS = 2 * 60 * 1000;
  if (!agentManager._conditionProcessing) return;
  const now = Date.now();
  for (const [key, timestamp] of agentManager._conditionProcessing) {
    if (now - timestamp > LOCK_TTL_MS) {
      // A legitimately long chain (e.g. a CLI coding run) can exceed the TTL
      // while its run_agent action still holds a fresh execution lock —
      // evicting then would re-fire the chain every tick and corrupt the
      // live chain's resume bookkeeping. Only evict truly wedged locks.
      if (hasLockForTask(`${key}:`)) continue;
      console.warn(`[WorkflowEngine] Evicting stale condition lock: ${key}`);
      agentManager._conditionProcessing.delete(key);
    }
  }
}

/**
 * Sweep stale on_enter retry bookkeeping. Entries are only cleaned up when a
 * chain action later succeeds, so tasks that get deleted, errored, stopped or
 * moved while pending would leak their entries forever. A live retry refreshes
 * its timestamp on every attempt; anything older than the TTL is abandoned
 * (worst case for a false positive: the 200ms-2s backoff resets to 200ms).
 */
function _sweepOnEnterRetryState(agentManager) {
  if (!agentManager._onEnterRetry) return;
  const RETRY_TTL_MS = 15 * 60 * 1000;
  const now = Date.now();
  for (const [key, entry] of agentManager._onEnterRetry) {
    if (now - entry.ts > RETRY_TTL_MS) {
      agentManager._onEnterRetry.delete(key);
    }
  }
}

/**
 * Load the board → transitions map for transitions that are condition-based or
 * on_enter. Returns empty maps (so the caller early-returns) if the load fails.
 */
async function _loadRelevantBoardTransitions(): Promise<{ transMap: Map<any, any>; workflowMap: Map<any, any> }> {
  const transMap = new Map();
  const workflowMap = new Map();

  let boardWorkflows;
  try {
    boardWorkflows = await getAllBoardWorkflows();
  } catch (err) {
    console.error(`[WorkflowEngine] Failed to load board workflows:`, err.message);
    return { transMap, workflowMap };
  }

  for (const { boardId, workflow } of boardWorkflows) {
    const relevant = workflow.transitions
      .filter(isValidTransition)
      .filter(t => {
        if (t.trigger === Trigger.CONDITION && (t.conditions || []).length > 0) return true;
        if (t.trigger === Trigger.ON_ENTER) return true;
        return false;
      });
    if (relevant.length > 0) {
      transMap.set(boardId, relevant);
      workflowMap.set(boardId, workflow);
    }
  }

  return { transMap, workflowMap };
}

/**
 * One-shot post-restart recovery: a redeploy/crash mid-chain would leave the
 * on_enter filter never re-firing while the task loop skips workflow-managed
 * columns, freezing the task forever. Tasks whose deferred retry was persisted
 * (pending_on_enter, restored into _pendingOnEnter at boot) are already armed
 * and skipped here. For rows saved before that column existed, fall back to the
 * durable interruption markers: a stale actionRunning flag (crashed mid-
 * run_agent) or a numeric completedActionIdx (chain was saved mid-way / an
 * action was skipped and never resumed). Chains that completed cleanly reset all
 * markers, so they are not re-run.
 */
function _reArmInterruptedChainsOnce(agentManager, ownEnv) {
  if (_startupReArmDone) return;
  _startupReArmDone = true;
  for (const [agentId] of agentManager.agents) {
    for (const task of agentManager._getAgentTasks(agentId)) {
      if (_processingTasks.has(task.id)) continue;
      if (task.status === 'error' || task.isManual) continue;
      if (task.executionStatus === 'stopped') continue;
      if (agentManager._isActiveTaskStatus && !agentManager._isActiveTaskStatus(task.status)) continue;
      if (task.environment !== ownEnv) continue;
      // A crash during the watch phase persists executionStatus='watching'.
      // The startup sweep (clearAllStaleActionRunning) already reset it in
      // the DB; mirror that on the in-memory copy loaded at boot so a later
      // save can't re-persist the stale flag and the re-arm can proceed.
      if (task.executionStatus === 'watching') task.executionStatus = null;
      if (task._pendingOnEnter === task.status) continue;
      const idx = task.completedActionIdx;
      if (task.actionRunning !== true && typeof idx !== 'number') continue;
      console.log(`[WorkflowEngine] Re-arming interrupted chain after restart: task="${task.id}" status="${task.status}"`);
      task._pendingOnEnter = task.status;
    }
  }
}

/**
 * Recheck a single task against its board's relevant transitions. SYNCHRONOUS by
 * design: the original loop body had no awaits, and fires processColumnEntry /
 * _executeActionChain as detached promises. Inserting awaits here would change
 * interleaving with those fire-and-forget chains and the synchronous lock sets.
 */
function _recheckTask(task, agentId, agent, boards, agentManager, ownEnv) {
  const io = agentManager.io;
  const { transMap: boardTransMap, workflowMap: boardWorkflowMap } = boards;

  if (task.status === 'error') return;
  if (task.isManual) return;
  // Don't re-fire on_enter retries or condition transitions for tasks
  // the user has stopped; otherwise the periodic recheck would relaunch
  // the agent on the very next tick after a Stop click. Only the durable
  // executionStatus blocks here — see processColumnEntry for the same
  // reasoning around the in-memory 'stopped' signal.
  if (task.executionStatus === 'stopped') return;
  // Environment isolation: ignore tasks tagged for another deployment.
  if (task.environment !== ownEnv) return;

  const transitions = boardTransMap.get(task.boardId)
    || (boardTransMap.size === 1 ? [...boardTransMap.values()][0] : []);
  const matching = transitions.filter(t => t.from === task.status);
  if (matching.length === 0) return;

  // Skip if assignee is busy (unless this is a pending on_enter retry)
  if (task.assignee && !task._pendingOnEnter) {
    const assigneeAgent = agentManager.agents.get(task.assignee);
    if (assigneeAgent && assigneeAgent.status === 'busy') return;
  }

  for (const transition of matching) {
    // on_enter retries: only process if flagged as pending
    if (transition.trigger === Trigger.ON_ENTER && task._pendingOnEnter !== task.status) continue;

    // Evaluate conditions
    const allMet = evaluateAllConditions(
      transition.conditions || [],
      { ...task, agentId },
      (id) => agentManager.agents.get(id),
      (role) => hasIdleAgentWithRole(agentManager.agents, role)
    );
    if (!allMet) continue;

    // Acquire condition processing lock
    const lockKey = `${agentId}:${task.id}`;
    if (!agentManager._conditionProcessing) agentManager._conditionProcessing = new Map();
    if (agentManager._conditionProcessing.has(lockKey)) continue;
    agentManager._conditionProcessing.set(lockKey, Date.now());

    if (transition.trigger === Trigger.ON_ENTER) {
      // Skip if the task is already being processed by another processColumnEntry
      // call (e.g. from _checkAutoRefine). Firing a retry here would just get
      // deferred and waste a retry counter increment.
      if (_processingTasks.has(task.id)) {
        agentManager._conditionProcessing.delete(lockKey);
        return;
      }

      // On-enter retry: infinite retries with progressive cooldown (200ms → 2s)
      if (!agentManager._onEnterRetry) agentManager._onEnterRetry = new Map();
      const retryKey = `${agentId}:${task.id}`;
      const retryEntry = agentManager._onEnterRetry.get(retryKey);
      const retryCount = retryEntry?.count || 0;

      const cooldown = Math.min(ON_ENTER_RETRY_MAX_MS, ON_ENTER_RETRY_INITIAL_MS * Math.pow(2, retryCount));
      const lastRetry = retryEntry?.ts || 0;
      if (Date.now() - lastRetry < cooldown) {
        agentManager._conditionProcessing.delete(lockKey);
        return;
      }
      agentManager._onEnterRetry.set(retryKey, { ts: Date.now(), count: retryCount + 1 });

      console.log(`[WorkflowEngine] on_enter retry #${retryCount + 1} for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`);

      // Re-run via processColumnEntry to respect completedActionIdx
      processColumnEntry({ ...task, agentId }, agentManager, { by: 'on-enter-retry' })
        .catch(err => console.error(`[WorkflowEngine] on_enter retry error:`, err.message))
        .finally(() => agentManager._conditionProcessing.delete(lockKey));
      return;
    }

    // Conditional transition: execute the action chain.
    // Register the task in _processingTasks (like processColumnEntry does)
    // so a nested processColumnEntry fired by a change_status action is
    // deferred instead of running concurrently with the chain's tail —
    // and skip if another chain already holds the task.
    if (_processingTasks.has(task.id)) {
      agentManager._conditionProcessing.delete(lockKey);
      return;
    }
    console.log(`[WorkflowEngine] Condition met for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`);

    const wf = boardWorkflowMap.get(task.boardId)
      || (boardWorkflowMap.size === 1 ? [...boardWorkflowMap.values()][0] : null);
    const ownerId = wf?.userId || agent.ownerId || null;

    _processingTasks.set(task.id, task.status);
    _executeActionChain(transition.actions || [], { ...task, agentId }, {
      agentManager,
      io,
      ownerId,
      workflow: wf,
      originalStatus: task.status,
    })
      .catch(err => console.error(`[WorkflowEngine] Condition action error:`, err.message))
      .finally(() => {
        _processingTasks.delete(task.id);
        agentManager._conditionProcessing.delete(lockKey);
      });

    return; // only process the first matching transition per task
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
  _evictStaleConditionLocks(agentManager);
  _sweepOnEnterRetryState(agentManager);

  const boards = await _loadRelevantBoardTransitions();
  if (boards.transMap.size === 0) return;

  // Skip tasks created by a sibling replica when several deployments share
  // the DB.
  const ownEnv = getCurrentEnvironment();

  _reArmInterruptedChainsOnce(agentManager, ownEnv);

  // Iterate all tasks across all agents
  for (const [agentId, agent] of agentManager.agents) {
    const agentTasks = agentManager._getAgentTasks(agentId);
    for (const task of agentTasks) {
      _recheckTask(task, agentId, agent, boards, agentManager, ownEnv);
    }
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Execute a chain of actions sequentially, respecting completedActionIdx for resume.
 *
 * @returns {{ skipped: boolean }} — whether an action in the chain was skipped
 */
async function _executeActionChain(actions, task, { agentManager, io, ownerId, workflow, originalStatus }) {
  // Resume from last completed action ONLY if this is a retry for the same column.
  // _pendingOnEnter is set by the skipped-action path and tracks the status we were
  // retrying. If it doesn't match the current status, the saved index belongs to a
  // previous chain (e.g. qualification chain not yet cleaned up when assignation
  // chain re-enters from a nested update_task) — ignore it to avoid skipping actions.
  const pendingFor = task._pendingOnEnter;
  const rawIdx = task.completedActionIdx;
  const isResume = typeof rawIdx === 'number' && pendingFor === originalStatus;
  const startIdx = isResume ? rawIdx + 1 : 0;

  if (startIdx > 0) {
    console.log(`[WorkflowEngine] Resuming chain from action ${startIdx}/${actions.length}`);
  } else if (typeof rawIdx === 'number' && pendingFor !== originalStatus) {
    console.log(`[WorkflowEngine] Ignoring stale completedActionIdx=${rawIdx} (pendingFor="${pendingFor}" != current="${originalStatus}") — starting fresh`);
  }

  let hadSkippedAction = false;

  for (let i = startIdx; i < actions.length; i++) {
    const action = actions[i];

    const result = await executeAction(action, task, { agentManager, io, ownerId, workflow });

    if (result.error) {
      // Action failed with an error — mark task as error and stop chain.
      // The task stays in its originating column (via errorFromStatus) and
      // appears in red. markTaskError guarantees errorFromStatus stays valid
      // even when the task was already errored or the workflow was edited.
      console.log(`[WorkflowEngine] Action ${i} errored: ${result.message} — setting task to error`);
      const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
      if (actualTask) {
        const mutated = markTaskError(actualTask, result.message, {
          by: 'workflow',
          mode: action.mode || null,
          actionIndex: i,
          workflow,
        });
        // Preserve the actionType detail that the old inline code emitted —
        // markTaskError doesn't know about workflow-specific fields.
        if (mutated) {
          const lastEntry = actualTask.history[actualTask.history.length - 1];
          if (lastEntry) lastEntry.actionType = action.type;
          await saveTaskToDb({ ...actualTask, agentId: task.agentId });
          agentManager._emit('task:updated', { agentId: task.agentId, task: { ...actualTask, agentId: task.agentId } });
        }
      }
      task.status = 'error';
      break;
    }

    if (result.skipped) {
      // Action could not run (no agent, lock held, etc.) — flag for retry
      hadSkippedAction = true;
      const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
      if (actualTask) {
        actualTask._pendingOnEnter = actualTask.status;
        // Persist the resume index even when the FIRST action is skipped
        // (-1 → resume from 0): together with pending_on_enter (saved from
        // _pendingOnEnter below) it survives a restart and lets
        // recheckPendingTransitions resume the interrupted chain.
        actualTask.completedActionIdx = i - 1;
        console.log(`[WorkflowEngine] Action ${i} skipped (${result.reason}) — flagged for retry`);
        await saveTaskToDb({ ...actualTask, agentId: task.agentId });
      }
      break;
    }

    if (result.executed) {
      // Track completed action index for chain resume
      const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
      if (actualTask) {
        actualTask.completedActionIdx = i;
        if (actualTask._pendingOnEnter === originalStatus) {
          delete actualTask._pendingOnEnter;
          // Clear retry counter on success
          if (agentManager._onEnterRetry) {
            agentManager._onEnterRetry.delete(`${task.agentId}:${task.id}`);
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

  // Clean up chain resume index (only if no action was skipped — skipped chains
  // need the index preserved for retry via recheckPendingTransitions)
  if (!hadSkippedAction) {
    const taskAfterChain = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
    if (taskAfterChain && typeof taskAfterChain.completedActionIdx === 'number') {
      taskAfterChain.completedActionIdx = null;
      await saveTaskToDb({ ...taskAfterChain, agentId: task.agentId });
    }
  }

  return { skipped: hadSkippedAction };
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
    (agentId: any) => agentManager._getAgentTasks(agentId),
    task.id,
    task.boardId || null
  ) as any;

  if (autoAgent) {
    console.log(`[WorkflowEngine] Auto-assign: "${(task.text || '').slice(0, 60)}" → "${autoAgent.name}" (role: ${currentColumn.autoAssignRole})`);
    task.assignee = autoAgent.id;
    const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
    if (actualTask) {
      actualTask.assignee = autoAgent.id;
      // Record history for consistency with other assignment paths
      recordReassign(actualTask, autoAgent.id);
      // Defer emit until after DB save so the frontend's loadTasks() reads
      // the committed row (same pattern as executeAssignAgent).
      const assignPayload = { ...actualTask, agentId: task.agentId };
      const assigneeAgent = agentManager.agents.get(autoAgent.id);
      assignPayload.assigneeName = assigneeAgent?.name || null;
      assignPayload.assigneeIcon = assigneeAgent?.icon || null;
      const savePromise = saveTaskToDb({ ...actualTask, agentId: task.agentId });
      Promise.resolve(savePromise)
        .catch(() => {})
        .then(() => agentManager._emit('task:updated', { agentId: task.agentId, task: assignPayload }));
    }
  }
}
