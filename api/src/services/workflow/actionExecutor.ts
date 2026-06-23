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
import { saveTaskToDb, updateTaskExecutionStatus, updateTaskFields } from '../database.js';
import { applyTaskUpdate } from '../swarmApiMcp.js';
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
 * Drive a CLI runner via its interactive PTY: bind the runner, inject the prompt
 * (submitting it), then wait for the terminal-driven execution to complete.
 * Returns the wait result string (e.g. 'completed', 'error').
 */
async function _runViaCliTerminal(agentManager, agent, task, prompt) {
  await bindAgentRunner(agentManager, agent);
  await agentManager.executionManager.sendTerminalInput(agent.id, prompt, { submit: true });
  return agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, task.text, {
    terminalDriven: true,
  });
}

/**
 * Throw if a terminal-driven wait ended in a hard error so the chain doesn't
 * advance over a task that never ran. Surfaces a consumed auth error when present.
 */
function _throwIfWaitError(agentManager, task, waitResult, errorLabel) {
  if (waitResult === 'error') {
    const authError = agentManager._consumeTaskAuthError?.(task.id);
    throw new Error(authError || errorLabel);
  }
}

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

/**
 * Append a 'reassign' history entry recording the task's current status and the
 * new assignee. Mirrors the guard the inline copies used.
 */
export function recordReassign(task, assignee) {
  if (!task.history) task.history = [];
  task.history.push({
    status: task.status,
    at: new Date().toISOString(),
    by: 'workflow',
    type: 'reassign',
    assignee,
  });
}

/**
 * Persist the task then emit task:updated, in that order, so any loadTasks()
 * triggered by the emit reads the committed row. The save and emit use separate
 * payload spreads (the emit mutates its copy with updatedAt + assignee enrichment).
 */
export function saveThenEmitTaskUpdated(agentManager, agentId, task) {
  const payload = { ...task, agentId };
  Promise.resolve(saveTaskToDb({ ...task, agentId }))
    .catch(() => {})
    .then(() => _emitTaskUpdated(agentManager, agentId, payload));
}

/**
 * Persist named fields of a board-level task (agent_id = null) then emit, in that
 * order. These tasks have no in-memory store object, so mutations must go to the
 * DB directly. Uses a TARGETED column update (not the full saveTaskToDb upsert,
 * which would clobber fields the transient task copy may not carry) — same
 * rationale as _markActionRunningBoardLevel. Ownership (agentId) is unchanged.
 */
function persistBoardLevelFields(agentManager, task, fields) {
  Promise.resolve(updateTaskFields(task.id, fields))
    .catch(() => {})
    .then(() => _emitTaskUpdated(agentManager, task.agentId, { ...task, agentId: task.agentId }));
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
    'get_action_status', 'build_stack', 'test_stack',
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
    recordReassign(actualTask, agent.id);
    task.assignee = agent.id;
    saveThenEmitTaskUpdated(agentManager, task.agentId, actualTask);
    console.log(`[ActionExecutor] assign_agent: assigned to "${agent.name}" (role: ${action.role}) task="${task.id}"`);
  } else {
    // Board-level task (agent_id = null): no in-memory object, so the assignee
    // was never persisted and the board showed nobody had picked it up. Persist
    // on the working copy + emit so the card shows WHO took it. Ownership stays null.
    task.assignee = agent.id;
    recordReassign(task, agent.id);
    persistBoardLevelFields(agentManager, task, { assignee: agent.id, history: task.history });
    console.log(`[ActionExecutor] assign_agent: assigned board-level task to "${agent.name}" (role: ${action.role}) task="${task.id}"`);
  }

  return { executed: true };
}

// ── assign_agent_individual ─────────────────────────────────────────────────

function executeAssignAgentIndividual(action, task, { agentManager, io }) {
  const targetAgentId = action.agentId || null;
  const actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  const mutable = actualTask || task; // board-level tasks have no in-memory object
  const prev = mutable.assignee || null;
  // No-op guard: avoid clobbering an assignee set by a concurrent run_agent
  // action and spamming task:updated events when the target matches current.
  if (prev === targetAgentId) {
    const targetName = targetAgentId ? (agentManager.agents.get(targetAgentId)?.name || targetAgentId) : 'none';
    console.log(`[ActionExecutor] assign_agent_individual: "${targetName}" — no change, skipping`);
    return { executed: false, skipped: true, reason: 'no-change' };
  }
  mutable.assignee = targetAgentId;
  recordReassign(mutable, targetAgentId);
  task.assignee = targetAgentId;
  if (actualTask) {
    saveThenEmitTaskUpdated(agentManager, task.agentId, actualTask);
  } else {
    // Board-level task (agent_id = null): persist targeted + emit. Ownership stays null.
    persistBoardLevelFields(agentManager, task, { assignee: targetAgentId, history: task.history });
  }
  const targetName = targetAgentId ? (agentManager.agents.get(targetAgentId)?.name || targetAgentId) : 'none';
  console.log(`[ActionExecutor] assign_agent_individual: "${prev || 'none'}" → "${targetName}"`);
  return { executed: true };
}

// ── change_status ───────────────────────────────────────────────────────────

async function executeChangeStatus(action, task, { agentManager, workflow }) {
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

  // Board-level task (agent_id = null): no in-memory object, and setTaskStatus
  // requires an owner — it would silently no-op, stranding the chain. Route
  // through applyTaskUpdate, the canonical board-level path (mutates the DB row,
  // emits, and fires the column-entry hook). Mirrors how MCP board moves work.
  if (!realTask) {
    console.log(`[ActionExecutor] change_status (board-level): "${task.status}" → "${target}" task="${task.id}"`);
    const r = await applyTaskUpdate(agentManager, { task_id: task.id, status: target });
    if (!r.ok) {
      console.warn(`[ActionExecutor] change_status (board-level): ${r.error}`);
      return { executed: false, skipped: true, reason: 'board-level-update-failed' };
    }
    task.status = target; // reflect the move on the working copy
    return { executed: true, statusChanged: true };
  }

  // Clean up chain resume state before moving (owned task)
  realTask.completedActionIdx = null;
  delete realTask._pendingOnEnter;

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
 * Mark the task as having a workflow action running: set the actionRunning
 * flags, stamp startedAt, (re)assign the agent recording history, then save and
 * emit (deferred so loadTasks() reads the committed row).
 */
function _markActionRunning(actualTask, agent, mode, agentManager, agentId) {
  actualTask.actionRunning = true;
  actualTask.actionRunningAgentId = agent.id;
  actualTask.actionRunningMode = mode;
  if (!actualTask.startedAt) actualTask.startedAt = new Date().toISOString();
  if (actualTask.assignee !== agent.id) {
    actualTask.assignee = agent.id;
    recordReassign(actualTask, agent.id);
  }
  // Defer emit until after DB save so that any loadTasks() triggered by the
  // concurrent agent:updated event reads the committed row with actionRunning=true.
  // Without this, the frontend's loadTasks() can overwrite the real-time update
  // with stale DB data (same pattern as setTaskStatus in tasks.js).
  saveThenEmitTaskUpdated(agentManager, agentId, actualTask);
}

/**
 * Board-level variant of _markActionRunning for tasks created unassigned via
 * MCP add_task (agent_id = null). These never live in the agentId-keyed
 * in-memory `_tasks` store, so _markActionRunning is skipped and the card never
 * shows "busy" while the agent works. Persist the running flag with a TARGETED
 * column update (not the full saveTaskToDb upsert, which would clobber fields
 * the transient task copy may not carry) and emit so the board updates live.
 * agentId stays null — ownership is unchanged.
 */
async function _markActionRunningBoardLevel(agentManager, task, agent, mode) {
  task.actionRunning = true;
  task.actionRunningAgentId = agent.id;
  task.actionRunningMode = mode;
  if (!task.startedAt) task.startedAt = new Date().toISOString();
  // Assign the executing agent so the board shows WHO took the task (the busy
  // spinner alone doesn't say who). Unlike the owned-task path — whose finally
  // clears the assignee for non-execute modes because the task still has an
  // owner to attribute it to — a board-level task has no owner, so we KEEP the
  // assignee after the run (it surfaces "last worked by X"); a later run just
  // overwrites it with the next executor.
  const assigneeChanged = task.assignee !== agent.id;
  if (assigneeChanged) task.assignee = agent.id;
  try {
    await updateTaskFields(task.id, {
      actionRunning: true,
      actionRunningAgentId: agent.id,
      actionRunningMode: mode,
      startedAt: task.startedAt,
      ...(assigneeChanged ? { assignee: agent.id } : {}),
    });
  } catch { /* best-effort — the emit below still drives the live UI */ }
  _emitTaskUpdated(agentManager, task.agentId, { ...task, agentId: task.agentId });
}

/** Persist + emit the cleared running flag for a board-level task (see above). */
async function _clearActionRunningBoardLevel(agentManager, task) {
  task.actionRunning = false;
  delete task.actionRunningAgentId;
  delete task.actionRunningMode;
  try {
    await updateTaskFields(task.id, {
      actionRunning: false,
      actionRunningAgentId: null,
      actionRunningMode: null,
    });
  } catch { /* best-effort */ }
  _emitTaskUpdated(agentManager, task.agentId, { ...task, agentId: task.agentId });
}

/**
 * Switch the agent to the task's repo if needed, failing the action if the
 * switch fails. On failure this leaves the task in its CURRENT column (no status
 * change) with an 'error' history entry and an agent:error:report — deliberately
 * different from markTaskError, which would move the task to the error column.
 * Lock/busy release on failure is handled by executeRunAgent's finally.
 *
 * @returns {{ ok: true } | { ok: false; result: ActionResult }}
 */
async function _ensureAgentOnTaskRepo(agent, task, actualTask, { agentManager, mode, agentId }) {
  // Auto-switch agent to the task's repo if needed.
  // Tasks carry two related fields: `repoFullName` ("owner/repo", set on
  // creation/by GitHub sync) and `project` (set/edited via the task UI). We
  // honor whichever is present so the agent ends up working on the same repo
  // the task is about — not whatever it happened to be on last.
  const taskRepo = task.repoFullName || task.project || null;
  // Secondary repos are cloned alongside the primary. Push the keep-set to the
  // execution layer FIRST so every subsequent ensure (even the frequent
  // primary-only ones from tool batches) preserves them instead of pruning.
  const secondaryRepos = Array.isArray(task.secondaryRepos) ? task.secondaryRepos : [];
  agentManager.executionManager?.setSecondaryRepos?.(agent.id, secondaryRepos);

  const needsPrimarySwitch = !!taskRepo && taskRepo !== agent.project;
  const needsSecondaryEnsure = secondaryRepos.length > 0;
  // Already on the primary and nothing extra to clone → nothing to do. (When
  // there are secondaries we re-ensure even on an unchanged primary so the
  // runner clones any that are missing.)
  if (!needsPrimarySwitch && !needsSecondaryEnsure) return { ok: true };

  console.log(`[ActionExecutor] Ensuring "${agent.name}" on repo "${taskRepo || '(none)'}"${needsSecondaryEnsure ? ` (+${secondaryRepos.length} secondary)` : ''}`);
  // Hoisted so the catch can tell a missing token from a rejected one when the
  // clone fails with a GitHub auth error.
  let gitCreds: any = null;
  try {
    // 1. Switch conversation context (saves/restores history) — only on a real
    //    primary change; a secondary-only re-ensure keeps the current context.
    if (needsPrimarySwitch && agentManager._switchProjectContext) {
      agentManager._switchProjectContext(agent, agent.project, taskRepo);
    }
    // 2. Switch execution environment (coder-service / sandbox). switchProject
    //    forces a re-ensure (TTL reset) so secondaries are (re)cloned even when
    //    the primary is unchanged.
    if (agentManager.executionManager && taskRepo) {
      const gitUrl = task.repoHtmlUrl || buildRepoCloneUrl(taskRepo);
      if (gitUrl) {
        gitCreds = await getGitHubCredentialsForAgent(agent.id, agent.boardId || null);
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
    if (taskRepo) agent.project = taskRepo;
    return { ok: true };
  } catch (switchErr) {
    console.error(`[ActionExecutor] Project switch failed for "${agent.name}": ${switchErr.message}`);
    const switchErrTimestamp = new Date().toISOString();
    // Recognise a Git authentication failure (private repo + missing/expired
    // token) and surface a clear, actionable alert instead of the cryptic git
    // stderr ("could not read Username …"). This is the UI alert that tells the
    // user a repo-bound task can't run because GitHub isn't connected.
    const raw = switchErr.message || '';
    const isAuthFailure = /could not read Username|Authentication failed|terminal prompts disabled|fatal: could not read|HTTP 40[13]\b|Permission denied|invalid username or password|access denied|repository not found/i.test(raw);
    let taskError: string;
    let alertDescription: string;
    if (isAuthFailure) {
      const why = gitCreds?.token
        ? `the GitHub token configured for this agent or its board was rejected (expired, or it lacks access to "${taskRepo}")`
        : `no GitHub token is configured for this agent or its board`;
      taskError = `GitHub authentication failed for "${taskRepo}": ${why}. Connect or reconnect GitHub for the agent/board, then retry the task.`;
      alertDescription = `[GitHub] ${agent.name}: ${taskError}`;
    } else {
      taskError = `Project switch failed: ${raw}`;
      alertDescription = `[System Error] Project switch failed for "${agent.name}": ${raw}`;
    }
    if (actualTask) {
      actualTask.actionRunning = false;
      delete actualTask.actionRunningAgentId;
      delete actualTask.actionRunningMode;
      actualTask.error = taskError;
      if (!actualTask.history) actualTask.history = [];
      actualTask.history.push({
        status: actualTask.status,
        at: switchErrTimestamp,
        by: agent.name || 'workflow',
        type: 'error',
        error: taskError,
        actionMode: mode,
      });
      saveThenEmitTaskUpdated(agentManager, agentId, actualTask);
    }
    agentManager._emit('agent:error:report', {
      agentId: agent.id,
      agentName: agent.name,
      project: task.project || null,
      description: alertDescription,
      timestamp: switchErrTimestamp,
      isSystemError: true,
      taskId: task.id,
    });
    return { ok: false, result: { executed: false, error: true, message: taskError } };
  }
}

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

  // A fresh run_agent execution is genuinely starting here — we've passed the
  // durable executionStatus='stopped' gate in processColumnEntry. Drop any
  // stale in-memory 'stopped' signal left by a PRIOR lifecycle (classically:
  // the user pressed Stop and then moved the task to a new column, where
  // PUT /tasks/:id re-sets the signal to interrupt the already-gone old run).
  // Without this, _waitForExecutionComplete's early-stop check would consume
  // that residual signal and abort this run before the agent does anything —
  // so a stopped-then-moved task could never be picked up again. A genuine
  // Stop during THIS run sets the signal again, after this point, so it stays
  // honored.
  agentManager._clearStopSignal?.(task.id);

  // Wrap everything after markAgentBusy in try/finally so the busy flag is
  // always cleared — even if task setup or project-switch throws unexpectedly.
  let actualTask;
  let execStartMsgIdx;
  let execStartedAt;
  try {

  // Set actionRunning flag on the task
  actualTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  if (actualTask) {
    _markActionRunning(actualTask, agent, mode, agentManager, task.agentId);
  } else {
    // Board-level task (created unassigned via MCP add_task): not in the
    // in-memory store, so mark + persist the running flag directly — otherwise
    // the board never shows it as busy while the agent works.
    await _markActionRunningBoardLevel(agentManager, task, agent, mode);
  }

  // Auto-switch agent to the task's repo if needed.
  const switched = await _ensureAgentOnTaskRepo(agent, task, actualTask, { agentManager, mode, agentId: task.agentId });
  if (!switched.ok) return switched.result;
  execStartMsgIdx = (agent.conversationHistory || []).length;
  execStartedAt = new Date().toISOString();

    let result;
    switch (mode) {
      case AgentMode.TITLE:
        result = await _runSimpleMode('title', agent, task, { agentManager, io, execStartMsgIdx, execStartedAt });
        break;
      case AgentMode.SET_TYPE:
        result = await _runSimpleMode('set_type', agent, task, { agentManager, io, execStartMsgIdx, execStartedAt });
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
    // Board-level task: no in-memory copy, and board-level moves bypass
    // setTaskStatus, so nothing else will persist the cleared flag — do it here
    // or the task stays stuck "busy" in the DB after the run ends.
    if (!actualTask && task?.actionRunning) {
      await _clearActionRunningBoardLevel(agentManager, task);
    }
  }
}

// ── Mode-specific handlers ──────────────────────────────────────────────────

/**
 * Run `body` between a streamStart and a streamEnd+agentUpdated finally.
 * The finally wraps the ENTIRE body (including post-processing and any nested
 * waits) so the wire-order of streamEnd/agentUpdated is byte-identical to the
 * pasted copies: they always fire last, after the body's awaits and returns.
 */
async function _withAgentStream<T>(agentManager, agentId, body: () => Promise<T>): Promise<T> {
  agentManager.wsEmitter.streamStart(agentId);
  try {
    return await body();
  } finally {
    agentManager.wsEmitter.streamEnd(agentId);
    agentManager.wsEmitter.agentUpdated(agentId);
  }
}

/**
 * Build a sendMessage stream callback that accumulates chunks into `buf.text`
 * while forwarding each chunk to the frontend (streamChunk + thinking).
 */
function _makeStreamCollector(agentManager, agentId, buf: { text: string }) {
  return (chunk) => {
    buf.text += chunk;
    agentManager.wsEmitter.streamChunk(agentId, chunk);
    agentManager.wsEmitter.thinking(agentId);
  };
}

// Simple (non-streaming) modes share an identical body: slice the description,
// sendMessage, post-process the raw response, save the execution log, and emit
// agentUpdated in a finally. Only the prompt builder, the announce message, and
// the response post-processing differ — captured in SIMPLE_MODES.
const SET_TYPE_VALID_TYPES = ['bug', 'feature', 'technical', 'improvement', 'documentation', 'other'];

const SIMPLE_MODES = {
  title: {
    buildPrompt: buildTitlePrompt,
    announce: (task, agentName) => `[ActionExecutor] title: generating for "${task.text?.slice(0, 60)}" via ${agentName}`,
    apply: (agentManager, task, raw, _agentName) => {
      const title = (raw || '').trim().replace(/^["']|["']$/g, '');
      if (title) {
        agentManager.updateTaskTitle(task.agentId, task.id, title);
        console.log(`[ActionExecutor] title: "${title}"`);
      }
    },
  },
  set_type: {
    buildPrompt: buildSetTypePrompt,
    announce: (task, agentName) => `[ActionExecutor] set_type: classifying "${task.text?.slice(0, 60)}" via ${agentName}`,
    apply: (agentManager, task, raw, agentName) => {
      const rawType = (raw || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
      const taskType = SET_TYPE_VALID_TYPES.includes(rawType) ? rawType : 'other';
      agentManager.updateTaskType(task.agentId, task.id, taskType, agentName);
      console.log(`[ActionExecutor] set_type: "${taskType}"`);
    },
  },
} as const;

async function _runSimpleMode(modeName: 'title' | 'set_type', agent, task, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const { buildPrompt, announce, apply } = SIMPLE_MODES[modeName];
  const maxLen = agent.contextLength || 4000;
  const description = (task.text || '').slice(0, maxLen);
  const prompt = buildPrompt(description);

  console.log(announce(task, agent.name));

  try {
    const result = await agentManager.sendMessage(agent.id, prompt, () => {});
    apply(agentManager, task, result, agent.name);
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, modeName);
  } catch (err) {
    console.error(`[ActionExecutor] ${modeName} failed:`, err.message);
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, false, modeName);
  } finally {
    agentManager.wsEmitter.agentUpdated(agent.id);
  }

  return { executed: true };
}

async function _runRefineMode(agent, task, instructions, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const prompt = buildRefinePrompt(task, instructions);
  console.log(`[ActionExecutor] refine: "${task.text?.slice(0, 60)}" via ${agent.name}`);

  const buf = { text: '' };

  await _withAgentStream(agentManager, agent.id, async () => {
    const workflowMeta = { type: 'workflow-action', mode: 'refine', taskId: task.id };
    const result = await agentManager.sendMessage(
      agent.id,
      `[Auto-Transition] ${prompt}`,
      _makeStreamCollector(agentManager, agent.id, buf),
      0,
      workflowMeta
    );

    const response = (result?.content || buf.text).trim();
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'refine');

    if (response) {
      const cleaned = stripToolCalls(response);
      if (cleaned) agentManager.updateTaskText(task.agentId, task.id, cleaned);
    }
  });

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

  const buf = { text: '' };

  // CLI runners drive their interactive PTY (visible in the terminal tab) and
  // signal via their MCP tools — never the headless sendMessage path, which
  // spawns a separate invisible claude process that also conflicts with the
  // shared PTY. The agent's decision lands as a task mutation (update_task MCP)
  // which the before/after comparison below detects.
  if (isCliRunner(agent) && agentManager.executionManager?.sendTerminalInput) {
    console.log(`[ActionExecutor] decide: injecting prompt into CLI terminal for "${agent.name}" (status=${agent.status})`);
    const waitResult = await _runViaCliTerminal(agentManager, agent, task, prompt);
    _throwIfWaitError(agentManager, task, waitResult, 'Claude Code CLI ended in an authentication or runtime error');
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'decide');
  } else {
    await _withAgentStream(agentManager, agent.id, async () => {
      const workflowMeta = { type: 'workflow-action', mode: 'decide', taskId: task.id };
      await agentManager.sendMessage(
        agent.id,
        prompt,
        _makeStreamCollector(agentManager, agent.id, buf),
        0,
        workflowMeta
      );

      agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'decide');
    });
  }

  // Verify the agent actually made a decision: status changed OR details appended.
  const afterTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);
  const afterStatus = afterTask?.status ?? task.status;
  const afterTextLen = (afterTask?.text || '').length;
  const decided = afterStatus !== beforeStatus || afterTextLen !== beforeTextLen;

  if (!decided) {
    // Count consecutive no-decision attempts so a structurally-stuck agent fails
    // fast instead of retrying forever. Keyed by taskId on the manager (not on
    // the task object) so the counter accumulates for board-level tasks too —
    // they have no in-memory task object to hang it on.
    const attempts = (agentManager._decideNoDecisionCounts.get(task.id) || 0) + 1;
    agentManager._decideNoDecisionCounts.set(task.id, attempts);

    if (attempts >= MAX_DECIDE_NO_DECISION) {
      agentManager._decideNoDecisionCounts.delete(task.id);
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
  agentManager._decideNoDecisionCounts.delete(task.id);
  console.log(`[ActionExecutor] decide: completed for task="${task.id}" "${task.text?.slice(0, 60)}"`);
  return { executed: true };
}

async function _runExecuteMode(agent, task, instructions, columns, { agentManager, io, execStartMsgIdx, execStartedAt }) {
  const hasInstructions = !!instructions;
  const prompt = hasInstructions ? buildInstructionsPrompt(task, instructions, columns) : buildExecutePrompt(task);
  console.log(`[ActionExecutor] execute: "${task.text?.slice(0, 60)}" via ${agent.name}${hasInstructions ? ' (with instructions)' : ''}`);

  const buf = { text: '' };

  // CLI runners always execute inside their interactive PTY — never the
  // headless sendMessage fallback. Even if agent.status flipped to "busy"
  // (e.g. console activity from an attached browser terminal), we still drive
  // the same shared PTY: the runner blocks the inject call until the TUI is
  // back at an input-ready prompt (the PTY-is-free gate). Falling back to
  // headless here would create an invisible session the user can't see in the
  // terminal tab and would split the task's context across two backends.
  if (isCliRunner(agent) && agentManager.executionManager?.sendTerminalInput) {
    console.log(`[ActionExecutor] execute: injecting task prompt into CLI terminal for "${agent.name}" (status=${agent.status})`);
    const waitResult = await _runViaCliTerminal(agentManager, agent, task, prompt);
    // Honor the wait result: a CLI auth failure (or other hard error) must NOT
    // be reported as a successful execution, otherwise the workflow chain
    // advances (e.g. → done/review) over a task that never ran. Throw so
    // executeRunAgent's catch marks the task error + saves the execution log.
    _throwIfWaitError(agentManager, task, waitResult, 'Claude Code CLI ended in an authentication or runtime error');
    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'execute');
    return { executed: true };
  }

  const streamResult = await _withAgentStream(agentManager, agent.id, async () => {
    const workflowMeta = { type: 'workflow-action', mode: 'execute', taskId: task.id };
    const result = await agentManager.sendMessage(
      agent.id,
      prompt,
      _makeStreamCollector(agentManager, agent.id, buf),
      0,
      workflowMeta
    );

    agentManager._saveExecutionLog(task.agentId, task.id, agent.id, execStartMsgIdx, execStartedAt, true, 'execute');

    const freshTask = agentManager._getAgentTasks(task.agentId).find(t => t.id === task.id);

    if (freshTask && !agentManager._isActiveTaskStatus(freshTask.status)) {
      console.log(`[ActionExecutor] execute: task already moved to "${freshTask.status}"${hasInstructions ? ' (with instructions)' : ''}`);
    } else if (!buf.text || buf.text.trim().length === 0) {
      console.warn(`⚠️ [ActionExecutor] execute: "${agent.name}" returned empty response for "${task.text?.slice(0, 60)}" — skipping reminder loop`);
      return { executed: false, skipped: true, reason: 'empty-response' };
    } else {
      console.log(`[ActionExecutor] execute: waiting for update_task completion${hasInstructions ? ' (with instructions)' : ''}`);
      await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, task.text);
    }
    return null;
  });

  if (streamResult) return streamResult;

  return { executed: true };
}
