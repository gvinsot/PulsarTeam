/**
 * ActionExecutor — executes individual workflow actions.
 *
 * Each action type (run_agent, change_status, assign_agent, assign_agent_individual)
 * has a dedicated handler.  The `run_agent` handler further dispatches to mode-specific
 * prompt builders (refine, execute, decide, title, set_type).
 *
 * This module performs I/O (sends messages to agents, saves to DB) but does NOT
 * own the workflow orchestration logic — that stays in WorkflowEngine.
 */

import { ActionType, AgentMode, columnExists } from './taskStateMachine.js';
import { findAgentByRole, findAgentForAssignment, acquireLock, releaseLock, markAgentBusy, clearAgentBusy } from './agentSelector.js';
import { markTaskError, isUserStopError } from './taskErrors.js';
import { saveTaskToDb, updateTaskExecutionStatus } from '../database.js';
import { buildRepoCloneUrl } from '../repoUrl.js';
import { getGitHubCredentialsForAgent } from '../../routes/github.js';
import { isCliRunner } from '../runners.js';

async function bindAgentRunner(agentManager, agent) {
  if (!agentManager.executionManager?.bindAgent || !agent?.id) return;
  const llmConfig = agentManager.resolveLlmConfig?.(agent) || {};
  const providerType = agent.runner || (llmConfig.managesContext ? 'claudecode' : 'sandbox');
  let gitCreds = null;
  try {
    gitCreds = await getGitHubCredentialsForAgent(agent.id, agent.boardId || null);
  } catch {
    gitCreds = null;
  }
  agentManager.executionManager.bindAgent(agent.id, providerType, {
    ownerId: agent.ownerId || null,
    gitCredentials: gitCreds,
    permissions: agent.permissions || null,
    llmConfig: agent.llmConfigId ? llmConfig : null,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Emit task:updated through the agentManager so it reaches the user's socket room.
 * Enriches with assigneeName/assigneeIcon for the frontend.
 */
function _emitTaskUpdated(agentManager, agentId, task) {
  // Stamp updatedAt so the frontend's timestamp-based merge logic preserves
  // this update over stale loadTasks() responses (same pattern as setTaskStatus).
  task.updatedAt = new Date().toISOString();
  if (task.assignee) {
    const assigneeAgent = agentManager.agents.get(task.assignee);
    task.assigneeName = assigneeAgent?.name || null;
    task.assigneeIcon = assigneeAgent?.icon || null;
  } else {
    task.assigneeName = null;
    task.assigneeIcon = null;
  }
  agentManager._emit('task:updated', { agentId, task });
}

// ── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Format task commits into a readable context block for the agent prompt.
 * Returns an empty string if no commits are associated.
 */
function formatCommitsContext(task) {
  if (!task.commits || task.commits.length === 0) return '';
  const lines = task.commits.map(c => {
    const dateStr = c.date ? ` (${c.date.slice(0, 16).replace('T', ' ')})` : '';
    return `- ${c.hash.slice(0, 8)}: ${c.message || '(no message)'}${dateStr}`;
  });
  return `\nAssociated commits:\n${lines.join('\n')}\n`;
}

function buildTitlePrompt(description) {
  return `Generate a short, concise title (max 20 words) for the following task description. Reply with ONLY the title, nothing else.\n\n${description}`;
}

function buildSetTypePrompt(description) {
  return `Classify the following task into exactly one type. The possible types are: bug, feature, technical, improvement, documentation, other.\n\nReply with ONLY the type (a single word, lowercase), nothing else.\n\nTask:\n${description}`;
}

function buildRefinePrompt(task, instructions) {
  return `Refine the following task:\n\nTask: ${task.text}\n${task.project ? `Project: ${task.project}\n` : ''}\n${instructions}\n\nReply ONLY with the improved task description.`;
}

function buildInstructionsPrompt(task, instructions, columns) {
  const columnList = columns?.length
    ? `\nValid statuses (column IDs): ${columns.map(c => c.id).join(', ')}`
    : '';
  const commits = formatCommitsContext(task);
  return `You have been assigned instructions for the following task.

Task ID: ${task.id}
Task title: ${task.text}
Current status: ${task.status}${columnList}
${task.error ? `Previous error: ${task.error}\n` : ''}${commits}
Instructions:
${instructions}`;
}

function buildExecutePrompt(task) {
  const commits = formatCommitsContext(task);
  // Note: the "explore the project structure first" hint used to live at the
  // bottom of this prompt, but it was visible to the user as if it were part
  // of the task description. The hint is now injected as a system-context
  // note in chat.ts when messageMeta indicates execute mode (see
  // _buildSystemPrompt / sendMessage), so it stays out of the user-facing
  // prompt and out of the persisted conversation history.
  return `You have been assigned the following task to execute.

Task ID: ${task.id}
Task: ${task.text}
${task.error ? `Previous error: ${task.error}\n` : ''}${commits}`;
}

/**
 * Strip tool calls (@tool(...) and <tool_call> blocks) from an LLM response
 * so that only the descriptive text remains.
 */
export function stripToolCalls(text) {
  if (!text) return text;
  let cleaned = text.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '');
  const TOOL_NAMES = [
    'read_file', 'write_file', 'append_file', 'list_dir', 'search_files',
    'run_command', 'report_error', 'mcp_call',
    'update_task', 'list_my_tasks', 'list_projects', 'check_status',
    'task_execution_complete', 'get_action_status', 'build_stack', 'test_stack',
    'deploy_stack', 'list_stacks', 'list_containers', 'list_computers',
    'search_logs', 'get_log_metadata',
  ];
  const toolPattern = new RegExp(`@(${TOOL_NAMES.join('|')})\\s*\\(`, 'gi');
  const removals = [];
  let match;
  while ((match = toolPattern.exec(cleaned)) !== null) {
    const start = match.index;
    const argsStart = start + match[0].length;
    let depth = 1;
    let i = argsStart;
    while (i < cleaned.length && depth > 0) {
      if (cleaned[i] === '(') depth++;
      else if (cleaned[i] === ')') depth--;
      i++;
    }
    if (depth === 0) removals.push({ start, end: i });
  }
  for (let r = removals.length - 1; r >= 0; r--) {
    cleaned = cleaned.slice(0, removals[r].start) + cleaned.slice(removals[r].end);
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

// ── Result types ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ActionResult
 * @property {boolean}  executed   - true if the action ran to completion
 * @property {boolean} skipped    - true if the action was skipped (no agent, lock held, etc.)
 * @property {string}  [reason]   - why it was skipped
 * @property {boolean} [error]    - true if an error occurred
 * @property {string}  [message]  - error message
 * @property {boolean} [statusChanged] - true if a change_status action moved the task
 */

// ── Main executor ───────────────────────────────────────────────────────────

/**
 * Execute a single workflow action.
 *
 * @param {Object} action        - the action config from the workflow transition
 * @param {Object} task          - the task being processed (with agentId, boardId, etc.)
 * @param {Object} context       - { agentManager, io, ownerId, workflow }
 * @returns {Promise<ActionResult>}
 */
export async function executeAction(action, task, context) {
  switch (action.type) {
    case ActionType.ASSIGN_AGENT:
      return executeAssignAgent(action, task, context);

    case ActionType.ASSIGN_AGENT_INDIVIDUAL:
      return executeAssignAgentIndividual(action, task, context);

    case ActionType.CHANGE_STATUS:
      return executeChangeStatus(action, task, context);

    case ActionType.RUN_AGENT:
      return executeRunAgent(action, task, context);

    default:
      console.warn(`[ActionExecutor] Unknown action type: ${action.type}`);
      return { executed: false, skipped: true, reason: `unknown-action-type: ${action.type}` };
  }
}

// ── assign_agent ────────────────────────────────────────────────────────────

function executeAssignAgent(action, task, { agentManager, io, ownerId }) {
  const agent = findAgentForAssignment(
    agentManager.agents,
    action.role,
    ownerId,
    (agentId: any) => agentManager._getAgentTasks(agentId),
    task.id,
    task.boardId || null,
    task.repoFullName || task.project || null
  ) as any;

  if (!agent) {
    console.log(`[ActionExecutor] assign_agent: no agent with role "${action.role}" — skipping task="${task.id}"`);
    return { executed: false, skipped: true, reason: 'no-agent-for-role' };
  }

  const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (actualTask) {
    actualTask.assignee = agent.id;
    if (!actualTask.history) actualTask.history = [];
    actualTask.history.push({
      status: actualTask.status,
      at: new Date().toISOString(),
      by: 'workflow',
      type: 'reassign',
      assignee: agent.id,
    });
    task.assignee = agent.id;
    const assignPayload = { ...actualTask, agentId: task.agentId };
    const assignSave = saveTaskToDb({ ...actualTask, agentId: task.agentId });
    Promise.resolve(assignSave)
      .catch(() => {})
      .then(() => _emitTaskUpdated(agentManager, task.agentId, assignPayload));
    console.log(`[ActionExecutor] assign_agent: assigned to "${agent.name}" (role: ${action.role}) task="${task.id}"`);
  }

  return { executed: true };
}

// ── assign_agent_individual ─────────────────────────────────────────────────

function executeAssignAgentIndividual(action, task, { agentManager, io }) {
  const targetAgentId = action.agentId || null;
  const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (actualTask) {
    const prev = actualTask.assignee || null;
    // No-op guard: avoid clobbering an assignee set by a concurrent run_agent
    // action and spamming task:updated events when the target matches current.
    if (prev === targetAgentId) {
      const targetName = targetAgentId ? (agentManager.agents.get(targetAgentId)?.name || targetAgentId) : 'none';
      console.log(`[ActionExecutor] assign_agent_individual: "${targetName}" — no change, skipping`);
      return { executed: false, skipped: true, reason: 'no-change' };
    }
    actualTask.assignee = targetAgentId;
    if (!actualTask.history) actualTask.history = [];
    actualTask.history.push({
      status: actualTask.status,
      at: new Date().toISOString(),
      by: 'workflow',
      type: 'reassign',
      assignee: targetAgentId,
    });
    task.assignee = targetAgentId;
    const indivPayload = { ...actualTask, agentId: task.agentId };
    const indivSave = saveTaskToDb({ ...actualTask, agentId: task.agentId });
    Promise.resolve(indivSave)
      .catch(() => {})
      .then(() => _emitTaskUpdated(agentManager, task.agentId, indivPayload));
    const targetName = targetAgentId ? (agentManager.agents.get(targetAgentId)?.name || targetAgentId) : 'none';
    console.log(`[ActionExecutor] assign_agent_individual: "${prev || 'none'}" → "${targetName}"`);
  }
  return { executed: true };
}

// ── change_status ───────────────────────────────────────────────────────────

function executeChangeStatus(action, task, { agentManager, workflow }) {
  let target = action.target;

  // Resolve __next__ to the column immediately after the current one
  if (target === '__next__') {
    const cols = workflow?.columns || [];
    const curIdx = cols.findIndex(c => c.id === task.status);
    if (curIdx === -1 || curIdx >= cols.length - 1) {
      console.log(`[ActionExecutor] change_status: __next__ — no column after "${task.status}" — skipping`);
      return { executed: false, skipped: true, reason: 'no-next-column' };
    }
    target = cols[curIdx + 1].id;
  }

  if (!target || target === task.status) {
    return { executed: false, skipped: true, reason: 'same-status' };
  }

  // Validate target column exists
  if (!columnExists(workflow, target)) {
    console.warn(`[ActionExecutor] change_status: target "${target}" does not exist — skipping`);
    return { executed: false, skipped: true, reason: 'column-not-found' };
  }

  // Check if the real task is already at the target status (concurrent chain
  // may have moved it). This prevents duplicate "stopping chain" log spam and
  // avoids triggering a redundant _checkAutoRefine for an already-processed column.
  const realTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (realTask && realTask.status === target) {
    console.log(`[ActionExecutor] change_status: task="${task.id}" already at "${target}" — no-op`);
    return { executed: true, statusChanged: true };
  }

  // Clean up chain resume state before moving
  const taskBeforeMove = realTask || agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (taskBeforeMove) {
    delete taskBeforeMove._completedActionIdx;
    taskBeforeMove.completedActionIdx = null;
    delete taskBeforeMove._pendingOnEnter;
  }

  console.log(`[ActionExecutor] change_status: "${task.status}" → "${target}" task="${task.id}"`);
  const result = agentManager.setTaskStatus(task.agentId, task.id, target, {
    skipAutoRefine: false,
    by: 'workflow',
  });

  if (!result) {
    console.warn(`[ActionExecutor] change_status: blocked by guard`);
    return { executed: false, skipped: true, reason: 'guard-blocked' };
  }

  return { executed: true, statusChanged: true };
}

// ── run_agent ───────────────────────────────────────────────────────────────

/**
 * Execute a run_agent action. This is the main entry point that replaces the
 * old monolithic processTransition function.
 */
async function executeRunAgent(action, task, { agentManager, io, ownerId, workflow }) {
  const mode = action.mode || AgentMode.EXECUTE;
  const role = action.role || '';
  const instructions = action.instructions || '';
  const columns = workflow?.columns || [];

  const lockKey = `${task.agentId}:${task.id}:${mode}`;
  if (!acquireLock(lockKey)) {
    console.log(`[ActionExecutor] run_agent: lock held for "${task.text?.slice(0, 60)}" — skipping`);
    return { executed: false, skipped: true, reason: 'lock-held' };
  }

  // Find agent for this role (scoped to the task's board, preferring agents
  // already on the task's repo so we don't have to project-switch every run).
  const agent = findAgentByRole(
    agentManager.agents,
    role,
    ownerId,
    (agentId: any) => agentManager._getAgentTasks(agentId),
    task.boardId || null,
    task.repoFullName || task.project || null
  ) as any;

  if (!agent) {
    console.log(`[ActionExecutor] run_agent: no idle agent for role "${role}" — task stays pending`);
    releaseLock(lockKey);
    return { executed: false, skipped: true, reason: 'no-idle-agent' };
  }

  markAgentBusy(agent.id);

  // Wrap everything after markAgentBusy in try/finally so the busy flag is
  // always cleared — even if task setup or project-switch throws unexpectedly.
  let actualTask;
  let execStartMsgIdx;
  let execStartedAt;
  try {

  // Set actionRunning flag on the task
  actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (actualTask) {
    actualTask.actionRunning = true;
    actualTask.actionRunningAgentId = agent.id;
    actualTask.actionRunningMode = mode;
    if (!actualTask.startedAt) actualTask.startedAt = new Date().toISOString();
    if (actualTask.assignee !== agent.id) {
      actualTask.assignee = agent.id;
      if (!actualTask.history) actualTask.history = [];
      actualTask.history.push({
        status: actualTask.status,
        at: new Date().toISOString(),
        by: 'workflow',
        type: 'reassign',
        assignee: agent.id,
      });
    }
    // Defer emit until after DB save so that any loadTasks() triggered by the
    // concurrent agent:updated event reads the committed row with actionRunning=true.
    // Without this, the frontend's loadTasks() can overwrite the real-time update
    // with stale DB data (same pattern as setTaskStatus in tasks.js).
    const taskPayload = { ...actualTask, agentId: task.agentId };
    const savePromise = saveTaskToDb({ ...actualTask, agentId: task.agentId });
    Promise.resolve(savePromise)
      .catch(() => {})
      .then(() => _emitTaskUpdated(agentManager, task.agentId, taskPayload));
  }

  // Auto-switch agent to the task's repo if needed.
  // Tasks carry two related fields: `repoFullName` ("owner/repo", set on
  // creation/by GitHub sync) and `project` (set/edited via the task UI). We
  // honor whichever is present so the agent ends up working on the same repo
  // the task is about \u2014 not whatever it happened to be on last.
  const taskRepo = task.repoFullName || task.project || null;
  if (taskRepo && taskRepo !== agent.project) {
    console.log(`[ActionExecutor] Switching "${agent.name}" from "${agent.project || '(none)'}" to repo "${taskRepo}"`);
    try {
      // 1. Switch conversation context (saves/restores history)
      if (agentManager._switchProjectContext) {
        agentManager._switchProjectContext(agent, agent.project, taskRepo);
      }
      // 2. Switch execution environment (coder-service / sandbox)
      if (agentManager.executionManager) {
        const gitUrl = task.repoHtmlUrl || buildRepoCloneUrl(taskRepo);
        if (gitUrl) {
          const gitCreds = await getGitHubCredentialsForAgent(agent.id, agent.boardId || null);
          await agentManager.executionManager.switchProject(agent.id, taskRepo, gitUrl, gitCreds);
        } else {
          console.warn(`[ActionExecutor] No git URL for repo "${taskRepo}" — execution env may not match`);
        }
        // 3. Verify execution environment matches
        const envProject = agentManager.executionManager.getProject(agent.id);
        if (envProject && envProject !== taskRepo) {
          throw new Error(`Execution environment is on "${envProject}" but task requires "${taskRepo}"`);
        }
      }
      agent.project = taskRepo;
    } catch (switchErr) {
      console.error(`[ActionExecutor] Project switch failed for "${agent.name}": ${switchErr.message}`);
      releaseLock(lockKey);
      clearAgentBusy(agent.id);
      const switchErrTimestamp = new Date().toISOString();
      if (actualTask) {
        actualTask.actionRunning = false;
        delete actualTask.actionRunningAgentId;
        delete actualTask.actionRunningMode;
        actualTask.error = `Project switch failed: ${switchErr.message}`;
        if (!actualTask.history) actualTask.history = [];
        actualTask.history.push({
          status: actualTask.status,
          at: switchErrTimestamp,
          by: agent.name || 'workflow',
          type: 'error',
          error: `Project switch failed: ${switchErr.message}`,
          actionMode: mode,
        });
        const errPayload = { ...actualTask, agentId: task.agentId };
        const errSave = saveTaskToDb({ ...actualTask, agentId: task.agentId });
        Promise.resolve(errSave)
          .catch(() => {})
          .then(() => _emitTaskUpdated(agentManager, task.agentId, errPayload));
      }
      agentManager._emit('agent:error:report', {
        agentId: agent.id,
        agentName: agent.name,
        project: task.project || null,
        description: `[System Error] Project switch failed for "${agent.name}": ${switchErr.message}`,
        timestamp: switchErrTimestamp,
        isSystemError: true,
        taskId: task.id,
      });
      return { executed: false, error: true, message: `Project switch failed: ${switchErr.message}` };
    }
  }

  execStartMsgIdx = (agent.conversationHistory || []).length;
  execStartedAt = new Date().toISOString();

    let result;
    switch (mode) {
      case AgentMode.TITLE:
        result = await _runTitleMode(agent, task, { agentManager, io, execStartMsgIdx, execStartedAt });
        break;
      case AgentMode.SET_TYPE:
        result = await _runSetTypeMode(agent, task, { agentManager, io, execStartMsgIdx, execStartedAt });
        break;
      case AgentMode.REFINE:
        result = await _runRefineMode(agent, task, instructions, { agentManager, io, execStartMsgIdx, execStartedAt });
        break;
      case AgentMode.DECIDE:
        result = await _runDecideMode(agent, task, instructions, columns, { agentManager, io, execStartMsgIdx, execStartedAt });
        break;
      case AgentMode.EXECUTE:
        result = await _runExecuteMode(agent, task, instructions, columns, { agentManager, io, execStartMsgIdx, execStartedAt });
        break;
      default:
        console.warn(`[ActionExecutor] Unknown mode: ${mode}`);
        result = { executed: false, skipped: true, reason: `unknown-mode: ${mode}` };
    }

    return result;
  } catch (err) {
    // Distinguish a user-triggered Stop from a real failure. stopAgent() aborts
    // the in-flight stream and llmProviders throws "Agent stopped by user",
    // which propagates up here. Without this check, a user pressing Stop on a
    // running workflow action would flip the task to status=error — and if
    // that errorFromStatus path ever clobbers itself, the task disappears
    // from the board entirely. stopAgent already marked the task as stopped
    // and cleaned actionRunning flags, so we just log + return cleanly.
    if (isUserStopError(err)) {
      console.log(`[ActionExecutor] run_agent stopped by user for "${task.text?.slice(0, 60)}" (mode=${mode}) — not marking as error`);
      agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, false, mode);
      // Belt-and-suspenders: ensure executionStatus=stopped is durable even
      // if stopAgent's iteration missed this task (e.g. race between assign
      // and stop). The in-memory 'stopped' signal is set by stopAgent itself.
      try { await updateTaskExecutionStatus(task.id, 'stopped'); } catch { /* best-effort */ }
      return { executed: false, skipped: true, reason: 'user-stop' };
    }

    console.error(`[ActionExecutor] run_agent error for "${task.text?.slice(0, 60)}":`, err.message);
    // Save error execution log
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, false, mode);
    // Emit system error report so leader + frontend are notified
    const errorTimestamp = new Date().toISOString();
    agentManager._emit('agent:error:report', {
      agentId: agent.id,
      agentName: agent.name,
      project: agent.project || task.project || null,
      description: `[System Error] Workflow action "${mode}" failed for task "${task.text?.slice(0, 100)}": ${err.message}`,
      timestamp: errorTimestamp,
      isSystemError: true,
      taskId: task.id,
    });
    // Log detailed error in task history and set error status.
    // markTaskError guarantees the task stays visible on the board even if
    // it was already errored or if the prior status no longer exists in the
    // workflow (renamed/deleted columns).
    try {
      if (actualTask) {
        const mutated = markTaskError(actualTask, err.message, {
          by: agent.name || 'workflow',
          mode,
          agentName: agent.name,
          workflow,
        });
        if (mutated) {
          await saveTaskToDb({ ...actualTask, agentId: task.agentId });
          agentManager._emit('task:updated', { agentId: task.agentId, task: { ...actualTask, agentId: task.agentId } });
        }
      } else {
        agentManager.setTaskStatus(task.agentId, task.id, 'error', { skipAutoRefine: true, by: 'workflow' });
      }
    } catch (e) {
      console.error(`[ActionExecutor] Failed to set error status:`, e.message);
    }
    return { executed: false, error: true, message: err.message };
  } finally {
    releaseLock(lockKey);
    clearAgentBusy(agent.id);
    let cleanupMutated = false;
    // Clear actionRunning flag (in-memory only — the chain's next action or
    // cleanup will persist the final state to DB, avoiding a race where this
    // fire-and-forget save could overwrite the chain's change_status save).
    if (actualTask && actualTask.actionRunning) {
      actualTask.actionRunning = false;
      delete actualTask.actionRunningAgentId;
      delete actualTask.actionRunningMode;
      cleanupMutated = true;
    }
    // Non-execute modes (decide, refine, title, set_type) should not leave the
    // agent as the permanent assignee — clear it so the task loop won't send
    // the task to the wrong agent if the next workflow action is delayed.
    if (mode !== AgentMode.EXECUTE && actualTask && actualTask.assignee === agent.id) {
      actualTask.assignee = null;
      cleanupMutated = true;
    }
    // Notify the UI that the action is no longer running. Without this, the
    // frontend keeps the task card in "spinner / undraggable" state until a
    // page refresh, because no later event in the chain may emit a fresh
    // task:updated payload (e.g. when the chain has no change_status action
    // after run_agent). We deliberately do NOT save here — the chain's next
    // action or its final save persists the cleared flags. The emit alone is
    // enough for the realtime UI, since the frontend merges by timestamp and
    // any subsequent emit (change_status, agent:updated → loadTasks) wins.
    if (cleanupMutated && actualTask) {
      _emitTaskUpdated(agentManager, task.agentId, { ...actualTask, agentId: task.agentId });
    }
  }
}

// ── Mode-specific handlers ──────────────────────────────────────────────────

async function _runTitleMode(agent, task, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const maxLen = agent.contextLength || 4000;
  const description = (task.text || '').slice(0, maxLen);
  const prompt = buildTitlePrompt(description);

  console.log(`[ActionExecutor] title: generating for "${task.text?.slice(0, 60)}" via ${agent.name}`);

  try {
    const result = await agentManager.sendMessage(agent.id, prompt, () => {});
    const title = (result || '').trim().replace(/^["']|["']$/g, '');
    if (title) {
      agentManager.updateTaskTitle(task.agentId, task.id, title);
      console.log(`[ActionExecutor] title: "${title}"`);
    }
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'title');
  } catch (err) {
    console.error(`[ActionExecutor] title failed:`, err.message);
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, false, 'title');
  } finally {
    agentManager.wsEmitter.agentUpdated(agent.id);
  }

  return { executed: true };
}

async function _runSetTypeMode(agent, task, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const maxLen = agent.contextLength || 4000;
  const description = (task.text || '').slice(0, maxLen);
  const prompt = buildSetTypePrompt(description);

  console.log(`[ActionExecutor] set_type: classifying "${task.text?.slice(0, 60)}" via ${agent.name}`);

  try {
    const result = await agentManager.sendMessage(agent.id, prompt, () => {});
    const rawType = (result || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    const VALID_TYPES = ['bug', 'feature', 'technical', 'improvement', 'documentation', 'other'];
    const taskType = VALID_TYPES.includes(rawType) ? rawType : 'other';
    agentManager.updateTaskType(task.agentId, task.id, taskType, agent.name);
    console.log(`[ActionExecutor] set_type: "${taskType}"`);
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'set_type');
  } catch (err) {
    console.error(`[ActionExecutor] set_type failed:`, err.message);
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, false, 'set_type');
  } finally {
    agentManager.wsEmitter.agentUpdated(agent.id);
  }

  return { executed: true };
}

async function _runRefineMode(agent, task, instructions, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const prompt = buildRefinePrompt(task, instructions);
  console.log(`[ActionExecutor] refine: "${task.text?.slice(0, 60)}" via ${agent.name}`);

  let fullResponse = '';

  agentManager.wsEmitter.streamStart(agent.id);
  try {
    const workflowMeta = { type: 'workflow-action', mode: 'refine', taskId: task.id };
    const result = await agentManager.sendMessage(
      agent.id,
      `[Auto-Transition] ${prompt}`,
      (chunk) => {
        fullResponse += chunk;
        agentManager.wsEmitter.streamChunk(agent.id, chunk);
        agentManager.wsEmitter.thinking(agent.id);
      },
      0,
      workflowMeta
    );

    const response = (result?.content || fullResponse).trim();
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'refine');

    if (response) {
      const cleaned = stripToolCalls(response);
      if (cleaned) agentManager.updateTaskText(task.agentId, task.id, cleaned);
    }
  } finally {
    agentManager.wsEmitter.streamEnd(agent.id);
    agentManager.wsEmitter.agentUpdated(agent.id);
  }

  return { executed: true };
}

// A decide action that never yields a decision used to retry forever (the
// WorkflowEngine re-fires on_enter with a progressive cooldown capped at 2s).
// For agents that structurally CAN'T decide — e.g. a CLI runner with no
// swarm_api MCP, so no update_task tool — this looped indefinitely and
// invisibly. Cap the no-decision retries and then fail the task with an
// actionable error instead of spinning.
const MAX_DECIDE_NO_DECISION = 4;

async function _runDecideMode(agent, task, instructions, columns, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  if (!instructions) {
    console.log(`[ActionExecutor] decide: no instructions — skipping`);
    return { executed: false, skipped: true, reason: 'no-instructions' };
  }

  const prompt = buildInstructionsPrompt(task, instructions, columns);
  console.log(`[ActionExecutor] decide: "${task.text?.slice(0, 60)}" via ${agent.name}`);

  // Snapshot task state so we can detect whether the agent actually made a
  // decision (moved the task to a new status, or appended details). Detection
  // is by task mutation — which works whether the agent used the @update_task
  // text tool (LLM-chat agents) or the update_task MCP tool (CLI runners).
  const beforeTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  const beforeStatus = beforeTask?.status ?? task.status;
  const beforeTextLen = (beforeTask?.text || '').length;

  let fullResponse = '';

  // CLI runners drive their interactive PTY (visible in the terminal tab) and
  // signal via their MCP tools — never the headless sendMessage path, which
  // spawns a separate invisible claude process that also conflicts with the
  // shared PTY. The agent's decision lands as a task mutation (update_task MCP)
  // which the before/after comparison below detects.
  if (isCliRunner(agent) && agentManager.executionManager?.sendTerminalInput) {
    console.log(`[ActionExecutor] decide: injecting prompt into CLI terminal for "${agent.name}" (status=${agent.status})`);
    await bindAgentRunner(agentManager, agent);
    await agentManager.executionManager.sendTerminalInput(agent.id, prompt, { submit: true });
    const waitResult = await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, task.text, {
      terminalDriven: true,
    });
    if (waitResult === 'error') {
      const authError = agentManager._consumeTaskAuthError?.(task.id);
      throw new Error(authError || 'Claude Code CLI ended in an authentication or runtime error');
    }
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'decide');
  } else {
    agentManager.wsEmitter.streamStart(agent.id);
    try {
      const workflowMeta = { type: 'workflow-action', mode: 'decide', taskId: task.id };
      await agentManager.sendMessage(
        agent.id,
        prompt,
        (chunk) => {
          fullResponse += chunk;
          agentManager.wsEmitter.streamChunk(agent.id, chunk);
          agentManager.wsEmitter.thinking(agent.id);
        },
        0,
        workflowMeta
      );

      agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'decide');
    } finally {
      agentManager.wsEmitter.streamEnd(agent.id);
      agentManager.wsEmitter.agentUpdated(agent.id);
    }
  }

  // Verify the agent actually made a decision: status changed OR details appended.
  const afterTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  const afterStatus = afterTask?.status ?? task.status;
  const afterTextLen = (afterTask?.text || '').length;
  const decided = afterStatus !== beforeStatus || afterTextLen !== beforeTextLen;

  if (!decided) {
    // Count consecutive no-decision attempts on the live in-memory task so a
    // structurally-stuck agent fails fast instead of retrying forever.
    const liveTask = afterTask || beforeTask;
    const attempts = ((liveTask?._decideNoDecisionCount as number) || 0) + 1;
    if (liveTask) liveTask._decideNoDecisionCount = attempts;

    if (attempts >= MAX_DECIDE_NO_DECISION) {
      if (liveTask) delete liveTask._decideNoDecisionCount;
      const why = isCliRunner(agent)
        ? `Agent "${agent.name}" (CLI runner) produced no decision after ${attempts} attempts. It likely has no tool to update the task — assign the Swarm API MCP (update_task) to this agent, or use an "execute" action instead of "decide".`
        : `Agent "${agent.name}" produced no @update_task call after ${attempts} attempts.`;
      console.error(`[ActionExecutor] decide: ${why} — failing task="${task.id}"`);
      // Throw so executeRunAgent's catch marks the task error (visible on the
      // board, with the message) and stops the retry loop.
      throw new Error(`Decide action failed: ${why}`);
    }

    console.warn(`[ActionExecutor] decide: agent "${agent.name}" produced no decision for task="${task.id}" (attempt ${attempts}/${MAX_DECIDE_NO_DECISION}) — flagging for retry`);
    return { executed: false, skipped: true, reason: 'no-decision' };
  }

  // Decision made — clear the no-decision counter.
  const liveTask = afterTask || beforeTask;
  if (liveTask?._decideNoDecisionCount) delete liveTask._decideNoDecisionCount;
  console.log(`[ActionExecutor] decide: completed for task="${task.id}" "${task.text?.slice(0, 60)}"`);
  return { executed: true };
}

async function _runExecuteMode(agent, task, instructions, columns, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const hasInstructions = !!instructions;
  const prompt = hasInstructions ? buildInstructionsPrompt(task, instructions, columns) : buildExecutePrompt(task);
  console.log(`[ActionExecutor] execute: "${task.text?.slice(0, 60)}" via ${agent.name}${hasInstructions ? ' (with instructions)' : ''}`);

  let fullResponse = '';

  // CLI runners always execute inside their interactive PTY — never the
  // headless sendMessage fallback. Even if agent.status flipped to "busy"
  // (e.g. console activity from an attached browser terminal), we still drive
  // the same shared PTY: the runner blocks the inject call until the TUI is
  // back at an input-ready prompt (the PTY-is-free gate). Falling back to
  // headless here would create an invisible session the user can't see in the
  // terminal tab and would split the task's context across two backends.
  if (isCliRunner(agent) && agentManager.executionManager?.sendTerminalInput) {
    console.log(`[ActionExecutor] execute: injecting task prompt into CLI terminal for "${agent.name}" (status=${agent.status})`);
    await bindAgentRunner(agentManager, agent);
    await agentManager.executionManager.sendTerminalInput(agent.id, prompt, { submit: true });
    const waitResult = await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, task.text, {
      terminalDriven: true,
    });
    // Honor the wait result: a CLI auth failure (or other hard error) must NOT
    // be reported as a successful execution, otherwise the workflow chain
    // advances (e.g. → done/review) over a task that never ran. Throw so
    // executeRunAgent's catch marks the task error + saves the execution log.
    if (waitResult === 'error') {
      const authError = agentManager._consumeTaskAuthError?.(task.id);
      throw new Error(authError || 'Claude Code CLI ended in an authentication or runtime error');
    }
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'execute');
    return { executed: true };
  }

  agentManager.wsEmitter.streamStart(agent.id);
  try {
    const workflowMeta = { type: 'workflow-action', mode: 'execute', taskId: task.id };
    const result = await agentManager.sendMessage(
      agent.id,
      prompt,
      (chunk) => {
        fullResponse += chunk;
        agentManager.wsEmitter.streamChunk(agent.id, chunk);
        agentManager.wsEmitter.thinking(agent.id);
      },
      0,
      workflowMeta
    );

    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'execute');

    // Check if agent completed the task via @task_execution_complete
    const freshTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);

    if (freshTask?._executionCompleted) {
      const comment = freshTask._executionComment || '';
      delete freshTask._executionCompleted;
      delete freshTask._executionComment;
      console.log(`✅ [ActionExecutor] execute: completed immediately${hasInstructions ? ' (with instructions)' : ''}${comment ? ` (${comment.slice(0, 80)})` : ''}`);
    } else if (freshTask && !agentManager._isActiveTaskStatus(freshTask.status)) {
      console.log(`[ActionExecutor] execute: task already moved to "${freshTask.status}"${hasInstructions ? ' (with instructions)' : ''}`);
    } else if (!fullResponse || fullResponse.trim().length === 0) {
      console.warn(`⚠️ [ActionExecutor] execute: "${agent.name}" returned empty response for "${task.text?.slice(0, 60)}" — skipping reminder loop`);
      return { executed: false, skipped: true, reason: 'empty-response' };
    } else {
      console.log(`[ActionExecutor] execute: waiting for task_execution_complete${hasInstructions ? ' (with instructions)' : ''}`);
      await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, task.text);
    }
  } finally {
    agentManager.wsEmitter.streamEnd(agent.id);
    agentManager.wsEmitter.agentUpdated(agent.id);
  }

  return { executed: true };
}
