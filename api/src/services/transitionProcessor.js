import { getSettings } from './configManager.js';

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
  // Only return idle agents — do NOT fall back to busy ones
  return matching.find(a => a.status === 'idle') || null;
}

/**
 * Parse a decide-mode response to extract the structured decision.
 * Accepts JSON like { "decision": "proceed" } or plain text containing proceed/hold/revise.
 */
function parseDecision(response) {
  // Try JSON first
  try {
    const jsonMatch = response.match(/\{[\s\S]*?"decision"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        decision: (parsed.decision || 'hold').toLowerCase(),
        reason: parsed.reason || '',
      };
    }
  } catch (_) { /* not valid JSON, fall through */ }

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

  console.log(`[Workflow] processTransition called: todo="${todo.text?.slice(0, 60)}" from="${todo.status}" to="${targetStatus}" mode="${mode}" role="${transitionRole || 'none'}" agentId="${todo.agentId}"`);

  try {
    // Explicit mode takes precedence; fall back to legacy heuristic
    const isExecution = mode === 'execute' || (!mode && (!instructions || instructions.includes('[EXECUTE]')));
    const isDecide = mode === 'decide';

    // Find agent by role
    let agent = null;
    if (transitionRole) {
      agent = findAgentByRole(agentManager, transitionRole);
      if (agent) console.log(`[Workflow] Found agent by role "${transitionRole}": ${agent.name} (${agent.id})`);
    }

    // Fallback: try global ideasAgent setting (by name, for backward compat)
    // Only assign if the agent is idle — never force-assign a busy agent
    if (!agent) {
      const settings = await getSettings();
      if (settings.ideasAgent) {
        agent = Array.from(agentManager.agents.values()).find(
          a => a.enabled !== false && a.status === 'idle' && (a.name || '').toLowerCase() === settings.ideasAgent.toLowerCase()
        );
        if (agent) console.log(`[Workflow] Found idle agent via ideasAgent setting: ${agent.name}`);
      }
    }

    // In execute mode, fall back to the task's own agent when no role-matched agent is found
    // Only if the task owner is idle
    if (!agent && isExecution && todo.agentId) {
      const owner = agentManager.agents.get(todo.agentId);
      if (owner && owner.enabled !== false && owner.status === 'idle') {
        agent = owner;
        console.log(`[Workflow] Execute mode: using idle task owner "${agent.name}" (${agent.id})`);
      }
    }

    if (!agent) {
      console.log(`[Workflow] No idle agent found for role "${transitionRole || 'any'}" — task stays pending (will be picked up when an agent becomes available)`);
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
      // Decide mode: agent evaluates whether the task should proceed
      prompt = `You are a decision gate. Evaluate the following task and decide if it should proceed to the next step.

Task: ${todo.text}
${todo.project ? `Project: ${todo.project}\n` : ''}${instructions ? `Criteria: ${instructions}\n` : ''}
You MUST reply with a JSON object (and nothing else) in this exact format:
{ "decision": "proceed" | "hold" | "revise", "reason": "brief explanation" }

- "proceed": the task is ready to move to the next step
- "hold": the task should stay in its current state (not ready yet)
- "revise": the task needs changes before it can proceed (explain what needs to change)`;
      messagePrefix = '[Decide]';
      console.log(`[Workflow] Deciding "${todo.text.slice(0, 80)}" via ${agent.name} (role: ${agent.role})`);
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
        if (targetStatus) {
          agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus, { skipAutoRefine: true, by: agent.name });
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
  }
}
