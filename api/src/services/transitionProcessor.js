import { getSettings, getWorkflowForBoard } from './configManager.js';
import { saveAgent } from './database.js';

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
 * "Available" = enabled AND idle (not busy/error).
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
  // Only return idle agents that don't already have an in_progress task
  return matching.find(a => {
    if (a.status !== 'idle') return false;
    const hasInProgress = (a.todoList || []).some(t => t.status === 'in_progress');
    if (hasInProgress) {
      console.log(`[Workflow] Skipping agent "${a.name}" - already has in_progress task`);
      return false;
    }
    return true;
  }) || null;
}

/**
 * Parse a decide-mode response to extract the structured decision.
 * Accepts JSON like { "decision": "proceed" } or plain text containing proceed/hold/revise.
 */
function parseDecision(response) {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = response.replace(/```(?:json)?\s*\n?([\s\S]*?)```/g, '$1').trim();

  // Try JSON parse — first the whole cleaned string, then extract via regex
  for (const candidate of [cleaned, response]) {
    try {
      // Try parsing the whole candidate as JSON
      const direct = JSON.parse(candidate.trim());
      if (direct.decision) {
        return { decision: direct.decision.toLowerCase(), reason: direct.reason || '' };
      }
    } catch (_) { /* not valid JSON */ }

    // Extract JSON object containing "decision" — use greedy match for last } to handle nested braces
    try {
      const jsonMatch = candidate.match(/\{[^{}]*"decision"\s*:\s*"[^"]*"[^{}]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          decision: (parsed.decision || 'hold').toLowerCase(),
          reason: parsed.reason || '',
        };
      }
    } catch (_) { /* not valid JSON, fall through */ }
  }

  // Fall back to keyword detection in plain text
  const lower = response.toLowerCase();
  if (lower.includes('proceed') || lower.includes('approve') || lower.includes('yes')) {
    return { decision: 'proceed', reason: response };
  }
  if (lower.includes('revise') || lower.includes('reject') || lower.includes('no')) {
    return { decision: 'revise', reason: response };
  }
  return { decision: 'hold', reason: response };
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
  const targetStatus = task._transition?.to ?? 'backlog';
  const rejectTarget = task._transition?.rejectTarget || null;
  const transitionRole = task._transition?.agent;
  const mode = task._transition?.mode;
  const instructions = task._transition?.instructions || '';

  // Prevent concurrent execution of the same task (with TTL-based lock)
  const lockKey = `${task.agentId}:${task.id}`;
  if (!_acquireExecutionLock(lockKey)) {
    console.log(`[Workflow] Skipping duplicate processTransition for "${task.text?.slice(0, 60)}" — already in progress`);
    return;
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

    // Find the agent to run this transition
    let agent = null;

    if (isExecution) {
      // Execute mode: use the task's assignee ONLY — never fallback to creator
      const assignee = task.assignee ? agentManager.agents.get(task.assignee) : null;
      if (assignee && assignee.enabled !== false && assignee.status === 'idle') {
        agent = assignee;
        console.log(`[Workflow] Execute mode: using idle assignee "${agent.name}" (${agent.id})`);
      }
      // If assignee is not idle, don't fallback — task will be picked up when assignee becomes available
      if (!agent) {
        console.log(`[Workflow] Execute mode: assignee not available — task stays pending (will retry when assignee is idle)`);
        _executionLocks.delete(lockKey);
        return;
      }
    } else {
      // Non-execute modes: find agent by role (scoped to task owner)
      if (transitionRole) {
        agent = findAgentByRole(agentManager, transitionRole, taskOwnerId);
        if (agent) console.log(`[Workflow] Found agent by role "${transitionRole}": ${agent.name} (${agent.id})`);
      }
    }

    // Fallback for non-execute modes: try global ideasAgent setting (scoped to task owner)
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
      return;
    }

    // Store the executing agent ID on the task for stop functionality
    const creatorAgentForFlag = agentManager.agents.get(task.agentId);
    const actualTaskForFlag = creatorAgentForFlag?.todoList?.find(t => t.id === task.id);
    if (actualTaskForFlag) {
      actualTaskForFlag.actionRunning = true;
      actualTaskForFlag.actionRunningAgentId = agent.id;
      saveAgent(creatorAgentForFlag);
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
      _executionLocks.delete(lockKey);
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
      _executionLocks.delete(lockKey);
      return;
    }

    let prompt;
    let messagePrefix;
    if (isExecution) {
      // Execution mode: mark in_progress (only if not already), execute the task
      if (task.status !== 'in_progress') {
        agentManager.setTaskStatus(task.agentId, task.id, 'in_progress', { skipAutoRefine: true, by: agent.name });
      }
      prompt = task.text;
      messagePrefix = '';
      console.log(`[Workflow] Executing "${task.text.slice(0, 80)}" via ${agent.name} (role: ${agent.role})`);
    } else if (isDecide) {
      // Decide mode: agent evaluates based ONLY on configured instructions
      if (!instructions) {
        // No instructions → auto-proceed without LLM call
        console.log(`[Workflow] Decide: no instructions configured — auto-proceeding "${task.text.slice(0, 60)}"`);
        task.history = task.history || [];
        task.history.push({
          status: targetStatus,
          from: task.status,
          timestamp: new Date().toISOString(),
          agent: agent.name,
          type: 'decide',
          decision: 'proceed',
          reason: 'No decision instructions configured — auto-proceed'
        });
        task.status = targetStatus;
        task.assignee = null;
        // Update the actual agent's todoList and persist
        const creatorAgent = agentManager.agents.get(task.agentId);
        const actualTask = creatorAgent?.todoList?.find(t => t.id === task.id);
        if (actualTask) {
          actualTask.status = targetStatus;
          actualTask.assignee = null;
          actualTask.history = task.history;
          if (targetStatus === 'done') actualTask.completedAt = new Date().toISOString();
          saveAgent(creatorAgent);
        }
        io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task });
        _executionLocks.delete(lockKey);
        return;
      }
      prompt = `You are a decision-making agent. Your ONLY job is to evaluate the following instructions and decide if the task should proceed.

Decision instructions:
${instructions}

Task title: ${task.text}
${task.error ? `Previous error: ${task.error}` : ''}

Based STRICTLY on the decision instructions above, respond with JSON only: {"decision": "proceed"|"hold"|"revise", "reason": "brief explanation based on the instructions"}`;
      messagePrefix = '[Decide]';
      console.log(`[Workflow] Deciding "${task.text.slice(0, 80)}" via ${agent.name}`);
    } else {
      // Refinement mode: ask for an improved description
      prompt = `Refine the following task:\n\nTask: ${task.text}\n${task.project ? `Project: ${task.project}\n` : ''}\n${instructions}\n\nReply ONLY with the improved description.`;
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
        }
      );

      const response = (result?.content || fullResponse).trim();

      // Determine action mode label for history
      const actionMode = isExecution ? 'execute' : isDecide ? 'decide' : 'refine';

      if (isExecution) {
        // Save execution chat log to task history
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, _execStartMsgIdx, _execStartedAt, true, 'execute');

        // Wait for agent to signal completion via @task_execution_complete (or enter reminder loop)
        // This blocks the action chain until the agent explicitly finishes the task.
        // Pass null as targetStatus — execute mode stays in the current column;
        // the next change_status action in the chain handles the move.
        console.log(`[Workflow] Execution response received for "${task.text.slice(0, 60)}" — waiting for task_execution_complete`);
        await agentManager._waitForExecutionComplete(task.agentId, task.id, agent.id, agent.name, null, task.text);
      } else if (isDecide) {
        // Save decide action log to task history
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, _execStartMsgIdx, _execStartedAt, true, 'decide');
        // Parse the agent's decision
        const { decision, reason } = parseDecision(response);
        console.log(`[Workflow] Decision for "${task.text.slice(0, 60)}": ${decision} — ${reason.slice(0, 100)}`);

        if (decision === 'proceed') {
          // Move to target status
          if (targetStatus) {
            agentManager.setTaskStatus(task.agentId, task.id, targetStatus, { skipAutoRefine: true, by: agent.name });
          }
          console.log(`[Workflow] Decide: proceeding "${task.text.slice(0, 60)}" -> ${targetStatus}`);
        } else if (decision === 'revise') {
          // Append feedback
          if (reason) {
            agentManager.updateTaskText(task.agentId, task.id, `${task.text}\n\n---\n**Review feedback:** ${reason}`);
          }
          // Move to reject target column if configured, otherwise stay
          if (rejectTarget) {
            agentManager.setTaskStatus(task.agentId, task.id, rejectTarget, { skipAutoRefine: true, by: agent.name });
            console.log(`[Workflow] Decide: revision requested for "${task.text.slice(0, 60)}" -> ${rejectTarget}`);
          } else {
            console.log(`[Workflow] Decide: revision requested for "${task.text.slice(0, 60)}" — stays in "${task.status}"`);
          }
        } else {
          // hold — move to reject target if configured, otherwise stay
          if (rejectTarget) {
            agentManager.setTaskStatus(task.agentId, task.id, rejectTarget, { skipAutoRefine: true, by: agent.name });
            console.log(`[Workflow] Decide: holding "${task.text.slice(0, 60)}" -> ${rejectTarget}`);
          } else {
            console.log(`[Workflow] Decide: holding "${task.text.slice(0, 60)}" in "${task.status}"`);
          }
        }
      } else {
        // Refine mode — replace the task description with the refined version
        agentManager._saveExecutionLog(task.agentId, task.id, agent.id, _execStartMsgIdx, _execStartedAt, true, 'refine');
        if (response) {
          agentManager.updateTaskText(task.agentId, task.id, response);
        }
      }

      console.log(`[Workflow] Done: "${task.text.slice(0, 80)}" via ${agent.name}${targetStatus ? ` -> ${targetStatus}` : ''}`);
    } finally {
      io.emit('agent:stream:end', {
        agentId: agent.id,
        agentName: agent.name,
        project: agent.project || null,
      });
      // Emit agent:updated so the frontend gets the updated conversation history
      agentManager._emitToOwner('agent:updated', agentManager._sanitize(agent));
    }
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
        saveAgent(creatorAgent);
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
