import { createHash } from 'node:crypto';
import { ToolBudgetReachedError } from '../agentManager/nativeToolHistory.js';
import { waitForProjectSwitch } from '../agentManager/crud.js';
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

import { ActionType, AgentMode, AUTO_ROLE, columnExists } from './taskStateMachine.js';
import type { WorkflowAction, WorkflowColumn, WorkflowConfig } from './taskStateMachine.js';
import type { Agent } from '../database/agents.js';
import {
  findAgentByRole,
  findAgentForAssignment,
  hasAgentWithRole,
  hasSelectableAgent,
  reserveAgentForTask,
} from './agentSelector.js';
import {
  claimRun,
  releaseRun as releaseRunClaim,
  refreshClaimedAgents,
  type ClaimResult,
} from './runClaims.js';
import { resolveAutoRole } from './roleRouter.js';
import {
  needsApproval,
  taskContentForPrompt,
  wrapUntrusted,
  isExternalTask,
} from '../../lib/taskTrust.js';
import { enterRunProfileForTask } from '../security/externalRunProfile.js';
import { isUserStopError } from './taskErrors.js';
import {
  saveAgent,
  updateTaskExecutionStatus,
  updateTaskFields,
  getTaskById,
  getActiveAssigneeIds,
} from '../database.js';
import {
  clearTaskErrorForRun,
  emitTaskUpdated,
  isAssigneeOffBoard,
  persistThenEmit,
} from '../taskMutations.js';
import { applyTaskUpdate } from '../swarmApiMcp.js';
import { isValidRepoFullName } from '../taskRepos.js';
import {
  ensureAgentWorkspace,
  resolveAgentGitCredentials,
  isGitHubReconnectRequired,
  type AgentGitCredentials,
} from '../execution/agentWorkspace.js';
import { isCliRunner } from '../runners.js';
import { deliverTaskAttachments } from '../execution/taskAttachmentDelivery.js';
import { errorMessage } from '../../lib/errors.js';
import {
  getTaskCommitRun,
  startTaskCommitRun,
  finishTaskCommitRun,
} from '../agentManager/tools/gitReconcile.js';
import { noteCliActivity, noteCliPromptInjected } from '../agentManager/cliActivity.js';
import { getTaskSignal, setTaskSignal } from '../agentManager/tasks.js';
import type { AgentManager } from '../agentManager/index.js';
import type { Task } from '../database/tasks.js';

// ── Handler context shapes ──────────────────────────────────────────────────
// Both are plain bags built by the caller and destructured by every handler
// below; naming them is what lets those destructured parameters be typed at
// all. `io` is deliberately spelled as AgentManager's own socket.io field
// rather than restated here — it is the same object, and typing socket.io is
// a separate job from this pass.

/** Built once per action chain by WorkflowEngine and threaded through
 * executeAction into each action handler. */
export interface ActionContext {
  agentManager: AgentManager;
  io: AgentManager['io'];
  /** Board owner, used to scope agent selection; null for an ownerless board. */
  ownerId: string | null;
  workflow: WorkflowConfig | null;
  /** Status the chain started from — set by _executeActionChain only. */
  originalStatus?: string;
  /** Called once a run_agent action holds its DB claim: a recheck-dispatched
   *  chain releases its cross-replica advisory lock there (the claim fences the
   *  task from then on), instead of pinning a pooled connection for the whole run. */
  onRunClaimed?: () => void;
}

/** Context for the repo-ensure step of a run_agent action. */
export interface EnsureRepoContext {
  agentManager: AgentManager;
  mode: string;
  /** Owning agent of the task; null for a board-level task. */
  agentId: string | null;
}

/** Built by executeRunAgent for the per-mode runners, once the agent is bound
 * and the execution log window is open. */
export interface ModeRunContext {
  agentManager: AgentManager;
  io: AgentManager['io'];
  /** Index into the agent's conversation history where this run starts. */
  execStartMsgIdx: number;
  execStartedAt: string;
  /** Repo HEAD before a decide run, diffed afterwards to link commits. */
  gitBaselineHead?: string | null;
}

async function bindAgentRunner(agentManager: AgentManager, agent: Agent) {
  if (!agentManager.executionManager?.bindAgent || !agent?.id) return;
  const llmConfig = agentManager.resolveLlmConfig?.(agent) || {};
  const providerType = agent.runner || (llmConfig.managesContext ? 'claudecode' : 'sandbox');
  const gitCreds = await resolveAgentGitCredentials(agent);
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
async function _runViaCliTerminal(
  agentManager: AgentManager,
  agent: Agent,
  task: Task,
  prompt: string,
  gitBaselineHead: string | null = null
) {
  await bindAgentRunner(agentManager, agent);
  // A Stop that landed while the run was being prepared (repo switch, files)
  // cancels the paste: the drain would only interrupt it 20 s later.
  if (getTaskSignal(task.id, 'stopped')) return 'stopped';
  await agentManager.executionManager.sendTerminalInput(agent.id, prompt, { submit: true });
  noteCliPromptInjected(agentManager, agent.id, 'CLI task injected');
  return agentManager._waitForExecutionComplete(
    task.agentId,
    task.id,
    agent.id,
    agent.name,
    task.text,
    {
      terminalDriven: true,
      // Anchor for the terminal-independent commit sweep inside the wait loop —
      // a CLI runner's git activity never surfaces as parseable terminal output.
      gitBaselineHead,
    }
  );
}

/**
 * Throw if a terminal-driven wait ended in a hard error so the chain doesn't
 * advance over a task that never ran. Surfaces a consumed auth error when present.
 */
function _throwIfWaitError(
  agentManager: AgentManager,
  task: Task,
  waitResult: string,
  errorLabel: string
) {
  if (waitResult === 'error') {
    const authError = agentManager._consumeTaskAuthError?.(task.id);
    throw new Error(authError || errorLabel);
  }
}

/**
 * Snapshot of a task's live state for before/after comparison (e.g. decide-mode
 * decision detection). Read straight from the DB — the single source of truth for
 * both owned and board-level tasks.
 */
async function _liveTaskSnapshot(_agentManager: AgentManager, task: Task) {
  return getTaskById(task.id);
}

/**
 * Append a 'reassign' history entry recording the task's current status and the
 * new assignee. Mirrors the guard the inline copies used.
 */
export function recordReassign(task: Task, assignee: string | null) {
  if (!task.history) task.history = [];
  task.history.push({
    status: task.status,
    at: new Date().toISOString(),
    by: 'workflow',
    type: 'reassign',
    assignee,
  });
}

// ── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Format task commits into a readable context block for the agent prompt.
 * Returns an empty string if no commits are associated.
 */
function formatCommitsContext(task: Task) {
  if (!task.commits || task.commits.length === 0) return '';
  const lines = task.commits.map(c => {
    const dateStr = c.date ? ` (${c.date.slice(0, 16).replace('T', ' ')})` : '';
    return `- ${c.hash.slice(0, 8)}: ${c.message || '(no message)'}${dateStr}`;
  });
  return `\nAssociated commits:\n${lines.join('\n')}\n`;
}

function buildTitlePrompt(description: string, external: boolean) {
  return `Generate a short, concise title (max 20 words) for the following task description. Reply with ONLY the title, nothing else.\n\n${wrapUntrusted(description, 'task_content', external)}`;
}

function buildSetTypePrompt(description: string, external: boolean) {
  return `Classify the following task into exactly one type. The possible types are: bug, feature, technical, improvement, documentation, other.\n\nReply with ONLY the type (a single word, lowercase), nothing else.\n\n${wrapUntrusted(description, 'task_content', external)}`;
}

function buildRefinePrompt(task: Task, instructions: string) {
  return `Refine the following task:\n\n${taskContentForPrompt(task)}\n${task.project ? `Project: ${task.project}\n` : ''}\n${instructions}\n\nReply ONLY with the improved task description.`;
}

function nextColumnAfter(status: string, columns: WorkflowColumn[]) {
  const curIdx = columns.findIndex(c => c.id === status);
  if (curIdx === -1 || curIdx >= columns.length - 1) return null;
  return columns[curIdx + 1];
}

function buildDecisionToolContract(task: Task, instructions: string, columns: WorkflowColumn[]) {
  const nextColumn = nextColumnAfter(task.status, columns);
  const mentionsNextColumn = /\bnext\s+column\b|\bcolonne\s+suivante\b/i.test(instructions);
  const listTasksTool = 'list_tasks';
  const listMyTasksTool = 'list_my_tasks';
  const targetHint =
    mentionsNextColumn && nextColumn
      ? `\nThe next column after "${task.status}" is "${nextColumn.id}".`
      : '';
  const exampleStatus = mentionsNextColumn && nextColumn ? nextColumn.id : '<target-status>';
  const example = `update_task with { "task_id": "${task.id}", "status": "${exampleStatus}", "comment": "Moved to ${exampleStatus}" }`;

  return `
Decision contract:
- You MUST make the workflow decision by calling the task-update tool; a prose-only answer does not move the task and will be treated as no decision.
- The exact task ID is already provided above. Do not call ${listTasksTool} or ${listMyTasksTool} just to find this task.
- If the requested action is only to move the card or "do nothing", do not read files, write files, or commit. Move the task directly.
- Use this format on its own line:

${example}${targetHint}

`;
}

function buildInstructionsPrompt(task: Task, instructions: string, columns: WorkflowColumn[]) {
  const columnList = columns?.length
    ? `\nValid statuses (column IDs): ${columns.map(c => c.id).join(', ')}`
    : '';
  const commits = formatCommitsContext(task);
  return `You have been assigned instructions for the following task.

Task ID: ${task.id}

Task description:
${taskContentForPrompt(task)}

Current status: ${task.status}
${columnList}

${task.error ? `Previous error: ${task.error}\n` : ''}${commits}

Instructions:
${instructions}
${buildDecisionToolContract(task, instructions, columns)}`;
}

// ── Result types ────────────────────────────────────────────────────────────

/** What every action handler returns, and what WorkflowEngine's chain reads. */
export interface ActionResult {
  /** true if the action ran to completion */
  executed: boolean;
  /** true if the action was skipped (no agent, lock held, etc.) */
  skipped?: boolean;
  /** why it was skipped */
  reason?: string;
  /** true if an error occurred */
  error?: boolean;
  /** error message */
  message?: string;
  /** true if a change_status action moved the task */
  statusChanged?: boolean;
}

// ── Main executor ───────────────────────────────────────────────────────────

// ── Automatic role resolution (AUTO_ROLE) ───────────────────────────────────
// The Role Router is an LLM call. An action whose resolved role has no idle
// agent is skipped and retried on every recheck tick — re-asking the router
// each time cost an LLM call every few seconds per waiting task. The answer is
// kept per (task, column, action) until the column changes; a router failure is
// retried a few times before the task is put in error.
const AUTO_ROLE_CACHE_TTL_MS = 30 * 60_000;
const AUTO_ROLE_MAX_FAILURES = 3;
const _autoRoleCache = new Map<string, { role?: string; failures: number; at: number }>();

function _autoRoleKey(action: WorkflowAction, task: Task): string {
  const instructions = createHash('sha1')
    .update(action.instructions || '')
    .digest('hex')
    .slice(0, 16);
  return `${task.id}|${task.status}|${action.type}|${action.mode || ''}|${instructions}`;
}

async function _resolveAutoRoleCached(
  action: WorkflowAction,
  task: Task,
  context: ActionContext
): Promise<{ ok: true; role: string } | { ok: false; result: ActionResult }> {
  const now = Date.now();
  for (const [key, entry] of _autoRoleCache) {
    if (now - entry.at > AUTO_ROLE_CACHE_TTL_MS) _autoRoleCache.delete(key);
  }
  const key = _autoRoleKey(action, task);
  let cached = _autoRoleCache.get(key);
  const boardId = task.boardId || null;
  const ownerId = context.ownerId || null;
  if (cached?.role) {
    // A role nobody on the board holds any more (agent deleted, role renamed)
    // would keep the task waiting forever: ask the router again.
    if (hasAgentWithRole(context.agentManager.agents, cached.role, ownerId, boardId)) {
      return { ok: true, role: cached.role };
    }
    _autoRoleCache.delete(key);
    cached = undefined;
  }
  // Nobody on the board could take it whatever the role: wait without asking.
  if (
    action.type === ActionType.RUN_AGENT &&
    !hasSelectableAgent(context.agentManager.agents, { ownerId, boardId })
  ) {
    return { ok: false, result: { executed: false, skipped: true, reason: 'no-idle-agent' } };
  }
  try {
    const role = await resolveAutoRole(task, context);
    _autoRoleCache.set(key, { role, failures: 0, at: now });
    return { ok: true, role };
  } catch (err) {
    const failures = (cached?.failures || 0) + 1;
    console.error(
      `[ActionExecutor] auto-role: resolution failed for task="${task.id}" (${failures}/${AUTO_ROLE_MAX_FAILURES}): ${errorMessage(err)}`
    );
    if (failures >= AUTO_ROLE_MAX_FAILURES) {
      _autoRoleCache.delete(key);
      // Error → WorkflowEngine marks the task in error and stops the chain, so
      // the retry does not re-invoke the LLM in a loop.
      return { ok: false, result: { executed: false, error: true, message: errorMessage(err) } };
    }
    _autoRoleCache.set(key, { failures, at: now });
    return { ok: false, result: { executed: false, skipped: true, reason: 'role-router-failed' } };
  }
}

/**
 * Execute a single workflow action.
 *
 * @param {Object} action        - the action config from the workflow transition
 * @param {Object} task          - the task being processed (with agentId, boardId, etc.)
 * @param {Object} context       - { agentManager, io, ownerId, workflow }
 * @returns {Promise<ActionResult>}
 */
export async function executeAction(
  action: WorkflowAction,
  task: Task,
  context: ActionContext
): Promise<ActionResult> {
  // Defence in depth: processColumnEntry and the recheck already skip an
  // unapproved external task, but nothing that reaches an agent — including the
  // Role Router LLM below, which reads the text — may run on one.
  if (needsApproval(task)) {
    return { executed: false, skipped: true, reason: 'awaiting-approval' };
  }

  // Automatic role selection: a run_agent / assign_agent action may defer its
  // role choice to the admin-configured Role Router LLM by setting
  // role === AUTO_ROLE. Resolve it to a concrete role BEFORE dispatch so the
  // handlers below stay unchanged.
  if (
    (action.type === ActionType.RUN_AGENT || action.type === ActionType.ASSIGN_AGENT) &&
    action.role === AUTO_ROLE
  ) {
    const resolved = await _resolveAutoRoleCached(action, task, context);
    if (!resolved.ok) return resolved.result;
    action = { ...action, role: resolved.role };
  }

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
      // A misconfigured workflow never heals by retrying — surface it as an
      // error instead of flagging an endless on_enter retry.
      console.warn(`[ActionExecutor] Unknown action type: ${action.type}`);
      return {
        executed: false,
        error: true,
        message: `Workflow misconfigured: unknown action type "${action.type}"`,
      };
  }
}

// ── assign_agent ────────────────────────────────────────────────────────────

/** A 'reassign' history entry for the task's current column. */
function reassignEntry(task: Task, assignee: string | null) {
  return {
    status: task.status,
    at: new Date().toISOString(),
    by: 'workflow',
    type: 'reassign',
    assignee,
  };
}

/**
 * Persist an assignment made by the workflow — awaited and TARGETED. The
 * fire-and-forget full-row save it replaces was reliably overwritten by the
 * chain's own bookkeeping write that followed, so the assignment (and the
 * conditions waiting on it) silently never happened.
 */
async function _persistAssignment(agentManager: AgentManager, task: Task, assignee: string | null) {
  const updated = await updateTaskFields(task.id, {
    assignee,
    historyAppend: [reassignEntry(task, assignee)],
  });
  task.assignee = assignee;
  if (updated)
    emitTaskUpdated(agentManager, { ...updated }, { emitAgent: false, stampUpdatedAt: true });
  return updated;
}

async function executeAssignAgent(
  action: WorkflowAction,
  task: Task,
  { agentManager, io: _io, ownerId }: ActionContext
): Promise<ActionResult> {
  // Precompute owned-task counts once from the DB so the (sync) load-balancer
  // can tie-break by task count without an in-memory store. Agents already on
  // another active card, or running anything anywhere, are not candidates: the
  // engine never puts one agent on two in-progress tasks.
  const [tasksByAgent, unavailable] = await Promise.all([
    agentManager._tasksByAgentMap(),
    getActiveAssigneeIds(task.id, {
      boardId: task.boardId || null,
      environment: task.environment || null,
    }),
    refreshClaimedAgents(),
  ]);
  const agent = findAgentForAssignment(
    agentManager.agents,
    action.role,
    ownerId,
    (agentId: any) => tasksByAgent.get(agentId) || [],
    task.id,
    task.boardId || null,
    task.repoFullName || null,
    unavailable
  ) as any;

  if (!agent) {
    console.log(
      `[ActionExecutor] assign_agent: no available agent with role "${action.role}" — deferring task="${task.id}"`
    );
    return { executed: false, skipped: true, reason: 'no-agent-for-role' };
  }

  await _persistAssignment(agentManager, task, agent.id);
  console.log(
    `[ActionExecutor] assign_agent: assigned to "${agent.name}" (role: ${action.role}) task="${task.id}"`
  );
  return { executed: true };
}

// ── assign_agent_individual ─────────────────────────────────────────────────

async function executeAssignAgentIndividual(
  action: WorkflowAction,
  task: Task,
  { agentManager, io: _io }: ActionContext
): Promise<ActionResult> {
  const targetAgentId = action.agentId || null;
  // Same hard rule as assign_agent's findAgentForAssignment: a workflow can
  // only hand its task to an agent of the task's own board.
  if (targetAgentId && isAssigneeOffBoard(agentManager.agents.get(targetAgentId), task.boardId)) {
    console.warn(
      `[ActionExecutor] assign_agent_individual: agent ${targetAgentId} is not on board ${task.boardId} — skipped`
    );
    return { executed: false, skipped: true, reason: 'agent-off-board' };
  }
  const current = await getTaskById(task.id);
  const prev = (current || task).assignee || null;
  const targetName = targetAgentId
    ? agentManager.agents.get(targetAgentId)?.name || targetAgentId
    : 'none';
  // No-op guard: avoid clobbering an assignee set by a concurrent run_agent
  // action and spamming task:updated events when the target matches current.
  if (prev === targetAgentId) {
    task.assignee = prev;
    console.log(`[ActionExecutor] assign_agent_individual: "${targetName}" — no change`);
    return { executed: true };
  }
  await _persistAssignment(agentManager, task, targetAgentId);
  console.log(`[ActionExecutor] assign_agent_individual: "${prev || 'none'}" → "${targetName}"`);
  return { executed: true };
}

// ── change_status ───────────────────────────────────────────────────────────

async function executeChangeStatus(
  action: WorkflowAction,
  task: Task,
  { agentManager, workflow }: ActionContext
): Promise<ActionResult> {
  let target = action.target;

  // Resolve __next__ to the column immediately after the current one
  if (target === '__next__') {
    const cols = workflow?.columns || [];
    const curIdx = cols.findIndex(c => c.id === task.status);
    if (curIdx === -1 || curIdx >= cols.length - 1) {
      console.log(
        `[ActionExecutor] change_status: __next__ — no column after "${task.status}" — skipping`
      );
      return {
        executed: false,
        error: true,
        message: `Workflow misconfigured: change_status "__next__" has no column after "${task.status}"`,
      };
    }
    target = cols[curIdx + 1].id;
  }

  if (!target) {
    return {
      executed: false,
      error: true,
      message: 'Workflow misconfigured: change_status action has no target column',
    };
  }

  // Moving to the column the task is already in is a no-op — let the chain go on
  // rather than flagging a retry that could never succeed.
  if (target === task.status) {
    console.log(`[ActionExecutor] change_status: task="${task.id}" already in "${target}" — no-op`);
    return { executed: true };
  }

  // Validate target column exists
  if (!columnExists(workflow, target)) {
    console.warn(`[ActionExecutor] change_status: target "${target}" does not exist`);
    return {
      executed: false,
      error: true,
      message: `Workflow misconfigured: change_status target column "${target}" does not exist`,
    };
  }

  // Check if the real task is already at the target status (concurrent chain
  // may have moved it). This prevents duplicate "stopping chain" log spam and
  // avoids triggering a redundant _checkAutoRefine for an already-processed column.
  const realTask = await getTaskById(task.id);
  if (!realTask) return { executed: false, skipped: true, reason: 'task-deleted' };
  if (realTask.status === target) {
    console.log(`[ActionExecutor] change_status: task="${task.id}" already at "${target}" — no-op`);
    return { executed: true, statusChanged: true };
  }

  // Board-level task (agent_id = null): route through applyTaskUpdate, the
  // canonical board-level path (mutates the DB row, emits, and fires the
  // column-entry hook). Mirrors how MCP board moves work.
  if (!realTask.agentId) {
    console.log(
      `[ActionExecutor] change_status (board-level): "${task.status}" → "${target}" task="${task.id}"`
    );
    const r = await applyTaskUpdate(agentManager, { task_id: task.id, status: target });
    if (!r.ok) {
      console.warn(`[ActionExecutor] change_status (board-level): ${r.error}`);
      return { executed: false, skipped: true, reason: 'board-level-update-failed' };
    }
    task.status = target; // reflect the move on the working copy
    return { executed: true, statusChanged: true };
  }

  console.log(`[ActionExecutor] change_status: "${task.status}" → "${target}" task="${task.id}"`);
  // setTaskStatus resets the chain resume state of the column being left.
  const result = await agentManager.setTaskStatus(realTask.agentId, task.id, target, {
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
 * Switch the agent to the task's repo if needed, failing the action if the
 * switch fails. On failure this leaves the task in its CURRENT column (no status
 * change) with an 'error' history entry and an agent:error:report — deliberately
 * different from markTaskError, which would move the task to the error column.
 * Claim/reservation release on failure is handled by executeRunAgent's finally.
 *
 * Exported for services/__tests__/agentWorkspacePrep.test.ts, which pins the
 * "runner is prepared even when no switch is needed" behavior at this call site.
 *
 * @returns {{ ok: true } | { ok: false; result: ActionResult }}
 */
export async function _ensureAgentOnTaskRepo(
  agent: Agent,
  task: Task,
  actualTask: Task | null,
  { agentManager, mode, agentId: _agentId }: EnsureRepoContext
): Promise<{ ok: true } | { ok: false; result: ActionResult }> {
  await waitForProjectSwitch(agent);
  // Auto-switch agent to the task's repo if needed.
  // ONLY `repoFullName` ("owner/repo", set on creation, by GitHub sync or via
  // the task UI) designates a repo. `task.project` is NOT one: rowToTask
  // hydrates it from `projects.name` through the board, so it is a human label
  // ("Pulsar"). Using it as a fallback made every repo-less task on a named
  // project try to switch to a repo that has no clone URL, and then fail the
  // verify below. No repo on the task → keep the agent on its own repo.
  const taskRepo = isValidRepoFullName(task.repoFullName) ? task.repoFullName : null;
  const secondaryRepos = Array.isArray(task.secondaryRepos) ? task.secondaryRepos : [];

  // NO early return when the agent is already on the task's repo. `agent.project`
  // is API-side state that outlives the runner container, so "already on it" is
  // exactly the case where a recycled runner has neither a clone nor
  // ~/.git-credentials — the "could not read Username for 'https://github.com'"
  // failures. ensureAgentWorkspace re-ensures idempotently (60s TTL debounce);
  // see services/execution/agentWorkspace.ts.
  const needsPrimarySwitch = !!taskRepo && taskRepo !== agent.project;
  if (needsPrimarySwitch || secondaryRepos.length > 0) {
    console.log(
      `[ActionExecutor] Ensuring "${agent.name}" on repo "${taskRepo || '(none)'}"${secondaryRepos.length ? ` (+${secondaryRepos.length} secondary)` : ''}`
    );
  }
  // Hoisted so the catch can tell a missing token from a rejected one when the
  // clone fails with a GitHub auth error.
  let gitCreds: AgentGitCredentials | null = null;
  try {
    // Select the runner before provisioning: an unbound agent defaults to the
    // sandbox, while terminal injection later binds it to its CLI container.
    await bindAgentRunner(agentManager, agent);
    gitCreds = await resolveAgentGitCredentials(agent);
    const { switched } = await ensureAgentWorkspace(agentManager.executionManager, agent, {
      repo: taskRepo,
      repoHtmlUrl: task.repoHtmlUrl,
      secondaryRepos,
      gitCredentials: gitCreds,
    });
    if (switched && agentManager._switchProjectContext) {
      agentManager._switchProjectContext(agent, agent.project, taskRepo);
    }
    if (taskRepo) {
      agent.project = taskRepo;
      if (switched) agent.projectChangedAt = new Date().toISOString();
      // Terminal upgrades read the DB. Commit the task's repo before sending
      // its prompt, or opening the terminal can restore the previous repo.
      await saveAgent(agent);
      agentManager._emit?.('agent:updated', agentManager._sanitize(agent));
    }
    // A blocked card can retain an older authentication error even after a
    // human reconnects GitHub. Do not inject it as a current failure into the
    // new prompt: agents would stop without testing the repaired connection.
    await clearTaskErrorForRun(agentManager, actualTask || task);
    task.error = null;
    task.errorFromStatus = null;
    return { ok: true };
  } catch (switchErr) {
    console.error(
      `[ActionExecutor] Project switch failed for "${agent.name}": ${errorMessage(switchErr)}`
    );
    const switchErrTimestamp = new Date().toISOString();
    // Recognise a Git authentication failure (private repo + missing/expired
    // token) and surface a clear, actionable alert instead of the cryptic git
    // stderr ("could not read Username …"). This is the UI alert that tells the
    // user a repo-bound task can't run because GitHub isn't connected.
    const raw = errorMessage(switchErr);
    const reconnectRequired = isGitHubReconnectRequired(switchErr);
    const isAuthFailure =
      reconnectRequired ||
      /could not read Username|Authentication failed|terminal prompts disabled|fatal: could not read|HTTP 40[13]\b|Permission denied|invalid username or password|access denied|repository not found/i.test(
        raw
      );
    let taskError: string;
    let alertDescription: string;
    if (isAuthFailure) {
      const why =
        reconnectRequired || gitCreds?.token
          ? `the GitHub token configured for this agent or its board was rejected (expired, or it lacks access to "${taskRepo}")`
          : `no GitHub token is configured for this agent or its board`;
      taskError = `GitHub authentication failed for "${taskRepo}": ${why}. Connect or reconnect GitHub for the agent/board, then retry the task.`;
      alertDescription = `[GitHub] ${agent.name}: ${taskError}`;
    } else {
      taskError = `Project switch failed: ${raw}`;
      alertDescription = `[System Error] Project switch failed for "${agent.name}": ${raw}`;
    }
    // Targeted: only the error and its history entry (the run's claim is
    // released by executeRunAgent's finally). executeRunAgent always passes the
    // claimed row, owned or board-level.
    if (actualTask) {
      const target = actualTask;
      target.error = taskError;
      await persistThenEmit(agentManager, target, {
        fields: {
          error: taskError,
          historyAppend: [
            {
              status: target.status,
              at: switchErrTimestamp,
              by: agent.name || 'workflow',
              type: 'error',
              error: taskError,
              actionMode: mode,
            },
          ],
        },
      });
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
 *
 * Lifecycle (one live run per agent — never two tasks at once):
 *   select → reserve (in-process) → [CLI quiet?] → claim (DB) → prepare →
 *   run + wait (+ drain, inside the wait) → reconcile commits → release.
 */
async function executeRunAgent(
  action: WorkflowAction,
  task: Task,
  { agentManager, io, ownerId, workflow, onRunClaimed }: ActionContext
): Promise<ActionResult> {
  // Default to DECIDE for a run_agent action with no explicit mode (also the
  // landing spot for legacy 'execute' actions, which configManager maps to
  // 'decide' at load — see mapLegacyExecuteMode).
  const mode = action.mode || AgentMode.DECIDE;
  const role = action.role || '';
  const instructions = action.instructions || '';
  const columns = workflow?.columns || [];

  const lockKey = `${task.agentId}:${task.id}:${mode}`;
  // Find agent for this role (scoped to the task's board, preferring agents
  // already on the task's repo so we don't have to project-switch every run).
  // Precompute owned-task counts from the DB for the (sync) load-balancer, and
  // refresh which agents hold a run claim anywhere (sibling stack included).
  const [tasksByAgent] = await Promise.all([
    agentManager._tasksByAgentMap(),
    refreshClaimedAgents(),
  ]);
  const agent = findAgentByRole(
    agentManager.agents,
    role,
    ownerId,
    (agentId: any) => tasksByAgent.get(agentId) || [],
    task.boardId || null,
    task.repoFullName || null
  ) as any;

  if (!agent) {
    console.log(
      `[ActionExecutor] run_agent: no idle agent for role "${role}" — task stays pending`
    );
    return { executed: false, skipped: true, reason: 'no-idle-agent' };
  }

  const releaseReservation = reserveAgentForTask(agent.id, task.id, lockKey);
  if (!releaseReservation) {
    console.log(
      `[ActionExecutor] run_agent: agent or task already reserved agent="${agent.id}" task="${task.id}"`
    );
    return { executed: false, skipped: true, reason: 'lock-held' };
  }

  let claim: ClaimResult | null = null;
  try {
    // A fresh run_agent execution is starting — we've passed the durable
    // executionStatus='stopped' gate in processColumnEntry. Drop the run-scoped
    // signals of a PRIOR lifecycle (a residual 'stopped' would abort this run, a
    // residual 'completed' end it the moment its prompt is pasted) BEFORE the
    // claim: a Stop landing from here on is either refused by the claim (durable
    // 'stopped') or still raised when the run looks.
    agentManager._clearRunSignals(task.id);

    // Only decide drives the CLI's terminal (the other modes ask a headless turn).
    // Never paste into a terminal that is still busy: after an API restart, or
    // while someone types in it, the runner would paste anyway.
    const terminalDriven =
      mode === AgentMode.DECIDE &&
      isCliRunner(agent) &&
      !!agentManager.executionManager?.sendTerminalInput;
    if (terminalDriven && !(await agentManager._isCliQuiet(agent.id))) {
      console.log(
        `[ActionExecutor] run_agent: "${agent.name}"'s terminal is still active — task="${task.id}" stays pending`
      );
      // Mark it busy until its CLI goes quiet, so the next selection picks
      // another agent of the role instead of this one again and again.
      noteCliActivity(agentManager, agent.id, 'CLI still active');
      return { executed: false, skipped: true, reason: 'cli-busy' };
    }

    // The durable claim — exclusive per task and per agent across every process
    // sharing the database, and only while the task is still in this column.
    // From here the card shows the run (spinner, Stop).
    claim = await claimRun(task.id, agent.id, mode, {
      expectStatus: task.status,
      onLost: () => setTaskSignal(task.id, 'stopped', true),
    });
    if (!claim.ok) {
      return { executed: false, skipped: true, reason: `claim-${claim.reason}` };
    }
    // The claim now fences the task across replicas: the advisory lock a
    // recheck-dispatched chain holds is no longer needed for the long run below.
    onRunClaimed?.();

    // The executing agent is the card's assignee for the duration of the run.
    let actualTask: Task = claim.task;
    if (actualTask.assignee !== agent.id) {
      actualTask =
        (await updateTaskFields(task.id, {
          assignee: agent.id,
          historyAppend: [reassignEntry(actualTask, agent.id)],
        })) || actualTask;
      task.assignee = agent.id;
    }
    emitTaskUpdated(agentManager, { ...actualTask }, { emitAgent: false, stampUpdatedAt: true });

    // An external task runs confined, from an empty context; a regular task
    // run on an agent that was confined releases it, also from an empty context
    // (security/externalRunProfile.ts). Before any bind, so the runner sees the
    // narrowed permissions, and before the task text reaches the agent.
    await enterRunProfileForTask(agentManager, agent, task);

    let execStartMsgIdx;
    let execStartedAt;
    let commitRunStarted = false;
    try {
      // Auto-switch agent to the task's repo if needed.
      const switched = await _ensureAgentOnTaskRepo(agent, task, actualTask, {
        agentManager,
        mode,
        agentId: task.agentId,
      });
      if (!switched.ok) return switched.result;
      // Only decide executes the task; the other modes rewrite its card.
      if (mode === AgentMode.DECIDE) {
        task.materializedAttachments = await deliverTaskAttachments(
          agentManager.executionManager,
          agent.id,
          task.id
        );
      }
      execStartMsgIdx = (agent.conversationHistory || []).length;
      execStartedAt = new Date().toISOString();

      // Open the commit window of a decide run (the only mode that executes
      // code): snapshot the baselines and persist the run context. The finally
      // links every commit made during the run — the only detection that works
      // for CLI runners, whose git activity happens inside their PTY.
      if (mode === AgentMode.DECIDE) {
        await startTaskCommitRun(agentManager, agent.id, task, execStartedAt);
        commitRunStarted = true;
      }

      let result: ActionResult;
      switch (mode) {
        case AgentMode.TITLE:
          result = await _runSimpleMode('title', agent, task, {
            agentManager,
            io,
            execStartMsgIdx,
            execStartedAt,
          });
          break;
        case AgentMode.SET_TYPE:
          result = await _runSimpleMode('set_type', agent, task, {
            agentManager,
            io,
            execStartMsgIdx,
            execStartedAt,
          });
          break;
        case AgentMode.REFINE:
          result = await _runRefineMode(agent, task, instructions, {
            agentManager,
            io,
            execStartMsgIdx,
            execStartedAt,
          });
          break;
        case AgentMode.DECIDE:
          result = await _runDecideMode(agent, task, instructions, columns, {
            agentManager,
            io,
            execStartMsgIdx,
            execStartedAt,
            gitBaselineHead: getTaskCommitRun(agentManager, agent.id)?.baselineHead ?? null,
          });
          break;
        default:
          console.warn(`[ActionExecutor] Unknown mode: ${mode}`);
          result = {
            executed: false,
            error: true,
            message: `Workflow misconfigured: unknown run_agent mode "${mode}"`,
          };
      }

      return result;
    } catch (caught) {
      let err = caught;
      if (err instanceof ToolBudgetReachedError) {
        const attempts = (agentManager._decideNoDecisionCounts.get(task.id) || 0) + 1;
        agentManager._decideNoDecisionCounts.set(task.id, attempts);
        if (attempts < MAX_DECIDE_NO_DECISION) {
          await agentManager._saveExecutionLog(
            task.agentId,
            task.id,
            agent.id,
            execStartMsgIdx,
            execStartedAt,
            false,
            mode
          );
          return { executed: false, skipped: true, reason: 'tool-budget' };
        }
        agentManager._decideNoDecisionCounts.delete(task.id);
        err = new Error(
          'Tool limit reached on four consecutive turns. Work is incomplete; resume from the saved results or narrow the task.'
        );
      }
      // Distinguish a user-triggered Stop from a real failure. stopAgent() aborts
      // the in-flight stream and llmProviders throws "Agent stopped by user",
      // which propagates up here. Without this check, a user pressing Stop on a
      // running workflow action would flip the task to status=error — and if
      // that errorFromStatus path ever clobbers itself, the task disappears
      // from the board entirely.
      if (isUserStopError(err)) {
        console.log(
          `[ActionExecutor] run_agent stopped by user for "${task.text?.slice(0, 60)}" (mode=${mode}) — not marking as error`
        );
        await agentManager._saveExecutionLog(
          task.agentId,
          task.id,
          agent.id,
          execStartMsgIdx,
          execStartedAt,
          false,
          mode
        );
        // Belt-and-suspenders: ensure executionStatus=stopped is durable even
        // if stopAgent's iteration missed this task (e.g. race between assign
        // and stop). The in-memory 'stopped' signal is set by stopAgent itself.
        try {
          await updateTaskExecutionStatus(task.id, 'stopped');
        } catch {
          /* best-effort */
        }
        return { executed: false, skipped: true, reason: 'user-stop' };
      }

      console.error(
        `[ActionExecutor] run_agent error for "${task.text?.slice(0, 60)}":`,
        errorMessage(err)
      );
      // Save error execution log
      await agentManager._saveExecutionLog(
        task.agentId,
        task.id,
        agent.id,
        execStartMsgIdx,
        execStartedAt,
        false,
        mode
      );
      // Emit system error report so leader + frontend are notified
      const errorTimestamp = new Date().toISOString();
      agentManager._emit('agent:error:report', {
        agentId: agent.id,
        agentName: agent.name,
        project: agent.project || task.project || null,
        description: `[System Error] Workflow action "${mode}" failed for task "${task.text?.slice(0, 100)}": ${errorMessage(err)}`,
        timestamp: errorTimestamp,
        isSystemError: true,
        taskId: task.id,
      });
      // The error is persisted once, by the chain (WorkflowEngine), from the
      // { error } result — markTaskError keeps the task visible on the board.
      return { executed: false, error: true, message: errorMessage(err) };
    } finally {
      // End-of-run commit/push reconcile — runs whichever way the run ended
      // (update_task completion, status-only move, no-decision retry, error,
      // user stop) and AFTER the CLI went quiet (the wait drains it), so the
      // run's last commits are linked to THIS task. Idempotent (prefix-aware
      // dedup), so overlap with the mid-run sweep and recordTaskCompletion is
      // harmless.
      if (commitRunStarted) {
        await finishTaskCommitRun(agentManager, agent.id, task.id, 'RunEndReconcile');
      }
    }
  } finally {
    if (claim?.ok) {
      claim.stopHeartbeat();
      // Release the claim — only while it is still this run's — and drop the
      // executor as assignee if it still is (a user may have reassigned the task
      // meanwhile): workflow modes do not leave the agent as the permanent
      // assignee. Emit the FRESH row: a decide agent may have moved the task
      // during the run, and re-emitting the pre-run column bounced the card back.
      // A board-level task (no owning agent) keeps its executor as assignee: it
      // is the only agent link the card has.
      const released = await releaseRunClaim(task.id, agent.id, { clearAssignee: !!task.agentId });
      if (released) {
        emitTaskUpdated(agentManager, { ...released }, { emitAgent: false, stampUpdatedAt: true });
      }
    }
    releaseReservation();
  }
}

// ── Mode-specific handlers ──────────────────────────────────────────────────

/**
 * Run `body` between a streamStart and a streamEnd+agentUpdated finally.
 * The finally wraps the ENTIRE body (including post-processing and any nested
 * waits) so the wire-order of streamEnd/agentUpdated is byte-identical to the
 * pasted copies: they always fire last, after the body's awaits and returns.
 */
async function _withAgentStream<T>(
  agentManager: AgentManager,
  agentId: string,
  body: () => Promise<T>
): Promise<T> {
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
function _makeStreamCollector(agentManager: AgentManager, agentId: string, buf: { text: string }) {
  return (chunk: string) => {
    buf.text += chunk;
    agentManager.wsEmitter.streamChunk(agentId, chunk);
    agentManager.wsEmitter.thinking(agentId);
  };
}

// Simple (non-streaming) modes share an identical body: slice the description,
// sendMessage, post-process the raw response, save the execution log, and emit
// agentUpdated in a finally. Only the prompt builder, the announce message, and
// the response post-processing differ — captured in SIMPLE_MODES.
const SET_TYPE_VALID_TYPES = [
  'bug',
  'feature',
  'technical',
  'improvement',
  'documentation',
  'other',
];

/**
 * Write a run_agent mode result (title, type, refined text) on the task —
 * awaited, by task id, as a targeted update. The un-awaited owner-keyed edit
 * it replaces silently did nothing on board-level tasks (no owner agent), and
 * its full-row save could land after the run's cleanup and resurrect the
 * finished run's claim, or be reverted by the chain's next write.
 */
async function _applyModeResult(
  agentManager: AgentManager,
  task: Task,
  field: 'title' | 'taskType' | 'text',
  value: string,
  by: string
) {
  const current = await getTaskById(task.id);
  if (!current) return;
  const oldValue = (current as any)[field] ?? null;
  if (oldValue === value) return;
  const updated = await updateTaskFields(task.id, {
    [field]: value,
    historyAppend: [
      {
        status: current.status,
        at: new Date().toISOString(),
        by,
        type: 'edit',
        field,
        oldValue,
        newValue: value,
      },
    ],
  });
  if (!updated) return;
  (task as any)[field] = value;
  emitTaskUpdated(agentManager, { ...updated }, { stampUpdatedAt: true });
}

const SIMPLE_MODES = {
  title: {
    buildPrompt: buildTitlePrompt,
    announce: (task: Task, agentName: string) =>
      `[ActionExecutor] title: generating for "${task.text?.slice(0, 60)}" via ${agentName}`,
    apply: async (agentManager: AgentManager, task: Task, raw: string, _agentName: string) => {
      const title = (raw || '').trim().replace(/^["']|["']$/g, '');
      if (title) {
        await _applyModeResult(agentManager, task, 'title', title, 'user');
        console.log(`[ActionExecutor] title: "${title}"`);
      }
    },
  },
  set_type: {
    buildPrompt: buildSetTypePrompt,
    announce: (task: Task, agentName: string) =>
      `[ActionExecutor] set_type: classifying "${task.text?.slice(0, 60)}" via ${agentName}`,
    apply: async (agentManager: AgentManager, task: Task, raw: string, agentName: string) => {
      const rawType = (raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z_]/g, '');
      const taskType = SET_TYPE_VALID_TYPES.includes(rawType) ? rawType : 'other';
      await _applyModeResult(agentManager, task, 'taskType', taskType, agentName);
      console.log(`[ActionExecutor] set_type: "${taskType}"`);
    },
  },
} as const;

async function _runSimpleMode(
  modeName: 'title' | 'set_type',
  agent: Agent,
  task: Task,
  { agentManager, io: _io, execStartMsgIdx, execStartedAt }: ModeRunContext
): Promise<ActionResult> {
  const { buildPrompt, announce, apply } = SIMPLE_MODES[modeName];
  const maxLen = agent.contextLength || 4000;
  const description = (task.text || '').slice(0, maxLen);
  const prompt = buildPrompt(description, isExternalTask(task));

  console.log(announce(task, agent.name));

  try {
    const result = await agentManager.sendMessage(agent.id, prompt, () => {}, 0, {
      type: 'workflow-action',
      mode: modeName,
      taskId: task.id,
      currentStatus: task.status,
    });
    await apply(agentManager, task, result, agent.name);
    await agentManager._saveExecutionLog(
      task.agentId,
      task.id,
      agent.id,
      execStartMsgIdx,
      execStartedAt,
      true,
      modeName
    );
  } catch (err) {
    if (err instanceof ToolBudgetReachedError) throw err;
    console.error(`[ActionExecutor] ${modeName} failed:`, errorMessage(err));
    await agentManager._saveExecutionLog(
      task.agentId,
      task.id,
      agent.id,
      execStartMsgIdx,
      execStartedAt,
      false,
      modeName
    );
  } finally {
    agentManager.wsEmitter.agentUpdated(agent.id);
  }

  return { executed: true };
}

async function _runRefineMode(
  agent: Agent,
  task: Task,
  instructions: string,
  { agentManager, io: _io, execStartMsgIdx, execStartedAt }: ModeRunContext
): Promise<ActionResult> {
  const prompt = buildRefinePrompt(task, instructions);
  console.log(`[ActionExecutor] refine: "${task.text?.slice(0, 60)}" via ${agent.name}`);

  const buf = { text: '' };

  await _withAgentStream(agentManager, agent.id, async () => {
    const workflowMeta = {
      type: 'workflow-action',
      mode: 'refine',
      taskId: task.id,
      currentStatus: task.status,
    };
    const result = await agentManager.sendMessage(
      agent.id,
      `[Auto-Transition] ${prompt}`,
      _makeStreamCollector(agentManager, agent.id, buf),
      0,
      workflowMeta
    );

    const response = (result?.content || buf.text).trim();
    await agentManager._saveExecutionLog(
      task.agentId,
      task.id,
      agent.id,
      execStartMsgIdx,
      execStartedAt,
      true,
      'refine'
    );

    if (response) await _applyModeResult(agentManager, task, 'text', response, 'user');
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

async function _runDecideMode(
  agent: Agent,
  task: Task,
  instructions: string,
  columns: WorkflowColumn[],
  { agentManager, io: _io, execStartMsgIdx, execStartedAt, gitBaselineHead = null }: ModeRunContext
): Promise<ActionResult> {
  if (!instructions) {
    console.log(`[ActionExecutor] decide: no instructions — failing`);
    return {
      executed: false,
      error: true,
      message: 'Workflow misconfigured: decide action has no instructions',
    };
  }

  const prompt = buildInstructionsPrompt(task, instructions, columns);
  console.log(`[ActionExecutor] decide: "${task.text?.slice(0, 60)}" via ${agent.name}`);

  // Snapshot task state so we can detect whether the agent actually made a
  // decision (moved the task to a new status, or appended details). Detection
  // is by task mutation, whether the agent used a direct native tool or the
  // update_task MCP tool exposed to a CLI runner.
  const beforeTask = await _liveTaskSnapshot(agentManager, task);
  const beforeStatus = beforeTask?.status ?? task.status;
  const beforeTextLen = (beforeTask?.text || '').length;

  const buf = { text: '' };
  let waitResult: string | null = null;

  // CLI runners drive their interactive PTY (visible in the terminal tab) and
  // signal via their MCP tools — never the headless sendMessage path, which
  // spawns a separate invisible claude process that also conflicts with the
  // shared PTY. The agent's decision lands as a task mutation (update_task MCP)
  // which the before/after comparison below detects.
  if (isCliRunner(agent) && agentManager.executionManager?.sendTerminalInput) {
    console.log(
      `[ActionExecutor] decide: injecting prompt into CLI terminal for "${agent.name}" (status=${agent.status})`
    );
    waitResult = await _runViaCliTerminal(agentManager, agent, task, prompt, gitBaselineHead);
    _throwIfWaitError(
      agentManager,
      task,
      waitResult,
      'Claude Code CLI ended in an authentication or runtime error'
    );
    // Hand over the prompt we pasted into the TUI: a CLI run records nothing in
    // conversationHistory, so this is the only way the history entry can show
    // what the agent was actually asked to do.
    await agentManager._saveExecutionLog(
      task.agentId,
      task.id,
      agent.id,
      execStartMsgIdx,
      execStartedAt,
      true,
      'decide',
      { prompt }
    );
  } else if (getTaskSignal(task.id, 'stopped')) {
    // Stopped while the run was being prepared: no turn to abort yet.
    waitResult = 'stopped';
  } else {
    await _withAgentStream(agentManager, agent.id, async () => {
      const workflowMeta = {
        type: 'workflow-action',
        mode: 'decide',
        taskId: task.id,
        currentStatus: task.status,
        validStatuses: columns.map(c => c.id),
        nextStatus: nextColumnAfter(task.status, columns)?.id || null,
        instructions,
      };
      await agentManager.sendMessage(
        agent.id,
        prompt,
        _makeStreamCollector(agentManager, agent.id, buf),
        0,
        workflowMeta
      );

      await agentManager._saveExecutionLog(
        task.agentId,
        task.id,
        agent.id,
        execStartMsgIdx,
        execStartedAt,
        true,
        'decide'
      );
    });
  }

  // Verify the agent actually made a decision: status changed OR details appended.
  const afterTask = await _liveTaskSnapshot(agentManager, task);
  const afterStatus = afterTask?.status ?? task.status;
  const afterTextLen = (afterTask?.text || '').length;
  const decided = afterStatus !== beforeStatus || afterTextLen !== beforeTextLen;

  // A Stop is the user's decision, not the agent's failure to make one: it must
  // not count towards MAX_DECIDE_NO_DECISION (four Stops used to error the task
  // with a false "assign the Swarm API MCP" diagnosis). The chain flags the
  // action for retry, which the durable 'stopped' status holds until a resume.
  if (!decided && waitResult === 'stopped') {
    console.log(
      `[ActionExecutor] decide: stopped by user for task="${task.id}" — no decision recorded`
    );
    return { executed: false, skipped: true, reason: 'user-stop' };
  }

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
        ? `Agent "${agent.name}" (CLI runner) produced no decision after ${attempts} attempts. It likely has no tool to update the task — assign the Swarm API MCP (update_task) to this agent.`
        : `Agent "${agent.name}" produced no update_task call after ${attempts} attempts.`;
      console.error(`[ActionExecutor] decide: ${why} — failing task="${task.id}"`);
      // Throw so executeRunAgent's catch marks the task error (visible on the
      // board, with the message) and stops the retry loop.
      throw new Error(`Decide action failed: ${why}`);
    }

    console.warn(
      `[ActionExecutor] decide: agent "${agent.name}" produced no decision for task="${task.id}" (attempt ${attempts}/${MAX_DECIDE_NO_DECISION}) — flagging for retry`
    );
    return { executed: false, skipped: true, reason: 'no-decision' };
  }

  // Decision made — clear the no-decision counter.
  agentManager._decideNoDecisionCounts.delete(task.id);
  console.log(
    `[ActionExecutor] decide: completed for task="${task.id}" "${task.text?.slice(0, 60)}"`
  );
  return { executed: true };
}
