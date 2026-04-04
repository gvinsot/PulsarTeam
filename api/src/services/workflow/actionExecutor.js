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
import { saveAgent, saveTaskToDb } from '../database.js';

// ── Prompt Builders ─────────────────────────────────────────────────────────

function buildTitlePrompt(description) {
  return `Generate a short, concise title (max 20 words) for the following task description. Reply with ONLY the title, nothing else.\n\n${description}`;
}

function buildSetTypePrompt(description) {
  return `Classify the following task into exactly one type. The possible types are: bug, feature, technical, improvement, documentation, other.\n\nReply with ONLY the type (a single word, lowercase), nothing else.\n\nTask:\n${description}`;
}

function buildRefinePrompt(task, instructions) {
  return `Refine the following task:\n\nTask: ${task.text}\n${task.project ? `Project: ${task.project}\n` : ''}\n${instructions}\n\nReply ONLY with the improved task description.`;
}

function buildInstructionsPrompt(task, instructions) {
  return `You have been assigned instructions for the following task.

Task ID: ${task.id}
Task title: ${task.text}
Current status: ${task.status}
${task.error ? `Previous error: ${task.error}` : ''}

Instructions:
${instructions}

You can change the task status using @update_task(${task.id}, <new_status>) where <new_status> is a workflow column ID.
You can also append details to the task description: @update_task(${task.id}, <new_status>, <details>).
Execute the instructions above and update the task status accordingly.`;
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
    'run_command', 'report_error', 'git_commit_push', 'mcp_call', 'link_commit',
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
 * @property {boolean} executed   - true if the action ran to completion
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
    console.log(`[ActionExecutor] assign_agent: no agent with role "${action.role}" — skipping`);
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
    saveTaskToDb({ ...actualTask, agentId: task.agentId });
    task.assignee = agent.id;
    io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task: actualTask });
    console.log(`[ActionExecutor] assign_agent: assigned to "${agent.name}" (role: ${action.role})`);
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
    saveTaskToDb({ ...actualTask, agentId: task.agentId });
    task.assignee = targetAgentId;
    io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task: actualTask });
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

  // Clean up chain resume state before moving
  const taskBeforeMove = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (taskBeforeMove) {
    delete taskBeforeMove._completedActionIdx;
    taskBeforeMove.completedActionIdx = null;
    delete taskBeforeMove._pendingOnEnter;
  }

  console.log(`[ActionExecutor] change_status: "${task.status}" → "${action.target}"`);
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
async function executeRunAgent(action, task, { agentManager, io, ownerId }) {
  const mode = action.mode || AgentMode.EXECUTE;
  const role = action.role || '';
  const instructions = action.instructions || '';
  const targetStatus = action.targetStatus || null;

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
    io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task: actualTask });
  }

  // Auto-switch agent to task project if needed
  if (task.project && task.project !== agent.project) {
    console.log(`[ActionExecutor] Switching "${agent.name}" to project "${task.project}"`);
    if (agentManager._switchProjectContext) {
      agentManager._switchProjectContext(agent, agent.project, task.project);
    }
    agent.project = task.project;
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
        result = await _runDecideMode(agent, task, instructions, { agentManager, io, execStartMsgIdx, execStartedAt });
        break;
      case AgentMode.EXECUTE:
        result = await _runExecuteMode(agent, task, instructions, targetStatus, { agentManager, io, execStartMsgIdx, execStartedAt });
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
      saveAgent(agentManager.agents.get(task.agentId));
      io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task: actualTask });
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

async function _runDecideMode(agent, task, instructions, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  if (!instructions) {
    console.log(`[ActionExecutor] decide: no instructions — skipping`);
    return { executed: false, skipped: true, reason: 'no-instructions' };
  }

  const prompt = buildInstructionsPrompt(task, instructions);
  console.log(`[ActionExecutor] decide: "${task.text?.slice(0, 60)}" via ${agent.name}`);

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
    console.log(`[ActionExecutor] decide: completed for "${task.text?.slice(0, 60)}"`);
  } finally {
    io.emit('agent:stream:end', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
    agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
  }

  return { executed: true };
}

async function _runExecuteMode(agent, task, instructions, targetStatus, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const hasInstructions = !!instructions;
  const prompt = hasInstructions ? buildInstructionsPrompt(task, instructions) : task.text;
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
      const completionStatus = targetStatus || 'done';
      agentManager.setTaskStatus(task.agentId, task.id, completionStatus, { skipAutoRefine: false, by: agent.name });
      console.log(`✅ [ActionExecutor] execute: completed immediately → ${completionStatus}${hasInstructions ? ' (with instructions)' : ''}`);
    } else if (freshTask && !agentManager._isActiveTaskStatus(freshTask.status)) {
      // Task was already moved (e.g. via @update_task)
      console.log(`[ActionExecutor] execute: task already moved to "${freshTask.status}"${hasInstructions ? ' (with instructions)' : ''}`);
    } else {
      // Agent did not complete in first response — wait for @task_execution_complete via reminder loop
      console.log(`[ActionExecutor] execute: waiting for task_execution_complete${hasInstructions ? ' (with instructions)' : ''}`);
      await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, targetStatus, task.text);
    }
  } finally {
    io.emit('agent:stream:end', { agentId: agent.id, agentName: agent.name, project: agent.project || null });
    agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
  }

  return { executed: true };
}
