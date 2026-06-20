// ─── Per-tool handlers for _processToolCalls ─────────────────────────────────
// One handler per tool, registered in HANDLERS. The dispatch loop (see tools.ts)
// calls `const h = HANDLERS[call.tool]; if (h) { const r = await h(ctx); if (r)
// results.push(r); continue; }` before falling through to the generic
// executeTool path. A handler returns the result object to push, or null to push
// nothing (used by the in-response dedup early-outs).
//
// This is a pure copy-move of the former inline if-chain — result envelopes,
// logging, side effects, and ordering are preserved verbatim. `ctx.mgr` is the
// AgentManager instance (handlers do not rely on `this`).

import {
  saveAgent, searchAgentSkills, getAgentSkillById, saveAgentSkill, deleteAgentSkillFromDb,
  getAllBoards, getBoardById, getTasksByStatusAndBoard, saveTaskToDb,
} from '../../database.js';
import { getWorkflowForBoard } from '../../configManager.js';
import { checkToolHooks } from '../../toolHooks.js';
import { findBuiltinMcpServer } from '../../mcpManager.js';
import { v4 as uuidv4 } from 'uuid';

export interface HandlerCtx {
  mgr: any;
  agent: any;
  agentId: string;
  call: any;
  streamCallback: any;
  dedup: Record<string, boolean>;
}

export type ToolHandler = (ctx: HandlerCtx) => Promise<any | null>;

/** Append an agent's note onto a task's description + a matching {type:'edit'}
 * history entry. `stampUpdatedAt` stamps task.updatedAt when no setTaskStatus
 * follows (recordTaskCompletion passes true; callers that move the task right
 * after can pass false since setTaskStatus stamps updatedAt itself). */
export function appendTaskNote(task: any, agentName: string, note: string, stampUpdatedAt: boolean): void {
  const separator = '\n\n---\n';
  const detailBlock = `**[${agentName}]** ${note.trim()}`;
  task.text = (task.text || '') + separator + detailBlock;
  if (!task.history) task.history = [];
  task.history.push({
    status: task.status,
    at: new Date().toISOString(),
    by: agentName,
    type: 'edit',
    field: 'text',
    oldValue: null,
    newValue: detailBlock,
  });
  if (stampUpdatedAt) task.updatedAt = new Date().toISOString();
}

/** Resolve board ids → display names for a set of tasks. `swallowErrors`
 * mirrors the per-call difference: list_my_tasks try/catches per board (falling
 * back to the id), list_tasks lets a getBoardById throw bubble to its outer
 * catch. */
async function resolveBoardNames(tasks: any[], swallowErrors: boolean): Promise<Record<string, string>> {
  const boardNames: Record<string, string> = {};
  for (const t of tasks as any[]) {
    const bid = (t as any).boardId;
    if (bid && !boardNames[bid]) {
      if (swallowErrors) {
        try {
          const board = await getBoardById(bid);
          boardNames[bid] = board?.name || bid;
        } catch { boardNames[bid] = bid; }
      } else {
        const board = await getBoardById(bid);
        boardNames[bid] = board?.name || bid;
      }
    }
  }
  return boardNames;
}

// ── @report_error() ──
const handleReportError: ToolHandler = async ({ mgr, agent, agentId, call, streamCallback }) => {
  const errorDescription = call.args[0] || 'Unknown error';
  console.log(`🚨 [Error Report] Agent "${agent.name}" reports: ${errorDescription.slice(0, 200)}`);
  mgr._emit('agent:error:report', {
    agentId,
    agentName: agent.name,
    project: agent.project || null,
    description: errorDescription,
    timestamp: new Date().toISOString()
  });
  if (streamCallback) {
    streamCallback(`\n\n🚨 **Error reported by ${agent.name}:** ${errorDescription}\n`);
  }
  return {
    tool: 'report_error',
    args: call.args,
    success: true,
    result: `Error reported: ${errorDescription}`,
    isErrorReport: true
  };
};

// ── @update_task() ──
// The task tool: change status AND/OR record completion. Args are
// (taskId, status?, comment?, commits?). Passing a comment (or commits) appends
// the summary, links commits, and fires the execute-mode completion signal. A
// status move to a non-active column finishes workflow waits, so the common
// "done" call is @update_task(taskId, nextColumn, "summary").
const handleUpdateTask: ToolHandler = async ({ mgr, agent, agentId, call }) => {
  const [taskId, rawStatus, comment, commits] = call.args;
  let task: any = mgr._getAgentTasks(agentId).find((t: any) => t.id === taskId);
  if (!task) task = mgr._getAgentTasks(agentId).find((t: any) => t.id.startsWith(taskId));
  let taskAgentId = agentId;
  if (!task) {
    const found = mgr._findTaskByIdOrPrefix(taskId);
    if (found) {
      task = found.task;
      taskAgentId = found.agentId;
    }
  }
  if (!task) {
    const partial = mgr._getAgentTasks(agentId).find((t: any) => t.id.startsWith(taskId.slice(0, 8)));
    const hint = partial ? ` Maybe you meant ${partial.id.slice(0, 8)} which is currently "${partial.status}"?` : '';
    return { tool: 'update_task', args: call.args, success: false, error: `Task not found: ${taskId}.${hint}` };
  }

  const hasStatus = Boolean(rawStatus && String(rawStatus).trim());
  const hasCompletion = Boolean((comment && String(comment).trim()) || (commits && String(commits).trim()));
  if (!hasStatus && !hasCompletion) {
    return {
      tool: 'update_task',
      args: call.args,
      success: false,
      error: 'Provide a status and/or a comment. Use @update_task(taskId, status) to move it, or @update_task(taskId, status, "summary") to finish it.',
    };
  }

  // Validate status against the board workflow. Agents must move tasks
  // only to columns that exist in the board — otherwise the task lands
  // in an invisible/unreachable state. Case-insensitive match is used
  // so "Resolution" still resolves to "resolution". Strict: if we can't
  // confirm the status is a valid column we reject.
  let newStatus = rawStatus;
  if (hasStatus) {
    if (!task.boardId) {
      return { tool: 'update_task', args: call.args, success: false, error: `Cannot update status: task ${task.id} is not bound to a board.` };
    }
    let wf: any;
    try {
      wf = await getWorkflowForBoard(task.boardId);
    } catch (err: any) {
      return { tool: 'update_task', args: call.args, success: false, error: `Cannot validate status: failed to load workflow for board ${task.boardId} (${err?.message || 'unknown error'}).` };
    }
    if (!wf?.columns?.length) {
      return { tool: 'update_task', args: call.args, success: false, error: `Cannot update status: board ${task.boardId} has no workflow columns configured.` };
    }
    const match = wf.columns.find((c: any) => c.id.toLowerCase() === String(rawStatus).toLowerCase());
    if (!match) {
      const validIds = wf.columns.map((c: any) => c.id).join(', ');
      return { tool: 'update_task', args: call.args, success: false, error: `Invalid status "${rawStatus}" for this task's board. Valid columns: ${validIds}.` };
    }
    if (match.id !== rawStatus) {
      console.log(`[UpdateTask] Normalizing status "${rawStatus}" → "${match.id}"`);
    }
    newStatus = match.id;
  }

  // Completion bookkeeping FIRST (while the task is still active): append the
  // summary, link commits, and fire the execute-mode completion signal. In
  // decide/refine mode it only appends the summary; the status move below
  // advances the workflow.
  let completed = false;
  if (hasCompletion) {
    const outcome = await mgr.recordTaskCompletion(taskAgentId, {
      comment: comment || '',
      explicitTaskId: task.id,
      commitsArg: (commits || '').trim(),
    });
    completed = Boolean(outcome?.isTerminal);
  }

  // Status move.
  let moved = false;
  if (hasStatus) {
    const updated = mgr.setTaskStatus(taskAgentId, task.id, newStatus, { skipAutoRefine: false, by: agent.name });
    moved = Boolean(updated);
    if (!moved && !hasCompletion) {
      return { tool: 'update_task', args: call.args, success: false, error: `Cannot move task to "${newStatus}" (blocked by guard or same status).` };
    }
  }
  console.log(`📋 [Task] Agent "${agent.name}" updated task "${task.text.slice(0, 50)}"${hasStatus ? ` → ${newStatus}` : ''}${hasCompletion ? ' (finished)' : ''}`);

  // Stop the chat loop when the task is done: in workflow action modes (decide,
  // refine, …) any status change is terminal; in execute mode a recorded
  // completion is terminal.
  const isWorkflowMode = task.actionRunningMode && task.actionRunningMode !== 'execute';
  const isTerminal = (isWorkflowMode && hasStatus) || completed;
  const parts = [hasStatus && moved ? `moved to ${newStatus}` : null, hasCompletion ? 'marked finished' : null].filter(Boolean);
  return { tool: 'update_task', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" ${parts.join(' and ') || 'updated'}`, isTerminal: isTerminal || undefined };
};

// ── @move_task_to_board() ──
const handleMoveTaskToBoard: ToolHandler = async ({ mgr, agent, agentId, call }) => {
  const [taskId, targetBoardId] = call.args;
  if (!taskId || !targetBoardId) {
    return { tool: 'move_task_to_board', args: call.args, success: false, error: 'Both taskId and boardId are required. Use: @move_task_to_board(taskId, boardId)' };
  }
  // Find the task across all agents
  const moveFound = mgr._findTaskByIdOrPrefix(taskId);
  const task: any = moveFound?.task || null;
  const taskAgentId = moveFound?.agentId || agentId;
  if (!task) {
    return { tool: 'move_task_to_board', args: call.args, success: false, error: `Task not found: ${taskId}` };
  }
  // Verify target board exists
  const targetBoard = await getBoardById(targetBoardId);
  if (!targetBoard) {
    return { tool: 'move_task_to_board', args: call.args, success: false, error: `Board not found: ${targetBoardId}` };
  }
  const oldBoardId = task.boardId;
  const oldStatus = task.status;
  task.boardId = targetBoardId;
  // Check if current status exists in target board's workflow, otherwise reset to first column
  if (targetBoard.workflow?.columns) {
    const hasStatus = targetBoard.workflow.columns.some((c: any) => c.id === task.status);
    if (!hasStatus && targetBoard.workflow.columns.length > 0) {
      const firstCol = targetBoard.workflow.columns[0].id;
      console.log(`📋 [MoveBoard] Task status "${task.status}" not found in target board — resetting to "${firstCol}"`);
      task.status = firstCol;
    }
  }
  const statusChanged = task.status !== oldStatus;
  const previousAssignee = statusChanged ? (task.assignee || null) : null;
  if (previousAssignee) task.assignee = null;
  if (!task.history) task.history = [];
  task.history.push({
    status: task.status,
    at: new Date().toISOString(),
    by: agent.name,
    type: 'board_move',
    oldBoardId,
    newBoardId: targetBoardId,
    ...(statusChanged ? { from: oldStatus } : {}),
    ...(previousAssignee ? { assignee: null, previousAssignee } : {}),
  });
  try {
    await saveTaskToDb({ ...task, agentId: taskAgentId });
  } catch (err: any) {
    return { tool: 'move_task_to_board', args: call.args, success: false, error: `Failed to persist board move: ${err?.message || err}` };
  }
  const ownerAgent = mgr.agents.get(taskAgentId);
  if (ownerAgent) {
    saveAgent(ownerAgent);
    mgr._emit('agent:updated', mgr._sanitize(ownerAgent));
  }
  const assigneeAgent = task.assignee ? mgr.agents.get(task.assignee) : null;
  mgr._emit('task:updated', {
    agentId: taskAgentId,
    task: {
      ...task,
      agentId: taskAgentId,
      assigneeName: assigneeAgent?.name || null,
      assigneeIcon: assigneeAgent?.icon || null,
    },
  });
  console.log(`📋 [MoveBoard] Agent "${agent.name}" moved task "${task.text.slice(0, 50)}" to board "${targetBoard.name}" (${targetBoardId})`);
  return { tool: 'move_task_to_board', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" moved to board "${targetBoard.name}" (status: ${task.status})` };
};

// ── @delete_task() ──
const handleDeleteTask: ToolHandler = async ({ mgr, agent, agentId, call }) => {
  const taskId = (call.args[0] || '').trim();
  if (!taskId) {
    return { tool: 'delete_task', args: call.args, success: false, error: 'Task ID is required. Use: @delete_task(taskId)' };
  }
  // Find the task across all agents
  const delFound = mgr._findTaskByIdOrPrefix(taskId);
  const task: any = delFound?.task || null;
  const taskAgentId = delFound?.agentId || agentId;
  if (!task) {
    return { tool: 'delete_task', args: call.args, success: false, error: `Task not found: ${taskId}` };
  }
  const deleted = await mgr.deleteTask(taskAgentId, task.id);
  if (deleted) {
    console.log(`🗑️ [DeleteTask] Agent "${agent.name}" deleted task "${task.text.slice(0, 50)}" (${task.id})`);
    return { tool: 'delete_task', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" (${task.id}) deleted successfully.` };
  }
  return { tool: 'delete_task', args: call.args, success: false, error: `Failed to delete task: ${taskId}` };
};

// ── @list_boards() ──
const handleListBoards: ToolHandler = async ({ agent }) => {
  try {
    const boards = await getAllBoards();
    if (boards.length === 0) {
      console.log(`📋 [ListBoards] Agent "${agent.name}" listed ${boards.length} board(s)`);
      return { tool: 'list_boards', args: [], success: true, result: 'No boards found.' };
    }
    const lines = boards.map((b: any) => {
      const cols = b.workflow?.columns?.map((c: any) => c.id).join(', ') || 'none';
      const defaultTag = b.is_default ? ' [DEFAULT]' : '';
      return `- **${b.name}**${defaultTag} (${b.id})\n  Columns: ${cols}`;
    });
    console.log(`📋 [ListBoards] Agent "${agent.name}" listed ${boards.length} board(s)`);
    return { tool: 'list_boards', args: [], success: true, result: `Found ${boards.length} board(s):\n\n${lines.join('\n\n')}` };
  } catch (err: any) {
    return { tool: 'list_boards', args: [], success: false, error: err.message };
  }
};

// ── @list_tasks(status, boardId) ──
const handleListTasks: ToolHandler = async ({ agent, call }) => {
  const statusFilter = (call.args[0] || '').trim() || null;
  const boardFilter = (call.args[1] || '').trim() || null;
  try {
    // Validate that the requested board exists before querying. Without
    // this, an unknown boardId silently returns an empty list which
    // makes agent debugging painful.
    let resolvedBoard: any = null;
    if (boardFilter) {
      resolvedBoard = await getBoardById(boardFilter);
      if (!resolvedBoard) {
        return {
          tool: 'list_tasks',
          args: call.args,
          success: false,
          error: `Board not found: ${boardFilter}. Use @list_boards to discover valid board IDs.`,
        };
      }
      // When both board and status are provided, verify the status
      // exists in that board's workflow. (When only a status is
      // provided we accept it — the agent may be filtering tasks
      // across multiple boards.)
      if (statusFilter && resolvedBoard.workflow?.columns?.length) {
        const match = resolvedBoard.workflow.columns.find(
          (c: any) => c.id?.toLowerCase() === statusFilter.toLowerCase()
        );
        if (!match) {
          const validIds = resolvedBoard.workflow.columns.map((c: any) => c.id).join(', ');
          return {
            tool: 'list_tasks',
            args: call.args,
            success: false,
            error: `Invalid status "${statusFilter}" for board "${resolvedBoard.name || boardFilter}". Valid columns: ${validIds}.`,
          };
        }
      }
    }
    const tasks = await getTasksByStatusAndBoard(statusFilter, boardFilter);
    if (tasks.length === 0) {
      const filterDesc = [statusFilter ? `status="${statusFilter}"` : null, boardFilter ? `board="${boardFilter}"` : null].filter(Boolean).join(', ');
      console.log(`📋 [ListTasks] Agent "${agent.name}" listed tasks (status=${statusFilter || 'all'}, board=${boardFilter || 'all'}) — ${tasks.length} result(s)`);
      return { tool: 'list_tasks', args: call.args, success: true, result: `No tasks found${filterDesc ? ` matching ${filterDesc}` : ''}.` };
    }
    // Group by board for clarity (no try/catch — a throw fails the whole call).
    const boardName = await resolveBoardNames(tasks as any[], false);
    const lines = (tasks as any[]).map((t: any) => {
      const board = t.boardId ? ` [Board: ${boardName[t.boardId] || t.boardId}]` : '';
      const assigneeInfo = t.assignee ? ` (assignee: ${t.assignee.slice(0, 8)})` : '';
      return `- [${t.status}] ${t.id.slice(0, 8)} — ${t.text.slice(0, 100)}${board}${assigneeInfo}`;
    });
    const filterDesc = [statusFilter ? `status="${statusFilter}"` : null, boardFilter ? `board="${boardFilter}"` : null].filter(Boolean).join(', ');
    console.log(`📋 [ListTasks] Agent "${agent.name}" listed tasks (status=${statusFilter || 'all'}, board=${boardFilter || 'all'}) — ${tasks.length} result(s)`);
    return { tool: 'list_tasks', args: call.args, success: true, result: `Found ${tasks.length} task(s)${filterDesc ? ` matching ${filterDesc}` : ''}:\n\n${lines.join('\n')}` };
  } catch (err: any) {
    return { tool: 'list_tasks', args: call.args, success: false, error: err.message };
  }
};

// ── @list_projects() ──
const handleListProjects: ToolHandler = async ({ mgr }) => {
  const projects = await mgr._listAvailableProjects();
  if (projects.length === 0) {
    return { tool: 'list_projects', args: [], success: true, result: 'No projects found.' };
  }
  return { tool: 'list_projects', args: [], success: true, result: `Available projects:\n${projects.join('\n')}` };
};

// ── @list_my_tasks() ──
const handleListMyTasks: ToolHandler = async ({ mgr, agent, agentId, dedup }) => {
  if (dedup.listMyTasksDone) {
    console.log(`[Dedup] Skipping duplicate @list_my_tasks from "${agent.name}"`);
    return null;
  }
  dedup.listMyTasksDone = true;
  // Cross-turn dedup: skip if called recently (within 60s) with unchanged task list
  const now = Date.now();
  const lastCall = agent._lastListMyTasks || 0;
  const taskHash = JSON.stringify(mgr._getAgentTasks(agentId).map((t: any) => `${t.id}:${t.status}`));
  if (now - lastCall < 60000 && agent._lastListMyTasksHash === taskHash) {
    console.log(`[Dedup] Skipping @list_my_tasks from "${agent.name}" — unchanged since ${Math.round((now - lastCall) / 1000)}s ago`);
    return { tool: 'list_my_tasks', args: [], success: true, result: '[Tasks unchanged since last check — focus on your current task]' };
  }
  agent._lastListMyTasks = now;
  agent._lastListMyTasksHash = taskHash;
  const tasks = mgr._getAgentTasks(agentId);
  const header = `Agent: ${agent.name} | Project: ${agent.project || 'none'} | Status: ${agent.status}`;
  if (tasks.length === 0) {
    return { tool: 'list_my_tasks', args: [], success: true, result: `${header}\nNo tasks assigned.` };
  }
  // Resolve board names for display (per-board try/catch falls back to the id).
  const boardNames = await resolveBoardNames(tasks, true);
  const lines = tasks.map((t: any) => {
    const icon = t.status === 'done' ? '[x]' : t.status === 'error' ? '[!]' : mgr._isActiveTaskStatus(t.status) ? '[~]' : '[ ]';
    const boardInfo = t.boardId ? ` [Board: ${boardNames[t.boardId] || t.boardId}]` : '';
    return `${icon} ${t.id} — ${t.text}${boardInfo}`;
  });
  return { tool: 'list_my_tasks', args: [], success: true, result: `${header}\n${lines.join('\n')}` };
};

// ── @check_status() ──
const handleCheckStatus: ToolHandler = async ({ mgr, agent, agentId, dedup }) => {
  if (dedup.checkStatusDone) {
    console.log(`[Dedup] Skipping duplicate @check_status from "${agent.name}"`);
    return null;
  }
  dedup.checkStatusDone = true;
  // Cross-turn dedup: skip if called recently (within 30s)
  const csNow = Date.now();
  if (csNow - (agent._lastCheckStatus || 0) < 30000) {
    console.log(`[Dedup] Skipping @check_status from "${agent.name}" — called ${Math.round((csNow - agent._lastCheckStatus) / 1000)}s ago`);
    return { tool: 'check_status', args: [], success: true, result: '[Status unchanged — focus on your current task]' };
  }
  agent._lastCheckStatus = csNow;
  const { AgentManager } = await import('../index.js');
  const todoList = mgr._getAgentTasks(agentId);
  const waitingTasks = todoList.filter((t: any) => !mgr._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error').length;
  const activeCount = todoList.filter((t: any) => mgr._isActiveTaskStatus(t.status)).length;
  const doneTasks = todoList.filter((t: any) => t.status === 'done').length;
  const errorTasks = todoList.filter((t: any) => t.status === 'error').length;
  const totalTasks = todoList.length;
  const msgCount = (agent.conversationHistory || []).length;
  const hasSandbox = mgr.executionManager ? mgr.executionManager.hasEnvironment(agent.id) : false;
  const currentActiveTask = todoList.find((t: any) => mgr._isActiveTaskStatus(t.status));
  const currentTaskInfo = agent.currentTask
    ? agent.currentTask.slice(0, 120)
    : currentActiveTask
      ? currentActiveTask.text.slice(0, 120)
      : 'none';
  const projectAssignedAt = agent.projectChangedAt
    ? new Date(agent.projectChangedAt).toLocaleString()
    : 'n/a';
  const projectDurationMs = agent.project && agent.projectChangedAt
    ? Date.now() - new Date(agent.projectChangedAt).getTime()
    : null;
  const projectDuration = AgentManager.formatDuration(projectDurationMs);
  const agentLlm = mgr.resolveLlmConfig(agent);

  const lines = [
    `Name: ${agent.name}`,
    `Status: ${agent.status}`,
    `Role: ${agent.role || 'worker'}`,
    `Project: ${agent.project || 'none'}${agent.project ? ` (assigned ${projectAssignedAt}, duration: ${projectDuration})` : ''}`,
    `Current task: ${currentTaskInfo}`,
    `Provider: ${agentLlm.provider || 'unknown'}/${agentLlm.model || 'unknown'}`,
    `Sandbox: ${hasSandbox ? 'running' : 'not running'}`,
    `Tasks: ${activeCount} active, ${waitingTasks} waiting, ${doneTasks} done, ${errorTasks} error / ${totalTasks} total`,
    `Messages: ${msgCount}`,
    `Last active: ${agent.metrics?.lastActiveAt || 'never'}`,
    `Errors: ${agent.metrics?.errors || 0}`,
  ];
  const activeTasks = todoList.filter((t: any) => t.status !== 'done');
  if (activeTasks.length > 0) {
    lines.push(`Active tasks:`);
    for (const t of activeTasks.slice(0, 10)) {
      const mark = mgr._isActiveTaskStatus(t.status) ? '~' : t.status === 'error' ? '!' : ' ';
      lines.push(`  [${mark}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '...' : ''}`);
    }
    if (activeTasks.length > 10) lines.push(`  ... and ${activeTasks.length - 10} more`);
  }

  console.log(`📊 [Check Status] Agent "${agent.name}": ${agent.status} | project=${agent.project || 'none'} | task=${currentTaskInfo}`);
  return { tool: 'check_status', args: [], success: true, result: lines.join('\n') };
};

// ── @search_skill(query) ──
const handleSearchSkill: ToolHandler = async ({ agent, call }) => {
  const query = (call.args[0] || '').trim();
  if (!query) {
    return { tool: 'search_skill', args: call.args, success: false, error: 'Search query is required. Use: @search_skill(keyword)' };
  }
  try {
    const skills = await searchAgentSkills(query);
    if (skills.length === 0) {
      console.log(`🔍 [Skill Search] Agent "${agent.name}" searched for "${query}" — ${skills.length} result(s)`);
      return { tool: 'search_skill', args: call.args, success: true, result: `No skills found matching "${query}".` };
    }
    const lines = skills.map((s: any) => {
      const mcps = Array.isArray(s.mcpServerIds) && s.mcpServerIds.length > 0 ? ` [MCPs: ${s.mcpServerIds.join(', ')}]` : '';
      return `- **${s.name}** (${s.id})\n  Category: ${s.category || 'general'}${mcps}\n  ${s.description || 'No description'}\n  Created by: ${s.createdBy || 'unknown'} | Updated: ${s.updatedAt || 'unknown'} | Used: ${s.useCount || 0} times`;
    });
    console.log(`🔍 [Skill Search] Agent "${agent.name}" searched for "${query}" — ${skills.length} result(s)`);
    return { tool: 'search_skill', args: call.args, success: true, result: `Found ${skills.length} skill(s) matching "${query}":\n\n${lines.join('\n\n')}` };
  } catch (err: any) {
    return { tool: 'search_skill', args: call.args, success: false, error: err.message };
  }
};

// ── @create_skill(name, JSON) ──
const handleCreateSkill: ToolHandler = async ({ agent, agentId, call }) => {
  const skillName = (call.args[0] || '').trim();
  const dataArg = call.args[1] || '{}';
  if (!skillName) {
    return { tool: 'create_skill', args: call.args, success: false, error: 'Skill name is required. Use: @create_skill(name, """{"description": "...", "instructions": "...", "category": "...", "mcpServerIds": [...]}""")' };
  }
  try {
    let parsed: any = {};
    if (typeof dataArg === 'string') {
      try { parsed = JSON.parse(dataArg); } catch {
        // If not valid JSON, treat the entire second arg as instructions
        parsed = { instructions: dataArg };
      }
    }
    const skillId = `agent-skill-${uuidv4()}`;
    const nowStr = new Date().toISOString();
    const skill = {
      id: skillId,
      name: skillName,
      description: parsed.description || '',
      category: parsed.category || 'general',
      instructions: parsed.instructions || '',
      mcpServerIds: Array.isArray(parsed.mcpServerIds) ? parsed.mcpServerIds : [],
      createdBy: agent.name,
      createdByAgentId: agentId,
      useCount: 0,
      lastUsedAt: null,
      createdAt: nowStr,
      updatedAt: nowStr,
    };
    await saveAgentSkill(skill);
    console.log(`✨ [Skill Create] Agent "${agent.name}" created skill "${skillName}" (${skillId})`);
    return { tool: 'create_skill', args: call.args, success: true, result: `Skill created successfully:\n- ID: ${skillId}\n- Name: ${skillName}\n- Category: ${skill.category}\n- Description: ${skill.description || '(none)'}\n- MCPs: ${skill.mcpServerIds.length > 0 ? skill.mcpServerIds.join(', ') : 'none'}` };
  } catch (err: any) {
    return { tool: 'create_skill', args: call.args, success: false, error: err.message };
  }
};

// ── @update_skill(id, JSON) ──
const handleUpdateSkill: ToolHandler = async ({ agent, call }) => {
  const skillId = (call.args[0] || '').trim();
  const dataArg = call.args[1] || '{}';
  if (!skillId) {
    return { tool: 'update_skill', args: call.args, success: false, error: 'Skill ID is required. Use: @update_skill(skill-id, """{"instructions": "updated instructions", ...}""")' };
  }
  try {
    const existing = await getAgentSkillById(skillId);
    if (!existing) {
      return { tool: 'update_skill', args: call.args, success: false, error: `Skill not found: ${skillId}` };
    }
    let parsed: any = {};
    if (typeof dataArg === 'string') {
      try { parsed = JSON.parse(dataArg); } catch {
        // If not valid JSON, treat the entire second arg as updated instructions
        parsed = { instructions: dataArg };
      }
    }
    const allowedFields = ['name', 'description', 'category', 'instructions', 'mcpServerIds'];
    for (const key of allowedFields) {
      if (parsed[key] !== undefined) {
        (existing as any)[key] = parsed[key];
      }
    }
    (existing as any).updatedAt = new Date().toISOString();
    (existing as any).lastUpdatedBy = agent.name;
    await saveAgentSkill(existing);
    console.log(`📝 [Skill Update] Agent "${agent.name}" updated skill "${(existing as any).name}" (${skillId})`);
    return { tool: 'update_skill', args: call.args, success: true, result: `Skill "${(existing as any).name}" (${skillId}) updated successfully.\nUpdated fields: ${Object.keys(parsed).filter(k => allowedFields.includes(k)).join(', ') || 'none'}` };
  } catch (err: any) {
    return { tool: 'update_skill', args: call.args, success: false, error: err.message };
  }
};

// ── @delete_skill(id) ──
const handleDeleteSkill: ToolHandler = async ({ agent, call }) => {
  const skillId = (call.args[0] || '').trim();
  if (!skillId) {
    return { tool: 'delete_skill', args: call.args, success: false, error: 'Skill ID is required. Use: @delete_skill(skill-id)' };
  }
  try {
    const existing = await getAgentSkillById(skillId);
    if (!existing) {
      return { tool: 'delete_skill', args: call.args, success: false, error: `Skill not found: ${skillId}` };
    }
    await deleteAgentSkillFromDb(skillId);
    console.log(`🗑️ [Skill Delete] Agent "${agent.name}" deleted skill "${(existing as any).name}" (${skillId})`);
    return { tool: 'delete_skill', args: call.args, success: true, result: `Skill "${(existing as any).name}" (${skillId}) deleted successfully.` };
  } catch (err: any) {
    return { tool: 'delete_skill', args: call.args, success: false, error: err.message };
  }
};

// ── @mcp_call() ──
const handleMcpCall: ToolHandler = async ({ mgr, agent, agentId, call, streamCallback }) => {
  const [serverName, toolName, argsJson] = call.args;

  if (!serverName || !serverName.trim()) {
    const errMsg = 'MCP call requires a server name. Use: @mcp_call(ServerName, tool_name, {"arg": "value"})';
    return { tool: 'mcp_call', args: call.args, success: false, error: errMsg };
  }
  if (!toolName || !toolName.trim()) {
    const errMsg = 'MCP call requires a tool name. Use: @mcp_call(ServerName, tool_name, {"arg": "value"})';
    return { tool: 'mcp_call', args: call.args, success: false, error: errMsg };
  }

  // ── Tool Hooks: check MCP calls ──
  const mcpHookResult = checkToolHooks(agent.toolHooks, 'mcp_call', call.args);
  if (!mcpHookResult.allowed) {
    console.log(`🛡️ [ToolHook] Blocked mcp_call for agent "${agent.name}": ${mcpHookResult.message}`);
    if (streamCallback) streamCallback(`\n✗ mcp_call — blocked by security rule\n`);
    return { tool: 'mcp_call', args: call.args, success: false, error: mcpHookResult.message };
  }

  // ── Plugin gate: server must be enabled via agent plugins, board plugins,
  //    or direct agent.mcpServers. The LLM may "remember" a tool from a
  //    previous run when more plugins were enabled — refuse to dispatch it.
  const _allowedMcpIds = new Set<string>();
  const _agentSkillIds: string[] = Array.isArray(agent.skills) ? agent.skills : [];
  let _boardPluginIds: string[] = [];
  if (agent.boardId) {
    try {
      const _board = await getBoardById(agent.boardId);
      if (_board && Array.isArray(_board.plugins)) _boardPluginIds = _board.plugins;
    } catch { /* board may not exist */ }
  }
  for (const sid of new Set([..._agentSkillIds, ..._boardPluginIds])) {
    const plugin = mgr.skillManager ? mgr.skillManager.getById(sid) : null;
    if (plugin && Array.isArray((plugin as any).mcpServerIds)) {
      for (const mid of (plugin as any).mcpServerIds) _allowedMcpIds.add(mid);
    }
  }
  for (const mid of (agent.mcpServers || [])) _allowedMcpIds.add(mid);

  // Resolve the requested server name to a known id without triggering
  // builtin auto-registration (we don't want to "wake up" a server the
  // agent isn't allowed to use just to deny it).
  const _requestedNameLc = String(serverName).toLowerCase();
  let _resolvedServerId: string | null = null;
  for (const s of mgr.mcpManager.servers.values()) {
    if (s.name && s.name.toLowerCase() === _requestedNameLc) { _resolvedServerId = s.id; break; }
    if (s.id && s.id.toLowerCase() === _requestedNameLc) { _resolvedServerId = s.id; break; }
  }
  if (!_resolvedServerId) {
    const _builtin = findBuiltinMcpServer(serverName);
    if (_builtin) _resolvedServerId = _builtin.id;
  }

  if (!_resolvedServerId || !_allowedMcpIds.has(_resolvedServerId)) {
    const errMsg = `MCP server "${serverName}" is not enabled for this agent. ` +
      `The agent must have a plugin that provides this server in its own plugin list, ` +
      `or in the current board's plugin list. ` +
      `Do not call @mcp_call(${serverName}, ...) — this tool is not available in this run.`;
    console.log(`🛡️ [MCP Gate] Blocked @mcp_call(${serverName}, ${toolName}) for agent "${agent.name}": server not in enabled plugin set`);
    if (streamCallback) streamCallback(`\n✗ MCP: ${serverName} → ${toolName} — blocked: server not enabled for this agent\n`);
    mgr._emit('agent:tool:error', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', error: errMsg });
    return { tool: 'mcp_call', args: call.args, success: false, error: errMsg };
  }

  const mcpLabel = `MCP: ${serverName} → ${toolName}`;
  agent.currentThinking = mcpLabel;
  mgr._emit('agent:thinking', { agentId, thinking: mcpLabel });
  mgr._emit('agent:tool:start', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args });

  try {
    let parsedArgs: any;
    if (typeof argsJson === 'string') {
      let raw = argsJson.trim();
      raw = raw.replace(/,?\s*\.{3}\s*/g, '');

      try {
        parsedArgs = JSON.parse(raw);
      } catch {
        let fixed = raw;
        fixed = fixed.replace(/([{,])\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
        fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        fixed = fixed.replace(/'/g, '"');
        try {
          parsedArgs = JSON.parse(fixed);
          console.log(`🔧 [MCP] Repaired malformed JSON for ${toolName}: ${argsJson.slice(0, 100)}`);
        } catch (e2: any) {
          throw new Error(`Invalid JSON arguments for ${toolName}: ${e2.message}. Received: ${argsJson.slice(0, 200)}`);
        }
      }

      const vals = Object.values(parsedArgs);
      const looksLikeSchema = vals.length > 0 && vals.every((v: any) =>
        (typeof v === 'object' && v !== null && ('type' in v || 'title' in v || 'anyOf' in v)) ||
        (typeof v === 'string' && /^<[^>]+>$/.test(v))
      );
      if (looksLikeSchema) {
        const paramNames = Object.keys(parsedArgs);
        throw new Error(
          `You passed the schema definition instead of actual values. ` +
          `Do NOT copy the type descriptions — pass real values. ` +
          `Example: @mcp_call(${serverName}, ${toolName}, {${paramNames.map(p => `"${p}": "actual-value-here"`).join(', ')}})`
        );
      }
    } else {
      parsedArgs = argsJson || {};
    }
    const mcpResult = await mgr.mcpManager.callToolByNameForAgent(serverName, toolName, parsedArgs, agentId, agent.mcpAuth || {}, agent.boardId || null);

    if (streamCallback) {
      const icon = mcpResult.success ? '✓' : '✗';
      streamCallback(`\n${icon} ${mcpLabel}\n`);
    }

    mgr._emit('agent:tool:result', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args, success: mcpResult.success, preview: (mcpResult.result || '').slice(0, 300) });
    return { tool: 'mcp_call', args: call.args, ...mcpResult };
  } catch (mcpErr: any) {
    console.error(`❌ [MCP] Agent "${agent.name}" mcp_call failed: ${mcpErr.message}`);
    if (streamCallback) streamCallback(`\n✗ ${mcpLabel}: ${mcpErr.message}\n`);
    mgr._emit('agent:tool:error', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', error: mcpErr.message });
    return { tool: 'mcp_call', args: call.args, success: false, error: mcpErr.message };
  }
};

export const HANDLERS: Record<string, ToolHandler> = {
  report_error: handleReportError,
  update_task: handleUpdateTask,
  move_task_to_board: handleMoveTaskToBoard,
  delete_task: handleDeleteTask,
  list_boards: handleListBoards,
  list_tasks: handleListTasks,
  list_projects: handleListProjects,
  list_my_tasks: handleListMyTasks,
  check_status: handleCheckStatus,
  search_skill: handleSearchSkill,
  create_skill: handleCreateSkill,
  update_skill: handleUpdateSkill,
  delete_skill: handleDeleteSkill,
  mcp_call: handleMcpCall,
};
