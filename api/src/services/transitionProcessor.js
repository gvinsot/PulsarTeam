import { getSettings } from './configManager.js';
import { saveAgent } from './database.js';
import { getWorkflow } from './workflowManager.js';

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
 * Returns null if no idle agent with the role exists — the task stays pending.
 */
function findAgentByRole(agentManager, role) {
  const agents = Array.from(agentManager.agents.values());
  const matching = agents.filter(
    a => a.enabled !== false && (a.role || '').toLowerCase() === role.toLowerCase()
  );
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
 *
 * The `todo._transition` object carries: { agent (role), to (target status or null), instructions, mode }
 */
export async function processTransition(todo, agentManager, io) {
  const targetStatus = todo._transition?.to ?? 'backlog';
  const transitionRole = todo._transition?.agent;
  const mode = todo._transition?.mode;
  const instructions = todo._transition?.instructions || '';

  // Prevent concurrent execution of the same task (with TTL-based lock)
  const lockKey = `${todo.agentId}:${todo.id}`;
  if (!_acquireExecutionLock(lockKey)) {
    console.log(`[Workflow] Skipping duplicate processTransition for "${todo.text?.slice(0, 60)}" — already in progress`);
    return;
  }

  console.log(`[Workflow] processTransition called: todo="${todo.text?.slice(0, 60)}" from="${todo.status}" to="${targetStatus}" mode="${mode}" role="${transitionRole || 'none'}" agentId="${todo.agentId}"`);

  try {
    // Explicit mode takes precedence; fall back to legacy heuristic
    const isExecution = mode === 'execute' || (!mode && (!instructions || instructions.includes('[EXECUTE]')));
    const isDecide = mode === 'decide';

    // Find the agent to run this transition
    let agent = null;

    if (isExecution) {
      // Execute mode: use the task's assignee ONLY — never fallback to owner
      const assignee = todo.assignee ? agentManager.agents.get(todo.assignee) : null;
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
      // Non-execute modes: find agent by role
      if (transitionRole) {
        agent = findAgentByRole(agentManager, transitionRole);
        if (agent) console.log(`[Workflow] Found agent by role "${transitionRole}": ${agent.name} (${agent.id})`);
      }
    }

    // Fallback for non-execute modes: try global ideasAgent setting
    if (!agent && !isExecution) {
      const settings = await getSettings();
      if (settings.ideasAgent) {
        agent = Array.from(agentManager.agents.values()).find(
          a => a.enabled !== false && a.status === 'idle' && (a.name || '').toLowerCase() === settings.ideasAgent.toLowerCase()
        );
        if (agent) console.log(`[Workflow] Found idle agent via ideasAgent setting: ${agent.name}`);
      }
    }

    if (!agent) {
      console.log(`[Workflow] No idle agent found for role "${transitionRole || 'any'}" — task stays pending (will be picked up when an agent becomes available)`);
      _executionLocks.delete(lockKey);
      return;
    }

    // Auto-switch agent to the todo's project if needed
    if (todo.project && todo.project !== agent.project) {
      console.log(`[Workflow] Switching "${agent.name}" to project "${todo.project}" for transition`);
      if (agentManager._switchProjectContext) {
        agentManager._switchProjectContext(agent, agent.project, todo.project);
      }
      agent.project = todo.project;
    }

    let prompt;
    let messagePrefix;
    if (isExecution) {
      // Execution mode: mark in_progress (only if not already), execute the task
      if (todo.status !== 'in_progress') {
        agentManager.setTodoStatus(todo.agentId, todo.id, 'in_progress', { skipAutoRefine: true, by: agent.name });
      }
      prompt = todo.text;
      messagePrefix = '';
      console.log(`[Workflow] Executing "${todo.text.slice(0, 80)}" via ${agent.name} (role: ${agent.role})`);
    } else if (isDecide) {
      // Decide mode: agent evaluates based ONLY on configured instructions
      if (!instructions) {
        // No instructions → auto-proceed without LLM call
        console.log(`[Workflow] Decide: no instructions configured — auto-proceeding "${todo.text.slice(0, 60)}"`);
        todo.history = todo.history || [];
        todo.history.push({
          status: targetStatus,
          from: todo.status,
          timestamp: new Date().toISOString(),
          agent: agent.name,
          type: 'decide',
          decision: 'proceed',
          reason: 'No decision instructions configured — auto-proceed'
        });
        todo.status = targetStatus;
        todo.assignee = null;
        // Update the actual agent's todoList and persist
        const ownerAgent = agentManager.agents.get(todo.agentId);
        const actualTodo = ownerAgent?.todoList?.find(t => t.id === todo.id);
        if (actualTodo) {
          actualTodo.status = targetStatus;
          actualTodo.assignee = null;
          actualTodo.history = todo.history;
          if (targetStatus === 'done') actualTodo.completedAt = new Date().toISOString();
          saveAgent(ownerAgent);
        }
        io?.to(`agent:${todo.agentId}`)?.emit('todo:updated', { agentId: todo.agentId, todo });
        _executionLocks.delete(lockKey);
        return;
      }
      prompt = `You are a decision-making agent. Your ONLY job is to evaluate the following instructions and decide if the task should proceed.

Decision instructions:
${instructions}

Task title: ${todo.text}
${todo.error ? `Previous error: ${todo.error}` : ''}

Based STRICTLY on the decision instructions above, respond with JSON only: {"decision": "proceed"|"hold"|"revise", "reason": "brief explanation based on the instructions"}`;
      messagePrefix = '[Decide]';
      console.log(`[Workflow] Deciding "${todo.text.slice(0, 80)}" via ${agent.name}`);
    } else {
      // Refinement mode: ask for an improved description
      prompt = `Refine the following task:\n\nTask: ${todo.text}\n${todo.project ? `Project: ${todo.project}\n` : ''}\n${instructions}\n\nReply ONLY with the improved description.`;
      messagePrefix = '[Auto-Transition]';
      console.log(`[Workflow] Refining "${todo.text.slice(0, 80)}" via ${agent.name} (role: ${agent.role})`);
    }

    let fullResponse = '';

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

      if (isExecution) {
        // Check if workflow has a transition from in_progress (condition or agent-based)
        // If so, let workflow handle it; otherwise move to targetStatus directly
        let workflowManagesInProgress = false;
        try {
          const wf = await getWorkflow('_default');
          workflowManagesInProgress = wf.transitions.some(t => {
            if (t.actions) {
              // New format: check for condition trigger or run_agent actions
              return t.from === 'in_progress' && (
                (t.trigger === 'condition' && (t.conditions || []).length > 0) ||
                (t.actions || []).some(a => a.type === 'run_agent')
              );
            }
            // Old format
            return t.from === 'in_progress' && (t.autoRefine || t.triggerType === 'condition');
          });
        } catch (_) { /* use default: move immediately */ }

        if (workflowManagesInProgress) {
          console.log(`[Workflow] Execution finished for "${todo.text.slice(0, 60)}" — stays in_progress for workflow transition`);
        } else if (targetStatus) {
          agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus, { skipAutoRefine: true, by: agent.name });
          console.log(`[Workflow] Execution finished for "${todo.text.slice(0, 60)}" — moved to ${targetStatus}`);
        }
      } else if (isDecide) {
        // Parse the agent's decision
        const { decision, reason } = parseDecision(response);
        console.log(`[Workflow] Decision for "${todo.text.slice(0, 60)}": ${decision} — ${reason.slice(0, 100)}`);

        if (decision === 'proceed') {
          // Move to target status
          if (targetStatus) {
            agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus, { skipAutoRefine: true, by: agent.name });
          }
          console.log(`[Workflow] Decide: proceeding "${todo.text.slice(0, 60)}" -> ${targetStatus}`);
        } else if (decision === 'revise') {
          // Append feedback but keep task in current status
          if (reason) {
            agentManager.updateTodoText(todo.agentId, todo.id, `${todo.text}\n\n---\n**Review feedback:** ${reason}`);
          }
          console.log(`[Workflow] Decide: revision requested for "${todo.text.slice(0, 60)}" — stays in "${todo.status}"`);
        } else {
          // hold — task stays in current status, no changes
          console.log(`[Workflow] Decide: holding "${todo.text.slice(0, 60)}" in "${todo.status}"`);
        }
      } else {
        // Refine mode
        if (response) {
          agentManager.updateTodoText(todo.agentId, todo.id, `${todo.text}\n\n---\n${response}`);
        }
        if (targetStatus) {
          agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus, { skipAutoRefine: true, by: agent.name });
        }
      }

      console.log(`[Workflow] Done: "${todo.text.slice(0, 80)}" via ${agent.name}${targetStatus ? ` -> ${targetStatus}` : ''}`);
    } finally {
      io.emit('agent:stream:end', {
        agentId: agent.id,
        agentName: agent.name,
        project: agent.project || null,
      });
      // Emit agent:updated so the frontend gets the updated conversation history
      io.emit('agent:updated', agentManager._sanitize(agent));
    }
  } catch (err) {
    console.error(`[Workflow] Error processing "${todo.text}":`, err.message, err.stack);
    try {
      const isExec = mode === 'execute' || (!mode && (!instructions || instructions.includes('[EXECUTE]')));
      if (isExec) {
        agentManager.setTodoStatus(todo.agentId, todo.id, 'error', { skipAutoRefine: true, by: 'workflow' });
      } else if (targetStatus) {
        agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus, { skipAutoRefine: true, by: 'workflow' });
      }
    } catch (e) {
      console.error(`[Workflow] Failed to set status after error:`, e.message);
    }
  } finally {
    _executionLocks.delete(lockKey);
  }
}
