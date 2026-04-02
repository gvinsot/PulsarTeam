import { getSettings, getWorkflowForBoard } from './configManager.js';
import { saveAgent, saveTaskToDb } from './database.js';

/**
 * Strip tool calls (@tool(...) and <tool_call> blocks) from an LLM response
 * so that only the descriptive text remains. Used when storing refined descriptions.
 */
export function stripToolCalls(text) {
  if (!text) return text;
  // Remove <tool_call>...</tool_call> blocks
  let cleaned = text.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '');
  // Remove @tool(...) calls with balanced parentheses
  const TOOL_NAMES = [
    'read_file', 'write_file', 'append_file', 'list_dir', 'search_files',
    'run_command', 'report_error', 'git_commit_push', 'mcp_call', 'link_commit',
    'update_task', 'list_my_tasks', 'list_projects', 'check_status',
    'task_execution_complete', 'get_action_status', 'build_stack', 'test_stack',
    'deploy_stack', 'list_stacks', 'list_containers', 'list_computers',
    'search_logs', 'get_log_metadata',
  ];
  const toolPattern = new RegExp(`@(${TOOL_NAMES.join('|')})\\s*\\(`, 'gi');
  let match;
  // Process matches in reverse order to preserve indices
  const removals = [];
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
    if (depth === 0) {
      removals.push({ start, end: i });
    }
  }
  // Remove in reverse order
  for (let r = removals.length - 1; r >= 0; r--) {
    cleaned = cleaned.slice(0, removals[r].start) + cleaned.slice(removals[r].end);
  }
  // Clean up leftover whitespace (multiple blank lines → single blank line)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

// Lock to prevent concurrent execution of the same task (lockKey → timestamp)
// Uses a Map with TTL to prevent permanent deadlocks from crashed transitions.
const _executionLocks = new Map();
const EXECUTION_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function _acquireExecutionLock(lockKey) {
  // Evict stale locks first
  const now = Date.now();
  for (const [key, ts] of _executionLocks) {
    if (now - ts > EXECUTION_LOCK_TTL_MS) {
      console.warn(`[Workflow] Evicting stale execution lock: ${key} (age: ${Math.round((now - ts) / 1000)}s)`);
      _executionLocks.delete(key);
    }
  }
  if (_executionLocks.has(lockKey)) return false;
  _executionLocks.set(lockKey, now);
  return true;
}

/**
 * Find the first available agent matching a role.
 * "Available" = enabled AND idle (not busy/error) AND not already working on an active task.
 * Only considers agents owned by the given user or with no owner.
 * Returns null if no idle agent with the role exists — the task stays pending.
 */
function findAgentByRole(agentManager, role, ownerId = null) {
  const agents = Array.from(agentManager.agents.values());
  const matching = agents.filter(
    a => a.enabled !== false
      && (a.role || '').toLowerCase() === role.toLowerCase()
      && (!ownerId || !a.ownerId || a.ownerId === ownerId)
  );
  console.log(`[Workflow] findAgentByRole: role="${role}" ownerId="${ownerId}" total=${agents.length} matching=${matching.length} names=[${matching.map(a => `${a.name}(owner:${a.ownerId})`).join(', ')}]`);
  // Only return idle agents that don't already have an active task
  const INACTIVE = new Set(['done', 'backlog', 'error']);
  return matching.find(a => {
    if (a.status !== 'idle') return false;
    const hasActive = (a.todoList || []).some(t => !INACTIVE.has(t.status));
    if (hasActive) {
      console.log(`[Workflow] Skipping agent "${a.name}" - already has an active task`);
      return false;
    }
    if (agentManager.agentHasActiveTask(a.id)) {
      console.log(`[Workflow] Skipping agent "${a.name}" — has active task assignment (cross-agent check)`);
      return false;
    }
    return true;
  }) || null;
}

/**
 * Process an automatic workflow transition.
 *
 * Three modes based on transition config:
 * - Refinement mode (default): sends a refinement prompt, appends result to task text
 * - Execution mode: sends the task as-is for execution
 * - Decide mode: agent evaluates whether the task should proceed, hold, or be revised
 * - Title mode: agent generates a short title from the task description
 *
 * The `task._transition` object carries: { agent (role), to (target status or null), instructions, mode }
 */
export async function processTransition(task, agentManager, io) {
  const targetStatus = task._transition?.to || null;
  const transitionRole = task._transition?.agent;
  const mode = task._transition?.mode;
  const instructions = task._transition?.instructions || '';

  // Prevent concurrent execution of the same task (with TTL-based lock)
  const lockKey = `${task.agentId}:${task.id}:${mode || 'refine'}`;
  if (!_acquireExecutionLock(lockKey)) {
    console.log(`[Workflow] Skipping duplicate processTransition for "${task.text?.slice(0, 60)}" — already in progress`);
    return { skipped: 'lock-held' };
  }

  console.log(`[Workflow] processTransition called: task="${task.text?.slice(0, 60)}" from="${task.status}" to="${targetStatus}" mode="${mode}" role="${transitionRole || 'none'}" agentId="${task.agentId}"`);

  // Computed outside try for catch-block access
  const isExecution = mode === 'execute' || (!mode && (!instructions || instructions.includes('[EXECUTE]')));
  const isTitle = mode === 'title';
  const isSetType = mode === 'set_type';
  let _execAgent = null;       // the agent running the execution (for error-path logging)
  let _execStartMsgIdx = -1;
  let _execStartedAt = null;

  try {
    const isDecide = mode === 'decide';

    // Determine the owner: prefer board-level userId (set by caller), fallback to creator agent's owner
    const creatorAgent = agentManager.agents.get(task.agentId);
    const taskOwnerId = task._boardUserId || creatorAgent?.ownerId || null;
    console.log(`[Workflow] Owner filter: _boardUserId="${task._boardUserId}" creatorAgent="${creatorAgent?.name}" resolved ownerId="${taskOwnerId}" agentId="${task.agentId}"`);

    // Find the agent to run this transition — same logic for all modes
    let agent = null;

    // 1. Try role-based agent selection
    if (transitionRole) {
      agent = findAgentByRole(agentManager, transitionRole, taskOwnerId);
      if (agent) console.log(`[Workflow] Found agent by role "${transitionRole}": ${agent.name} (${agent.id})`);
    }

    // 2. Fallback: for execute mode, try the task's assignee
    if (!agent && isExecution) {
      const assignee = task.assignee ? agentManager.agents.get(task.assignee) : null;
      if (assignee && assignee.enabled !== false && assignee.status === 'idle') {
        agent = assignee;
        console.log(`[Workflow] Execute mode: using idle assignee "${agent.name}" (${agent.id})`);
      }
    }

    // 3. Fallback: for non-execute modes, try global ideasAgent setting
    if (!agent && !isExecution) {
      const settings = await getSettings();
      if (settings.ideasAgent) {
        agent = Array.from(agentManager.agents.values()).find(
          a => a.enabled !== false && a.status === 'idle'
            && (a.name || '').toLowerCase() === settings.ideasAgent.toLowerCase()
            && (!taskOwnerId || !a.ownerId || a.ownerId === taskOwnerId)
        );
        if (agent) console.log(`[Workflow] Found idle agent via ideasAgent setting: ${agent.name}`);
      }
    }

    if (!agent) {
      console.log(`[Workflow] No idle agent found for role "${transitionRole || 'any'}" — task stays pending (will be picked up when an agent becomes available)`);
      _executionLocks.delete(lockKey);
      return { skipped: 'no-idle-agent' };
    }

    // Store the executing agent ID on the task for stop functionality
    // Also update assignee to reflect which agent is currently working on this task
    const creatorAgentForFlag = agentManager.agents.get(task.agentId);
    const actualTaskForFlag = creatorAgentForFlag?.todoList?.find(t => t.id === task.id);
    if (actualTaskForFlag) {
      actualTaskForFlag.actionRunning = true;
      actualTaskForFlag.actionRunningAgentId = agent.id;
      // Mark when execution started — used by managesContext to scope history
      if (!actualTaskForFlag.startedAt) {
        actualTaskForFlag.startedAt = new Date().toISOString();
      }
      // Update assignee to the agent performing this action
      if (actualTaskForFlag.assignee !== agent.id) {
        const previousAssignee = actualTaskForFlag.assignee;
        actualTaskForFlag.assignee = agent.id;
        if (!actualTaskForFlag.history) actualTaskForFlag.history = [];
        actualTaskForFlag.history.push({
          status: actualTaskForFlag.status,
          at: new Date().toISOString(),
          by: 'workflow',
          type: 'reassign',
          assignee: agent.id,
        });
        console.log(`[Workflow] Updated assignee: "${previousAssignee || 'none'}" → "${agent.id}" (${agent.name}) for task "${task.text?.slice(0, 60)}"`);
      }
      saveTaskToDb({ ...actualTaskForFlag, agentId: task.agentId });
      io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task: actualTaskForFlag });
    }

    // Auto-switch agent to the task's project if needed
    if (task.project && task.project !== agent.project) {
      console.log(`[Workflow] Switching "${agent.name}" to project "${task.project}" for transition`);
      if (agentManager._switchProjectContext) {
        agentManager._switchProjectContext(agent, agent.project, task.project);
      }
      agent.project = task.project;
    }

    // Title mode: lightweight — generate a short title from task description
    if (isTitle) {
      const maxLen = agent.contextLength || 4000;
      const description = (task.text || '').slice(0, maxLen);
      const titlePrompt = `Generate a short, concise title (max 20 words) for the following task description. Reply with ONLY the title, nothing else.\n\n${description}`;

      console.log(`[Workflow] Generating title for "${task.text?.slice(0, 60)}" via ${agent.name}`);

      const titleStartMsgIdx = (agent.conversationHistory || []).length;
      const titleStartedAt = new Date().toISOString();
      try {
        const result = await agentManager.sendMessage(agent.id, titlePrompt, () => {});
        const title = (result || '').trim().replace(/^["']|["']$/g, '');
        if (title) {
          agentManager.updateTaskTitle(task.agentId, task.id, title);
          console.log(`[Workflow] Title generated: "${title}" for "${task.text?.slice(0, 60)}"`);
        }
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, titleStartMsgIdx, titleStartedAt, true, 'title');
      } catch (err) {
        console.error(`[Workflow] Title generation failed for "${task.text?.slice(0, 60)}":`, err.message);
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, titleStartMsgIdx, titleStartedAt, false, 'title');
      } finally {
        agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
      }
      return;
    }

    // Set-type mode: lightweight — classify task into a type (bug, feature, technical, etc.)
    if (isSetType) {
      const maxLen = agent.contextLength || 4000;
      const description = (task.text || '').slice(0, maxLen);
      const typePrompt = `Classify the following task into exactly one type. The possible types are: bug, feature, technical, improvement, documentation, other.\n\nReply with ONLY the type (a single word, lowercase), nothing else.\n\nTask:\n${description}`;

      console.log(`[Workflow] Classifying type for "${task.text?.slice(0, 60)}" via ${agent.name}`);

      const typeStartMsgIdx = (agent.conversationHistory || []).length;
      const typeStartedAt = new Date().toISOString();
      try {
        const result = await agentManager.sendMessage(agent.id, typePrompt, () => {});
        const rawType = (result || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
        const VALID_TYPES = ['bug', 'feature', 'technical', 'improvement', 'documentation', 'other'];
        const taskType = VALID_TYPES.includes(rawType) ? rawType : 'other';
        agentManager.updateTaskType(task.agentId, task.id, taskType, agent.name);
        console.log(`[Workflow] Type classified: "${taskType}" for "${task.text?.slice(0, 60)}"`);
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, typeStartMsgIdx, typeStartedAt, true, 'set_type');
      } catch (err) {
        console.error(`[Workflow] Type classification failed for "${task.text?.slice(0, 60)}":`, err.message);
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, typeStartMsgIdx, typeStartedAt, false, 'set_type');
      } finally {
        agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
      }
      return;
    }

    let prompt;
    let messagePrefix;
    if (isExecution) {
      // Execution mode: mark task as active if not already
      // (no hardcoded status — workflow transitions handle the status change)
      if (instructions) {
        // When instructions are provided, behave like instructions mode — send structured context
        prompt = `You have been assigned instructions for the following task.

Task ID: ${task.id}
Task title: ${task.text}
Current status: ${task.status}
${task.error ? `Previous error: ${task.error}` : ''}

Instructions:
${instructions}

You can change the task status using @update_task(${task.id}, <new_status>) where <new_status> is a workflow column ID.
You can also append details to the task description: @update_task(${task.id}, <new_status>, <details>).
Execute the instructions above and update the task status accordingly.`;
      } else {
        prompt = task.text;
      }
      messagePrefix = '';
      console.log(`[Workflow] Executing "${task.text.slice(0, 80)}" via ${agent.name} (role: ${agent.role})`);
    } else if (isDecide) {
      // Instructions mode: agent receives instructions and can update the task status itself
      if (!instructions) {
        console.log(`[Workflow] Instructions: no instructions configured — skipping for "${task.text.slice(0, 60)}"`);
        _executionLocks.delete(lockKey);
        return;
      }
      prompt = `You have been assigned instructions for the following task.

Task ID: ${task.id}
Task title: ${task.text}
Current status: ${task.status}
${task.error ? `Previous error: ${task.error}` : ''}

Instructions:
${instructions}

You can change the task status using @update_task(${task.id}, <new_status>) where <new_status> is a workflow column ID.
You can also append details to the task description: @update_task(${task.id}, <new_status>, <details>).
Execute the instructions above and update the task status accordingly.`;
      messagePrefix = '';
      console.log(`[Workflow] Instructions mode: "${task.text.slice(0, 80)}" via ${agent.name}`);
    } else {
      // Refinement mode: ask for an improved description
      prompt = `Refine the following task:\n\nTask: ${task.text}\n${task.project ? `Project: ${task.project}\n` : ''}\n${instructions}\n\nReply ONLY with the improved task description.`;
      messagePrefix = '[Auto-Transition]';
      console.log(`[Workflow] Refining "${task.text.slice(0, 80)}" via ${agent.name} (role: ${agent.role})`);
    }

    let fullResponse = '';

    // Track conversation index for execution log (ALL modes)
    _execAgent = agent;
    _execStartMsgIdx = (agent.conversationHistory || []).length;
    _execStartedAt = new Date().toISOString();

    io.emit('agent:stream:start', {
      agentId: agent.id,
      agentName: agent.name,
      project: agent.project || null,
    });

    try {
      const result = await agentManager.sendMessage(
        agent.id,
        messagePrefix ? `${messagePrefix} ${prompt}` : prompt,
        (chunk) => {
          fullResponse += chunk;
          io.emit('agent:stream:chunk', {
            agentId: agent.id,
            agentName: agent.name,
            project: agent.project || null,
            chunk,
          });
          // Emit thinking state like the socket handler does
          io.emit('agent:thinking', {
            agentId: agent.id,
            project: agent.project || null,
            thinking: agentManager.agents.get(agent.id)?.currentThinking || ''
          });
        },
        0 // delegationDepth
      );

      const response = (result?.content || fullResponse).trim();

      // Determine action mode label for history
      const actionMode = isExecution ? 'execute' : isDecide ? 'decide' : 'refine';

      if (isExecution && instructions) {
        // Execute with instructions: agent handles status changes itself via @update_task (like instructions mode)
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, _execStartMsgIdx, _execStartedAt, true, 'execute');
        _executionLocks.delete(lockKey);
        console.log(`[Workflow] Execute (with instructions) completed for "${task.text.slice(0, 60)}" via ${agent.name}`);
      } else if (isExecution) {
        // Execute without instructions: wait for agent to signal completion via @task_execution_complete
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, _execStartMsgIdx, _execStartedAt, true, 'execute');
        console.log(`[Workflow] Execution response received for "${task.text.slice(0, 60)}" — waiting for task_execution_complete`);
        await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, targetStatus, task.text);
      } else if (isDecide) {
        // Instructions mode: agent handles status changes itself via @update_task
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, _execStartMsgIdx, _execStartedAt, true, 'decide');
        // Release the execution lock early — the agent has already processed tools
        // and moved the task via @update_task. Holding the lock blocks on_enter
        // transitions for the new column (e.g. test → deploy).
        _executionLocks.delete(lockKey);
        console.log(`[Workflow] Instructions completed for "${task.text.slice(0, 60)}" via ${agent.name}`);
      } else {
        // Refine mode — replace the task description with the refined version
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, _execStartMsgIdx, _execStartedAt, true, 'refine');
        if (response) {
          const cleanedResponse = stripToolCalls(response);
          if (cleanedResponse) {
            agentManager.updateTaskText(task.agentId, task.id, cleanedResponse);
          }
        }
      }

      console.log(`[Workflow] Done: "${task.text.slice(0, 80)}" via ${agent.name} (mode=${actionMode})`);
    } finally {
      io.emit('agent:stream:end', {
        agentId: agent.id,
        agentName: agent.name,
        project: agent.project || null,
      });
      // Emit agent:updated so the frontend gets the updated conversation history
      agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
    }
    return { executed: true };
  } catch (err) {
    console.error(`[Workflow] Error processing "${task.text}":`, err.message, err.stack);
    try {
      // Save execution chat log even on error (for all action modes)
      if (_execAgent && _execStartMsgIdx >= 0) {
        const errorMode = isExecution ? 'execute' : isTitle ? 'title' : isSetType ? 'set_type' : mode === 'decide' ? 'decide' : 'refine';
        agentManager._saveExecutionLog(task.agentId, task.id, _execAgent.id, _execStartMsgIdx, _execStartedAt, false, errorMode);
      }
      // On error, always set task to error status — keeps it in the current column and blocks auto-transitions
      // setTaskStatus will store errorFromStatus automatically
      agentManager.setTaskStatus(task.agentId, task.id, 'error', { skipAutoRefine: true, by: 'workflow' });
      // Store the error message on the task for display
      const creatorAgent = agentManager.agents.get(task.agentId);
      const actualTask = creatorAgent?.todoList?.find(t => t.id === task.id);
      if (actualTask) {
        actualTask.error = err.message;
        saveTaskToDb({ ...actualTask, agentId: task.agentId });
      }
    } catch (e) {
      console.error(`[Workflow] Failed to set status after error:`, e.message);
    }
  } finally {
    _executionLocks.delete(lockKey);
    // Clear actionRunning flag
    const creatorAgentFinal = agentManager.agents.get(task.agentId);
    const actualTaskFinal = creatorAgentFinal?.todoList?.find(t => t.id === task.id);
    if (actualTaskFinal && actualTaskFinal.actionRunning) {
      actualTaskFinal.actionRunning = false;
      delete actualTaskFinal.actionRunningAgentId;
      saveAgent(creatorAgentFinal);
      io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task: actualTaskFinal });
    }
  }
}
