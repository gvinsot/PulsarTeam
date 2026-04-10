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
import { saveTaskToDb } from '../database.js';
import { getProjectGitUrl } from '../githubProjects.js';

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
${instructions}

RULES:
- Follow the instructions above precisely. Do not take extra actions beyond what is asked.
- MANDATORY: your response MUST contain a call to @update_task(${task.id}, <new_status>) — this is the ONLY way to signal you are done. <new_status> must be one of the valid column IDs listed above (lowercase, exact match). It is acceptable to keep the same status if the instructions only ask you to append details.
- You can append details: @update_task(${task.id}, <new_status>, <details>).
- Do NOT reply with prose only. Do NOT call @task_execution_complete — use @update_task instead.
- Be concise and efficient: execute the instructions, then update the task. Do not explore the codebase unnecessarily.`;
}

function buildExecutePrompt(task) {
  const commits = formatCommitsContext(task);
  return `You have been assigned the following task to execute.

Task ID: ${task.id}
Task: ${task.text}
${task.error ? `Previous error: ${task.error}\n` : ''}${commits}
Start by exploring the project structure.`;
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
    (agentId) => agentManager._getAgentTasks(agentId),
    task.id
  );

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
    const prev = actualTask.assignee;
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
  if (!action.target || action.target === task.status) {
    return { executed: false, skipped: true, reason: 'same-status' };
  }

  // Validate target column exists
  if (!columnExists(workflow, action.target)) {
    console.warn(`[ActionExecutor] change_status: target "${action.target}" does not exist — skipping`);
    return { executed: false, skipped: true, reason: 'column-not-found' };
  }

  // Check if the real task is already at the target status (concurrent chain
  // may have moved it). This prevents duplicate "stopping chain" log spam and
  // avoids triggering a redundant _checkAutoRefine for an already-processed column.
  const realTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (realTask && realTask.status === action.target) {
    console.log(`[ActionExecutor] change_status: task="${task.id}" already at "${action.target}" — no-op`);
    return { executed: true, statusChanged: true };
  }

  // Clean up chain resume state before moving
  const taskBeforeMove = realTask || agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (taskBeforeMove) {
    delete taskBeforeMove._completedActionIdx;
    taskBeforeMove.completedActionIdx = null;
    delete taskBeforeMove._pendingOnEnter;
  }

  console.log(`[ActionExecutor] change_status: "${task.status}" → "${action.target}" task="${task.id}"`);
  const result = agentManager.setTaskStatus(task.agentId, task.id, action.target, {
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

  // Find agent for this role
  const agent = findAgentByRole(
    agentManager.agents,
    role,
    ownerId,
    (agentId) => agentManager._getAgentTasks(agentId)
  );

  if (!agent) {
    console.log(`[ActionExecutor] run_agent: no idle agent for role "${role}" — task stays pending`);
    releaseLock(lockKey);
    return { executed: false, skipped: true, reason: 'no-idle-agent' };
  }

  markAgentBusy(agent.id);

  // Set actionRunning flag on the task
  const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
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

  // Auto-switch agent to task project if needed
  if (task.project && task.project !== agent.project) {
    console.log(`[ActionExecutor] Switching "${agent.name}" from "${agent.project || '(none)'}" to project "${task.project}"`);
    try {
      // 1. Switch conversation context (saves/restores history)
      if (agentManager._switchProjectContext) {
        agentManager._switchProjectContext(agent, agent.project, task.project);
      }
      // 2. Switch execution environment (coder-service / sandbox)
      if (agentManager.executionManager) {
        const gitUrl = await getProjectGitUrl(task.project);
        if (gitUrl) {
          await agentManager.executionManager.switchProject(agent.id, task.project, gitUrl);
        } else {
          console.warn(`[ActionExecutor] No git URL for project "${task.project}" — execution env may not match`);
        }
        // 3. Verify execution environment matches
        const envProject = agentManager.executionManager.getProject(agent.id);
        if (envProject && envProject !== task.project) {
          throw new Error(`Execution environment is on "${envProject}" but task requires "${task.project}"`);
        }
      }
      agent.project = task.project;
    } catch (switchErr) {
      console.error(`[ActionExecutor] Project switch failed for "${agent.name}": ${switchErr.message}`);
      releaseLock(lockKey);
      clearAgentBusy(agent.id);
      if (actualTask) {
        actualTask.actionRunning = false;
        delete actualTask.actionRunningAgentId;
        delete actualTask.actionRunningMode;
        actualTask.error = `Project switch failed: ${switchErr.message}`;
        const errPayload = { ...actualTask, agentId: task.agentId };
        const errSave = saveTaskToDb({ ...actualTask, agentId: task.agentId });
        Promise.resolve(errSave)
          .catch(() => {})
          .then(() => _emitTaskUpdated(agentManager, task.agentId, errPayload));
      }
      return { executed: false, error: true, message: `Project switch failed: ${switchErr.message}` };
    }
  }

  const execStartMsgIdx = (agent.conversationHistory || []).length;
  const execStartedAt = new Date().toISOString();

  try {
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
    console.error(`[ActionExecutor] run_agent error for "${task.text?.slice(0, 60)}":`, err.message);
    // Save error execution log
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, false, mode);
    // Set task to error status
    try {
      agentManager.setTaskStatus(task.agentId, task.id, 'error', { skipAutoRefine: true, by: 'workflow' });
      if (actualTask) {
        actualTask.error = err.message;
        saveTaskToDb({ ...actualTask, agentId: task.agentId });
      }
    } catch (e) {
      console.error(`[ActionExecutor] Failed to set error status:`, e.message);
    }
    return { executed: false, error: true, message: err.message };
  } finally {
    releaseLock(lockKey);
    clearAgentBusy(agent.id);
    // Clear actionRunning flag
    if (actualTask && actualTask.actionRunning) {
      actualTask.actionRunning = false;
      delete actualTask.actionRunningAgentId;
      delete actualTask.actionRunningMode;
      const clearPayload = { ...actualTask, agentId: task.agentId };
      const clearSave = saveTaskToDb({ ...actualTask, agentId: task.agentId });
      Promise.resolve(clearSave)
        .catch(() => {})
        .then(() => _emitTaskUpdated(agentManager, task.agentId, clearPayload));
    }
    // Non-execute modes (decide, refine, title, set_type) should not leave the
    // agent as the permanent assignee — clear it so the task loop won't send
    // the task to the wrong agent if the next workflow action is delayed.
    if (mode !== AgentMode.EXECUTE && actualTask && actualTask.assignee === agent.id) {
      actualTask.assignee = null;
      saveTaskToDb({ ...actualTask, agentId: task.agentId });
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
    agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
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
    agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
  }

  return { executed: true };
}

async function _runRefineMode(agent, task, instructions, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const prompt = buildRefinePrompt(task, instructions);
  console.log(`[ActionExecutor] refine: "${task.text?.slice(0, 60)}" via ${agent.name}`);

  let fullResponse = '';

  io.emit('agent:stream:start', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
  try {
    const workflowMeta = { type: 'workflow-action', mode: 'refine', taskId: task.id };
    const result = await agentManager.sendMessage(
      agent.id,
      `[Auto-Transition] ${prompt}`,
      (chunk) => {
        fullResponse += chunk;
        io.emit('agent:stream:chunk', { agentId: agent.id, agentName: agent.name, project: agent.project || null, chunk });
        io.emit('agent:thinking', { agentId: agent.id, project: agent.project || null, thinking: agentManager.agents.get(agent.id)?.currentThinking || '' });
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
    io.emit('agent:stream:end', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
    agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
  }

  return { executed: true };
}

async function _runDecideMode(agent, task, instructions, columns, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  if (!instructions) {
    console.log(`[ActionExecutor] decide: no instructions — skipping`);
    return { executed: false, skipped: true, reason: 'no-instructions' };
  }

  const prompt = buildInstructionsPrompt(task, instructions, columns);
  console.log(`[ActionExecutor] decide: "${task.text?.slice(0, 60)}" via ${agent.name}`);

  // Snapshot task state so we can detect whether the agent actually called @update_task.
  // The agent is supposed to either move the task to a new status, or at least append
  // details (which mutates task.text). If neither happens we treat the action as a
  // no-op and let the WorkflowEngine retry it.
  const beforeTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  const beforeStatus = beforeTask?.status ?? task.status;
  const beforeTextLen = (beforeTask?.text || '').length;

  let fullResponse = '';

  io.emit('agent:stream:start', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
  try {
    const workflowMeta = { type: 'workflow-action', mode: 'decide', taskId: task.id };
    await agentManager.sendMessage(
      agent.id,
      prompt,
      (chunk) => {
        fullResponse += chunk;
        io.emit('agent:stream:chunk', { agentId: agent.id, agentName: agent.name, project: agent.project || null, chunk });
        io.emit('agent:thinking', { agentId: agent.id, project: agent.project || null, thinking: agentManager.agents.get(agent.id)?.currentThinking || '' });
      },
      0,
      workflowMeta
    );

    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'decide');
  } finally {
    io.emit('agent:stream:end', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
    agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
  }

  // Verify the agent actually made a decision: status changed OR details appended.
  const afterTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  const afterStatus = afterTask?.status ?? task.status;
  const afterTextLen = (afterTask?.text || '').length;
  const decided = afterStatus !== beforeStatus || afterTextLen !== beforeTextLen;

  if (!decided) {
    console.warn(`[ActionExecutor] decide: agent "${agent.name}" produced no @update_task call for task="${task.id}" — flagging for retry`);
    return { executed: false, skipped: true, reason: 'no-decision' };
  }

  console.log(`[ActionExecutor] decide: completed for task="${task.id}" "${task.text?.slice(0, 60)}"`);
  return { executed: true };
}

async function _runExecuteMode(agent, task, instructions, columns, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const hasInstructions = !!instructions;
  const prompt = hasInstructions ? buildInstructionsPrompt(task, instructions, columns) : buildExecutePrompt(task);
  console.log(`[ActionExecutor] execute: "${task.text?.slice(0, 60)}" via ${agent.name}${hasInstructions ? ' (with instructions)' : ''}`);

  let fullResponse = '';

  io.emit('agent:stream:start', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
  try {
    const workflowMeta = { type: 'workflow-action', mode: 'execute', taskId: task.id };
    const result = await agentManager.sendMessage(
      agent.id,
      prompt,
      (chunk) => {
        fullResponse += chunk;
        io.emit('agent:stream:chunk', { agentId: agent.id, agentName: agent.name, project: agent.project || null, chunk });
        io.emit('agent:thinking', { agentId: agent.id, project: agent.project || null, thinking: agentManager.agents.get(agent.id)?.currentThinking || '' });
      },
      0,
      workflowMeta
    );

    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'execute');

    // Check if agent completed the task via @task_execution_complete
    const freshTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);

    if (freshTask?._executionCompleted) {
      // Immediate completion — agent called @task_execution_complete in its response
      const comment = freshTask._executionComment || '';
      delete freshTask._executionCompleted;
      delete freshTask._executionComment;
      console.log(`✅ [ActionExecutor] execute: completed immediately${hasInstructions ? ' (with instructions)' : ''}${comment ? ` (${comment.slice(0, 80)})` : ''}`);
    } else if (freshTask && !agentManager._isActiveTaskStatus(freshTask.status)) {
      // Task was already moved (e.g. via @update_task)
      console.log(`[ActionExecutor] execute: task already moved to "${freshTask.status}"${hasInstructions ? ' (with instructions)' : ''}`);
    } else {
      // Agent did not complete in first response — wait for @task_execution_complete via reminder loop
      console.log(`[ActionExecutor] execute: waiting for task_execution_complete${hasInstructions ? ' (with instructions)' : ''}`);
      await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, task.text);
    }
  } finally {
    io.emit('agent:stream:end', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
    agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
  }

  return { executed: true };
}
