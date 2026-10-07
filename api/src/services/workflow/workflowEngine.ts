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
 *
 * Persistence rule: the engine never saves a whole task row. Its bookkeeping
 * (pending_on_enter, completed_action_idx, resume_transition_idx) is written
 * with targeted updates GUARDED by the column the chain runs in — once the task
 * has left that column, a chain's late bookkeeping cannot touch it (it used to
 * erase the next column's deferral marker, or graft its resume index on it).
 */

import { getWorkflowForBoard, getAllBoardWorkflows } from '../configManager.js';
import {
  getTaskById,
  getActiveWorkflowTasks,
  getInterruptedChainTasks,
  getStaleRunClaims,
  healStaleRunClaim,
  getOrphanCommitRuns,
  updateTaskFields,
  getActiveAssigneeIds,
  tryAcquireTaskLock,
  releaseTaskLock,
} from '../database.js';
import { emitTaskUpdated, persistTaskError } from '../taskMutations.js';
import { executeAction } from './actionExecutor.js';
import type { ActionContext, ActionResult } from './actionExecutor.js';
import { refreshClaimedAgents } from './runClaims.js';
import {
  recoverPersistedCommitRun,
  sweepOrphanCommitRuns,
} from '../agentManager/tools/gitReconcile.js';
import { needsApproval } from '../../lib/taskTrust.js';
import { getCurrentEnvironment, isEnvironmentLocked } from '../../lib/environment.js';
import { errorMessage } from '../../lib/errors.js';
import {
  isValidTransition,
  evaluateAllConditions,
  getMatchingTransitions,
  Trigger,
} from './taskStateMachine.js';
import type {
  BoardWorkflow,
  WorkflowAction,
  WorkflowConfig,
  WorkflowTransition,
} from './taskStateMachine.js';
import type { Agent } from '../database/agents.js';
import type { AgentManager } from '../agentManager/index.js';
import type { Task } from '../database/tasks.js';
import {
  findAgentForAssignment,
  hasLockForTask,
  hasIdleAgentWithRole,
  clearAgentBusy,
  isTaskRunning,
} from './agentSelector.js';

// ── Progressive cooldown for on_enter retries ──────────────────────────────
// Starts at 200ms and doubles each retry up to a 2s cap: 200ms, 400ms, 800ms, 1.6s, 2s…
// In production, the 5s task-loop poll interval dominates anyway, so the cooldown
// only matters when called at higher frequency (e.g. tests poll every 100ms).
const ON_ENTER_RETRY_INITIAL_MS = 200;
const ON_ENTER_RETRY_MAX_MS = 2_000;

// ── Per-task processing lock ────────────────────────────────────────────────
// Prevents concurrent processColumnEntry calls for the same task, which can
// happen when executeChangeStatus triggers a nested _checkAutoRefine call
// while the parent chain is still running.
const _processingTasks = new Map(); // taskId → status being processed

// One-shot guard for the post-restart re-arm in recheckPendingTransitions.
let _startupReArmDone = false;

/** Where a deferred chain resumes: in which transition, after which action. */
interface ResumePoint {
  transitionIdx: number;
  completedActionIdx: number;
}

/**
 * The resume point recorded for `status`, if any. completed_action_idx is
 * relative to resume_transition_idx; a legacy row without the latter resumes
 * in the column's first transition.
 */
function _resumePointFor(row: Task, status: string): ResumePoint | null {
  if (row._pendingOnEnter !== status) return null;
  if (typeof row.completedActionIdx !== 'number') return null;
  return {
    transitionIdx: typeof row.resumeTransitionIdx === 'number' ? row.resumeTransitionIdx : 0,
    completedActionIdx: row.completedActionIdx,
  };
}

/** Targeted chain bookkeeping, applied only while the task is still in `status`. */
function _writeChainMarkers(taskId: string, status: string, fields: Record<string, unknown>) {
  return updateTaskFields(taskId, fields, { expect: { status } });
}

/**
 * Re-arm a column's on_enter for the recheck (durable, survives a restart). The
 * resume point is kept: a deferral (env mismatch, unreadable workflow) must not
 * make a half-run chain start over and repeat its completed actions. A move to
 * another column resets it (setTaskStatus / applyTaskMove).
 */
function _markPendingOnEnter(taskId: string, status: string) {
  return _writeChainMarkers(taskId, status, { pendingOnEnter: status });
}

/** Drop a column's resume point and retry marker. */
function _clearChainMarkers(taskId: string, status: string) {
  return _writeChainMarkers(taskId, status, {
    pendingOnEnter: null,
    completedActionIdx: null,
    resumeTransitionIdx: null,
  });
}

/**
 * Process all transitions triggered when a task enters a column.
 *
 * This is the single entry point called by setTaskStatus and addTask.
 * It replaces the old _checkAutoRefine method.
 *
 * @param {Object} task          - { id, agentId, boardId, status, text, ... }
 * @param {Object} agentManager  - the AgentManager instance
 * @param {Object} [options]     - { by: string, onRunClaimed: () => void }
 */
export async function processColumnEntry(
  task: Task,
  agentManager: AgentManager,
  { by = null, onRunClaimed }: { by?: string | null; onRunClaimed?: () => void } = {}
) {
  const io = agentManager.io;

  console.log(
    `[WorkflowEngine] processColumnEntry: status="${task.status}" task="${task.id}" "${(task.title || task.text || '').slice(0, 60)}" by="${by || 'unknown'}"`
  );

  if (task.status === 'error') {
    console.log(`[WorkflowEngine] Skipping — task is in error status`);
    return;
  }

  // ── Per-task lock: prevent concurrent processing ────────────────────────
  // When executeChangeStatus calls setTaskStatus with skipAutoRefine=false,
  // it triggers a nested processColumnEntry while the parent chain is still
  // running (or a run of the task is still in flight). The nested call is
  // deferred: a durable pending_on_enter marker is written — awaited, and only
  // while the task is in that column — and the parent's chain-continuation (or,
  // after a restart, the recheck) processes the column once the parent is done.
  if (_processingTasks.has(task.id) || isTaskRunning(task.id)) {
    const currentlyProcessing = _processingTasks.get(task.id) ?? 'active-run';
    console.log(
      `[WorkflowEngine] processColumnEntry: already processing task="${task.id}" (status="${currentlyProcessing}") — deferring for status="${task.status}"`
    );
    if (task.status !== currentlyProcessing) {
      await _markPendingOnEnter(task.id, task.status);
    }
    return;
  }
  _processingTasks.set(task.id, task.status);
  const enteredStatus = task.status;
  let lastStatus: string | null = null;

  try {
    // Decide on the CURRENT row, not the caller's snapshot: a Stop, an approval
    // gate or a manual flag may have been persisted since the snapshot was taken
    // (a chain-continuation used to relaunch a task the user had just stopped).
    const fresh = await getTaskById(task.id);
    if (!fresh) return;
    if (fresh.status !== task.status) {
      // The task moved again meanwhile; that move fires its own column entry.
      console.log(
        `[WorkflowEngine] Skipping — task="${task.id}" is now in "${fresh.status}", not "${task.status}"`
      );
      return;
    }
    const current: Task = { ...fresh, agentId: fresh.agentId ?? task.agentId ?? null };
    lastStatus = current.status;

    if (current.isManual) {
      console.log(`[WorkflowEngine] Skipping — task is manual (no automatic agent processing)`);
      return;
    }

    // External text nobody has read yet: no action at all — not even an
    // auto-assign or a status change — until a human approves it. Approval
    // re-enters the current column (routes/tasks.ts POST /:id/approve).
    if (needsApproval(current)) {
      console.log(`[WorkflowEngine] Skipping — external task awaiting human approval`);
      return;
    }

    // Respect a user Stop — without this, on_enter / condition transitions on
    // the current column would re-launch the agent within seconds of the user
    // pressing Stop. Only the durable executionStatus blocks here; the in-memory
    // 'stopped' signal is set by route handlers on any status change (to wake
    // the reminder loop / execution wait) and would otherwise block the new
    // column's workflow from starting.
    if (current.executionStatus === 'stopped') {
      console.log(`[WorkflowEngine] Skipping — task was stopped by user (executionStatus=stopped)`);
      return;
    }

    // Another environment's task (stacks sharing the database): its own replica
    // runs it. Leave the entry armed for that replica's recheck instead of
    // dropping it.
    const ownEnv = getCurrentEnvironment();
    if ((current.environment || 'prod') !== ownEnv) {
      console.log(
        `[WorkflowEngine] Skipping — task="${task.id}" belongs to environment "${current.environment}" (this replica: "${ownEnv}")`
      );
      await _markPendingOnEnter(task.id, current.status);
      return;
    }

    let workflow: WorkflowConfig;
    try {
      workflow = await getWorkflowForBoard(current.boardId);
    } catch (err) {
      // The board exists but could not be read: retry later rather than run
      // the built-in workflow in its place.
      console.error(`[WorkflowEngine] Failed to load workflow:`, errorMessage(err));
      await _markPendingOnEnter(task.id, current.status);
      return;
    }

    const ownerId =
      workflow.userId ||
      (current.agentId ? agentManager.agents.get(current.agentId)?.ownerId : null) ||
      null;

    // Auto-assign by column role
    await _autoAssignByColumn(current, workflow, agentManager, ownerId, io);

    // Find matching transitions for this column
    const transitions = getMatchingTransitions(workflow, current.status);
    if (transitions.length === 0) {
      console.log(
        `[WorkflowEngine] No transitions for status="${current.status}" task="${task.id}"`
      );
      return;
    }

    const originalStatus = current.status;
    // A deferred chain resumes in the transition that skipped, after its last
    // completed action; the transitions before it already ran. A resume point
    // past the column's transitions (the workflow was edited) is dropped.
    let resume = _resumePointFor(current, originalStatus);
    if (resume && resume.transitionIdx >= transitions.length) {
      console.log(
        `[WorkflowEngine] Dropping out-of-range resume point (transition ${resume.transitionIdx}/${transitions.length}) task="${task.id}"`
      );
      await _clearChainMarkers(task.id, originalStatus);
      resume = null;
    }

    for (let ti = 0; ti < transitions.length; ti++) {
      const transition = transitions[ti];
      // If a previous action changed the status, stop processing
      if (current.status !== originalStatus) {
        console.log(
          `[WorkflowEngine] Task "${task.id}" moved from "${originalStatus}" to "${current.status}" — stopping`
        );
        break;
      }
      if (resume && ti < resume.transitionIdx) continue;
      const resuming = !!resume && ti === resume.transitionIdx;

      // Evaluate conditions for conditional triggers. A chain being resumed
      // already passed them: its own first actions (an assignment, a run that
      // made the agent busy) may now make them false, which would strand it.
      if (transition.trigger === Trigger.CONDITION && !resuming) {
        const allMet = evaluateAllConditions(
          transition.conditions || [],
          current,
          agentId => agentManager.agents.get(agentId),
          role => hasIdleAgentWithRole(agentManager.agents, role, current.boardId || null)
        );
        if (!allMet) {
          console.log(
            `[WorkflowEngine] Conditions not met for transition from="${transition.from}"`
          );
          continue;
        }
      }

      // Execute action chain
      const actions = transition.actions || [];
      console.log(
        `[WorkflowEngine] Transition matched: from="${transition.from}" trigger="${transition.trigger}" (${actions.length} actions) task="${task.id}"`
      );

      const startIdx = resuming && resume ? resume.completedActionIdx + 1 : 0;
      const chainResult = await _executeActionChain(
        actions,
        current,
        { agentManager, io, ownerId, workflow, originalStatus, onRunClaimed },
        { transitionIdx: ti, startIdx }
      );
      lastStatus = current.status;

      // If an action in the chain was skipped (e.g., no idle agent), stop
      // processing further transitions for this column. Without this, a
      // subsequent transition could move the task forward (via change_status)
      // before the skipped action (e.g., run_agent) gets a chance to execute,
      // causing tasks to "jump" columns without being processed.
      if (chainResult?.skipped) {
        console.log(
          `[WorkflowEngine] Chain had skipped actions — deferring remaining transitions for task="${task.id}"`
        );
        break;
      }
    }
  } finally {
    _processingTasks.delete(task.id);
  }

  // Chain continuation: an action advanced the task to a new column, whose nested
  // processColumnEntry was deferred while we held the per-task lock (see the
  // deferral guard above). Kick that column off NOW — detached, on this replica,
  // exactly like the top-level entry (_checkAutoRefine) — so its actions (e.g.
  // run_agent) fire immediately instead of waiting for the next ~5s poll tick.
  // The nested pending_on_enter marker remains as the durable fallback if this
  // replica dies before the continuation runs.
  if (lastStatus && lastStatus !== enteredStatus) {
    _continueInNewColumn(task.id, enteredStatus, agentManager);
  }
}

/**
 * Process the column a chain moved the task into, from the FRESH row (the
 * chain's working copy is stale). Every column but 'error' — including 'done',
 * whose on_enter actions (deploy, close the ticket…) never ran when the move to
 * 'done' happened inside a chain.
 */
function _continueInNewColumn(taskId: string, leftStatus: string, agentManager: AgentManager) {
  getTaskById(taskId)
    .then(fresh => {
      if (!fresh || fresh.status === leftStatus || fresh.status === 'error') return;
      if (_processingTasks.has(taskId)) return;
      return processColumnEntry(fresh, agentManager, { by: 'chain-continue' });
    })
    .catch(err => console.error(`[WorkflowEngine] chain-continue error:`, errorMessage(err)));
}

/**
 * Evict stale condition processing locks that no longer guard a live chain.
 */
function _evictStaleConditionLocks(agentManager: AgentManager) {
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
function _sweepOnEnterRetryState(agentManager: AgentManager) {
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
 * The board → transitions / workflow lookups built once per recheck tick.
 *
 * The key is `string | null` rather than `string` because only the WRITES are
 * board ids: the reads pass `task.boardId`, which is null for a task attached
 * to no board. Such a lookup simply misses — exactly as it always has.
 */
interface BoardTransitionMaps {
  transMap: Map<string | null, WorkflowTransition[]>;
  workflowMap: Map<string | null, WorkflowConfig>;
}

/**
 * Load the board → transitions map for transitions that are condition-based or
 * on_enter. Returns empty maps (so the caller early-returns) if the load fails.
 */
async function _loadRelevantBoardTransitions(): Promise<BoardTransitionMaps> {
  const transMap: BoardTransitionMaps['transMap'] = new Map();
  const workflowMap: BoardTransitionMaps['workflowMap'] = new Map();

  let boardWorkflows: BoardWorkflow[];
  try {
    boardWorkflows = await getAllBoardWorkflows();
  } catch (err) {
    console.error(`[WorkflowEngine] Failed to load board workflows:`, errorMessage(err));
    return { transMap, workflowMap };
  }

  for (const { boardId, workflow } of boardWorkflows) {
    const relevant = workflow.transitions.filter(isValidTransition).filter(t => {
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
 * One-shot post-restart recovery of chains a previous process left mid-way: a
 * numeric completed_action_idx without a pending marker (the chain was saved
 * mid-way and never resumed). Re-arming them makes recheckPendingTransitions
 * resume the chain where it stopped. Rows still holding a run claim are not
 * touched here: the stale-claim healer re-arms them once their run is provably
 * gone (a claim still heartbeating belongs to the previous replica of a
 * start-first update, which is still running it).
 */
export async function reArmInterruptedChains(agentManager: AgentManager, ownEnv: string) {
  if (_startupReArmDone) return;
  _startupReArmDone = true;
  const candidates = await getInterruptedChainTasks(ownEnv);
  for (const task of candidates) {
    if (_processingTasks.has(task.id)) continue;
    if (task.actionRunning === true) continue;
    if (task.status === 'error' || task.isManual || needsApproval(task)) continue;
    if (task.executionStatus === 'stopped') continue;
    if (agentManager._isActiveTaskStatus && !agentManager._isActiveTaskStatus(task.status))
      continue;
    if (task.environment !== ownEnv) continue;
    if (task._pendingOnEnter === task.status) continue;
    if (typeof task.completedActionIdx !== 'number') continue;
    console.log(
      `[WorkflowEngine] Re-arming interrupted chain after restart: task="${task.id}" status="${task.status}"`
    );
    // Keep completedActionIdx / resumeTransitionIdx: the chain resumes after the
    // last completed action. Also clear a stale 'watching' execution status.
    const fields: Record<string, unknown> = { pendingOnEnter: task.status };
    if (task.executionStatus === 'watching') fields.executionStatus = null;
    await _writeChainMarkers(task.id, task.status, fields);
  }
}

/**
 * Run a detached workflow chain under the cross-replica per-task advisory lock.
 * The lock is awaited INSIDE this already-fire-and-forget promise — never in the
 * synchronous recheck loop — so the loop's interleaving and synchronous lock
 * sets are unchanged. If a sibling replica holds the lock (or the local cap is
 * hit), the chain is skipped this tick and retried on the next one.
 *
 * The lock is released as soon as a run_agent action of the chain holds its DB
 * claim (`onRunClaimed`) — the claim fences the task across replicas from then
 * on — or when the chain settles. Holding it for a whole CLI run pinned one of
 * the few lock connections for an hour; six such runs blocked every other
 * retry, condition transition and heal on the replica.
 */
function _dispatchUnderLock(taskId: string, run: (onRunClaimed: () => void) => Promise<unknown>) {
  return (async () => {
    const locked = await tryAcquireTaskLock(taskId);
    if (!locked) {
      console.log(
        `[WorkflowEngine] Skipping task=${taskId} — advisory lock held (sibling replica or local cap)`
      );
      return;
    }
    let released = false;
    const release = () => {
      if (released) return Promise.resolve();
      released = true;
      return releaseTaskLock(taskId);
    };
    try {
      await run(() => {
        release().catch(() => {});
      });
    } finally {
      await release();
    }
  })();
}

/**
 * Recheck a single task against its board's relevant transitions. SYNCHRONOUS by
 * design: the original loop body had no awaits, and fires processColumnEntry /
 * _executeActionChain as detached promises. Inserting awaits here would change
 * interleaving with those fire-and-forget chains and the synchronous lock sets.
 *
 * `agentId`/`agent` are null for board-level tasks (agent_id = NULL) — keep every
 * use of `agent` optional-chained.
 */
function _recheckTask(
  task: Task,
  agentId: string | null,
  agent: Agent | null,
  boards: BoardTransitionMaps,
  agentManager: AgentManager,
  ownEnv: string
) {
  const io = agentManager.io;
  const { transMap: boardTransMap, workflowMap: boardWorkflowMap } = boards;

  if (task.status === 'error') return;
  if (task.isManual) return;
  if (needsApproval(task)) return;
  if (isTaskRunning(task.id)) return;
  // Don't re-fire on_enter retries or condition transitions for tasks
  // the user has stopped; otherwise the periodic recheck would relaunch
  // the agent on the very next tick after a Stop click. Only the durable
  // executionStatus blocks here — see processColumnEntry for the same
  // reasoning around the in-memory 'stopped' signal.
  if (task.executionStatus === 'stopped') return;
  // Environment isolation: ignore tasks tagged for another deployment.
  if (task.environment !== ownEnv) return;

  // Strictly per-board: a board with no on_enter/condition transitions is absent
  // from the map, and its tasks must NOT borrow another board's transitions.
  const transitions = boardTransMap.get(task.boardId) || [];
  const matching = transitions.filter(t => t.from === task.status);
  if (matching.length === 0) return;

  // Skip if assignee is busy (unless this is a pending on_enter retry)
  if (task.assignee && !task._pendingOnEnter) {
    const assigneeAgent = agentManager.agents.get(task.assignee);
    if (assigneeAgent && assigneeAgent.status === 'busy') return;
  }

  const wf = boardWorkflowMap.get(task.boardId) || null;
  const columnTransitions = getMatchingTransitions(wf, task.status);
  const resume = _resumePointFor(task, task.status);

  for (const transition of matching) {
    // on_enter retries: only process if flagged as pending
    if (transition.trigger === Trigger.ON_ENTER && task._pendingOnEnter !== task.status) continue;

    // The transition's index among the column's matching transitions — the
    // same indexing processColumnEntry records resume points with.
    const transitionIdx = Math.max(0, columnTransitions.indexOf(transition));
    // A condition chain interrupted mid-way resumes without re-checking its
    // conditions: its own first actions may have made them false.
    const resuming =
      transition.trigger === Trigger.CONDITION &&
      !!resume &&
      resume.transitionIdx === transitionIdx;

    // Evaluate conditions
    const allMet =
      resuming ||
      evaluateAllConditions(
        transition.conditions || [],
        { ...task, agentId },
        id => agentManager.agents.get(id),
        role => hasIdleAgentWithRole(agentManager.agents, role, task.boardId || null)
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

      const cooldown = Math.min(
        ON_ENTER_RETRY_MAX_MS,
        ON_ENTER_RETRY_INITIAL_MS * Math.pow(2, retryCount)
      );
      const lastRetry = retryEntry?.ts || 0;
      if (Date.now() - lastRetry < cooldown) {
        agentManager._conditionProcessing.delete(lockKey);
        return;
      }
      agentManager._onEnterRetry.set(retryKey, { ts: Date.now(), count: retryCount + 1 });

      console.log(
        `[WorkflowEngine] on_enter retry #${retryCount + 1} for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`
      );

      // Re-run via processColumnEntry to respect the resume point, under the
      // cross-replica lock (acquired inside the detached promise).
      _dispatchUnderLock(task.id, onRunClaimed =>
        processColumnEntry({ ...task, agentId }, agentManager, {
          by: 'on-enter-retry',
          onRunClaimed,
        })
      )
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
    console.log(
      `[WorkflowEngine] Condition met for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`
    );

    const ownerId = wf?.userId || agent?.ownerId || null;
    const startIdx =
      resume && resume.transitionIdx === transitionIdx ? resume.completedActionIdx + 1 : 0;
    const startStatus = task.status;

    _processingTasks.set(task.id, task.status);
    let ran = false;
    _dispatchUnderLock(task.id, onRunClaimed => {
      ran = true;
      return _executeActionChain(
        transition.actions || [],
        { ...task, agentId },
        {
          agentManager,
          io,
          ownerId,
          workflow: wf,
          originalStatus: task.status,
          onRunClaimed,
        },
        { transitionIdx, startIdx }
      );
    })
      .catch(err => console.error(`[WorkflowEngine] Condition action error:`, err.message))
      .finally(() => {
        _processingTasks.delete(task.id);
        agentManager._conditionProcessing.delete(lockKey);
        // Same continuation as processColumnEntry: a condition chain that moved
        // the task (change_status is the usual action of a condition) must start
        // the new column — its own entry was deferred while this chain ran, and
        // the condition chain had no continuation, stranding the task there.
        // Only when the chain ran HERE: a lock held elsewhere means a sibling
        // replica runs it, and continues it.
        if (ran) _continueInNewColumn(task.id, startStatus, agentManager);
      });

    return; // only process the first matching transition per task
  }
}

// ── Stale run-claim healer ──────────────────────────────────────────────────
// A run refreshes its claim's heartbeat every ~20 s (workflow/runClaims.ts). A
// claim whose heartbeat stopped belongs to a run that is provably gone — the
// API process died, the replica was replaced, the stack was stopped — and would
// otherwise keep its task invisible to the workflow ("busy" forever) and its
// agent unusable everywhere (the claim is unique per agent). Healing clears the
// claim, links the commits that dead run made (from the commit context persisted
// on the task) and re-arms the column's on_enter. Claims of ANY environment are
// healed: a stopped stack cannot heal its own, and its agents are shared.
// Legacy claims without a heartbeat (written by an older build) of the own
// environment are healed once old enough, as before.
let _lastStaleReconcile = 0;
const STALE_RECONCILE_INTERVAL_MS = 60_000; // run the sweep at most once a minute

export async function reconcileStaleActionRunning(agentManager: AgentManager, ownEnv: string) {
  let candidates: Task[];
  try {
    candidates = await getStaleRunClaims(ownEnv);
  } catch (err: any) {
    console.error(`[WorkflowEngine] stale run-claim sweep: query failed:`, err.message);
    return;
  }

  for (const task of candidates) {
    // A run genuinely live in THIS process (its heartbeat may just be failing
    // against the database) is never healed from under it.
    if (isTaskRunning(task.id)) continue;
    try {
      // The API process that drove the run is gone, but the CLI it pasted the
      // task into may still be working (a deploy kills the API, not the runner).
      // Keep the claim while that terminal prints: it fences the agent and the
      // task (no second run pasted into the same CLI, no other agent on the same
      // task), and the commit window stays open. Only this environment can see
      // its runners' terminals.
      const claimAgent = task.actionRunningAgentId;
      if (
        claimAgent &&
        (task.environment || 'prod') === ownEnv &&
        !(await agentManager._isCliQuiet(claimAgent))
      ) {
        console.log(
          `[WorkflowEngine] Stale claim on task="${task.id}" kept: agent=${claimAgent}'s terminal is still active`
        );
        continue;
      }
      const healed = await healStaleRunClaim(task.id, ownEnv);
      if (!healed) continue;
      if (healed.staleAgentId) clearAgentBusy(healed.staleAgentId);
      console.warn(
        `[WorkflowEngine] Healed stale run claim: task="${healed.id}" status="${healed.status}" env="${healed.environment}" (was agent=${healed.staleAgentId || '?'}) — cleared + re-armed on_enter`
      );
      // The dead run's commits still belong to this task: link them now from
      // the persisted context (only this environment's replica can reach the
      // runner that holds the clone).
      if ((healed.environment || 'prod') === ownEnv && healed.commitRun) {
        await recoverPersistedCommitRun(agentManager, healed, 'HealedRunReconcile');
      }
      // Tell the connected boards the card is no longer running — without this the
      // healed task keeps its "busy / undraggable" spinner until a page reload.
      const { staleAgentId: _staleAgentId, ...row } = healed;
      emitTaskUpdated(agentManager, row, { emitAgent: false, stampUpdatedAt: true });
    } catch (err: any) {
      console.error(
        `[WorkflowEngine] stale run-claim heal failed for task="${task.id}":`,
        err.message
      );
    }
  }

  // Run contexts left behind without a run (stopped from the sibling stack or
  // a previous replica, cleared at boot, repos unreadable at run end): link
  // their commits now, up to the moment their run ended.
  try {
    await sweepOrphanCommitRuns(agentManager, await getOrphanCommitRuns(ownEnv));
  } catch (err: any) {
    console.error(`[WorkflowEngine] orphan commit-run sweep failed:`, err.message);
  }
}

/**
 * Recheck all pending conditional transitions and on_enter retries.
 *
 * Called periodically by the task loop. Replaces _recheckConditionalTransitions.
 *
 * @param {Object} agentManager
 */
export async function recheckPendingTransitions(agentManager: AgentManager) {
  // Until the instance knows its environment, getCurrentEnvironment() answers
  // the 'prod' default — a QA replica would recheck (and run) prod's tasks.
  if (!isEnvironmentLocked()) return;

  _evictStaleConditionLocks(agentManager);
  _sweepOnEnterRetryState(agentManager);

  const ownEnv = getCurrentEnvironment();

  // Heal claims whose run is provably gone (throttled). Runs before the
  // active-task pass so a just-healed task is retried this tick, and whatever
  // the board configuration (a claim blocks its agent everywhere).
  const nowTick = Date.now();
  if (nowTick - _lastStaleReconcile >= STALE_RECONCILE_INTERVAL_MS) {
    _lastStaleReconcile = nowTick;
    await reconcileStaleActionRunning(agentManager, ownEnv);
  }

  const boards = await _loadRelevantBoardTransitions();
  if (boards.transMap.size === 0) return;

  // All workflow-bearing tasks (owned AND board-level) come from the DB — the
  // single source of truth. getActiveWorkflowTasks excludes claimed tasks
  // (action_running), which is exactly the cross-replica guard: a task actively
  // executing must not be re-dispatched. Owned and board-level tasks travel one
  // code path.
  const dbTasks = await getActiveWorkflowTasks(ownEnv);
  // The conditions below (idle_agent_available) and the agent selection judge
  // "busy" with the agents claimed anywhere — the sibling stack included.
  if (dbTasks.length > 0) await refreshClaimedAgents();
  for (const dbTask of dbTasks) {
    const agentId = dbTask.agentId || null;
    // `?? null` only normalizes the "unknown id" miss: Map.get answers
    // undefined where the rest of this path speaks null, and _recheckTask
    // treats the two identically.
    const agent = agentId ? (agentManager.agents.get(agentId) ?? null) : null;
    _recheckTask(dbTask, agentId, agent, boards, agentManager, ownEnv);
  }
}

// The cross-replica advisory lock (acquired inside `_dispatchUnderLock`) makes
// the loop above safe when replicas share the DB: every replica sees the same
// DB tasks, and only the lock holder processes a given task.

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Execute a chain of actions sequentially, from `startIdx` (a resume point).
 * Bookkeeping is targeted and guarded by `originalStatus`: once an action moved
 * the task to another column, nothing here writes to it anymore.
 *
 * @returns {{ skipped: boolean }} — whether an action in the chain was skipped
 */
async function _executeActionChain(
  actions: WorkflowAction[],
  task: Task,
  { agentManager, io, ownerId, workflow, originalStatus, onRunClaimed }: ActionContext,
  { transitionIdx = 0, startIdx = 0 }: { transitionIdx?: number; startIdx?: number } = {}
): Promise<{ skipped: boolean }> {
  const status = originalStatus || task.status;
  if (startIdx > 0) {
    console.log(`[WorkflowEngine] Resuming chain from action ${startIdx}/${actions.length}`);
  }

  // Markers of ANOTHER column (a legacy row moved without a reset) must not
  // steer this chain, nor be re-saved by it.
  if (task._pendingOnEnter && task._pendingOnEnter !== status) {
    await _writeChainMarkers(task.id, status, {
      pendingOnEnter: null,
      completedActionIdx: null,
      resumeTransitionIdx: null,
    });
    delete task._pendingOnEnter;
    task.completedActionIdx = null;
  }

  // Record which transition this chain runs before its first action: a process
  // dying mid-action then resumes HERE (the boot re-arm or the claim healer
  // re-arms the column), not from the column's first transition, whose actions
  // already ran.
  if (startIdx === 0 && actions.length > 0) {
    await _writeChainMarkers(task.id, status, {
      completedActionIdx: -1,
      resumeTransitionIdx: transitionIdx,
    });
  }

  let hadSkippedAction = false;

  for (let i = startIdx; i < actions.length; i++) {
    const action = actions[i];

    const result: ActionResult = await executeAction(action, task, {
      agentManager,
      io,
      ownerId,
      workflow,
      onRunClaimed,
    });

    if (result.error) {
      // Action failed with an error — mark task as error and stop chain.
      // The task stays in its originating column (via errorFromStatus) and
      // appears in red. markTaskError guarantees errorFromStatus stays valid
      // even when the task was already errored or the workflow was edited.
      console.log(
        `[WorkflowEngine] Action ${i} errored: ${result.message} — setting task to error`
      );
      await persistTaskError(agentManager, task.id, result.message, {
        by: 'workflow',
        mode: action.mode || null,
        actionIndex: i,
        workflow,
        actionType: action.type,
      });
      task.status = 'error';
      break;
    }

    if (result.skipped) {
      // Action could not run (no agent, lock held, etc.) — flag for retry, but
      // only while the task is still in this column: a task the run moved (or the
      // user moved during the run) belongs to the new column's own entry, and
      // this chain's index would make it skip actions there.
      hadSkippedAction = true;
      // Persist the resume point even when the FIRST action is skipped (-1 →
      // resume from 0): it survives a restart and lets recheckPendingTransitions
      // resume the interrupted chain in this very transition.
      const flagged = await _writeChainMarkers(task.id, status, {
        pendingOnEnter: status,
        completedActionIdx: i - 1,
        resumeTransitionIdx: transitionIdx,
      });
      console.log(
        `[WorkflowEngine] Action ${i} skipped (${result.reason})${flagged ? ' — flagged for retry' : ' — task left the column, not flagged'}`
      );
      const fresh = await getTaskById(task.id);
      if (fresh) task.status = fresh.status;
      break;
    }

    if (result.executed) {
      // Track completed action index for chain resume (after a restart — the
      // boot re-arm picks up a numeric index); the retry marker is consumed.
      await _writeChainMarkers(task.id, status, {
        pendingOnEnter: null,
        completedActionIdx: i,
        resumeTransitionIdx: transitionIdx,
      });
      if (agentManager._onEnterRetry) {
        // Clear retry counter on success
        agentManager._onEnterRetry.delete(`${task.agentId}:${task.id}`);
      }

      // Sync task state from the DB (agent may have changed it)
      const freshTask = await getTaskById(task.id);
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

    // Stop chain if status changed (change_status, or a run_agent action whose
    // agent moved the task via update_task — e.g. a decide that executed work
    // and then advanced the card to its final column).
    if (result.statusChanged || task.status !== status) {
      console.log(
        `[WorkflowEngine] Task "${task.id}" status changed to "${task.status}" — stopping chain`
      );
      break;
    }
  }

  // The chain ran to its end (or left the column): drop its resume point. A
  // skipped chain keeps it for the retry. Guarded — a moved task's markers
  // belong to its new column.
  if (!hadSkippedAction) {
    await _writeChainMarkers(task.id, status, {
      pendingOnEnter: null,
      completedActionIdx: null,
      resumeTransitionIdx: null,
    });
    delete task._pendingOnEnter;
    task.completedActionIdx = null;
  }

  return { skipped: hadSkippedAction };
}

/**
 * Auto-assign a task to an agent based on the column's autoAssignRole config.
 * Never an agent already on another active card (or running anything): the
 * engine does not put one agent on two in-progress tasks. Awaited and targeted.
 */
async function _autoAssignByColumn(
  task: Task,
  workflow: WorkflowConfig,
  agentManager: AgentManager,
  ownerId: string | null,
  _io: AgentManager['io']
) {
  const currentColumn = workflow.columns?.find(c => c.id === task.status);
  const colIndex = workflow.columns?.findIndex(c => c.id === task.status) ?? -1;
  const isFirstOrLast = colIndex === 0 || colIndex === (workflow.columns?.length || 0) - 1;

  if (!currentColumn?.autoAssignRole || isFirstOrLast) return;

  // Precompute owned-task counts from the DB for the (sync) load-balancer.
  const [tasksByAgent, unavailable] = await Promise.all([
    agentManager._tasksByAgentMap(),
    getActiveAssigneeIds(task.id, {
      boardId: task.boardId || null,
      environment: task.environment || null,
    }),
    refreshClaimedAgents(),
  ]);
  const autoAgent = findAgentForAssignment(
    agentManager.agents,
    currentColumn.autoAssignRole,
    ownerId,
    (agentId: any) => tasksByAgent.get(agentId) || [],
    task.id,
    task.boardId || null,
    null,
    unavailable
  ) as any;

  if (autoAgent && task.assignee !== autoAgent.id) {
    console.log(
      `[WorkflowEngine] Auto-assign: "${(task.text || '').slice(0, 60)}" → "${autoAgent.name}" (role: ${currentColumn.autoAssignRole})`
    );
    const updated = await updateTaskFields(
      task.id,
      {
        assignee: autoAgent.id,
        // Record history for consistency with other assignment paths
        historyAppend: [
          {
            status: task.status,
            at: new Date().toISOString(),
            by: 'workflow',
            type: 'reassign',
            assignee: autoAgent.id,
          },
        ],
      },
      { expect: { status: task.status } }
    );
    if (updated) {
      task.assignee = autoAgent.id;
      emitTaskUpdated(agentManager, { ...updated }, { emitAgent: false });
    }
  }
}
