import { getSettings } from './configManager.js';

/**
 * Find the first available agent matching a role.
 * "Available" = enabled AND not busy.
 * Falls back to any enabled agent with the role if all are busy.
 */
function findAgentByRole(agentManager, role) {
  const agents = Array.from(agentManager.agents.values());
  const matching = agents.filter(
    a => a.enabled !== false && (a.role || '').toLowerCase() === role.toLowerCase()
  );
  // Prefer idle agents
  return matching.find(a => a.status !== 'busy') || matching[0] || null;
}

/**
 * Process an automatic workflow transition.
 *
 * Two modes based on transition config:
 * - Refinement mode (default): sends a refinement prompt, appends result to task text
 * - Execution mode (instructions empty or contains [EXECUTE]): sends the task as-is for execution
 *
 * The `todo._transition` object carries: { agent (role), to (target status or null), instructions }
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

    // Find agent by role
    let agent = null;
    if (transitionRole) {
      agent = findAgentByRole(agentManager, transitionRole);
      if (agent) console.log(`[Workflow] Found agent by role "${transitionRole}": ${agent.name} (${agent.id})`);
    }

    // Fallback: try global ideasAgent setting (by name, for backward compat)
    if (!agent) {
      const settings = await getSettings();
      if (settings.ideasAgent) {
        agent = Array.from(agentManager.agents.values()).find(
          a => a.enabled !== false && (a.name || '').toLowerCase() === settings.ideasAgent.toLowerCase()
        );
        if (agent) console.log(`[Workflow] Found agent via ideasAgent setting: ${agent.name}`);
      }
    }

    // In execute mode, fall back to the task's own agent when no role-matched agent is found
    if (!agent && isExecution && todo.agentId) {
      agent = agentManager.agents.get(todo.agentId);
      if (agent) {
        console.log(`[Workflow] Execute mode: using task owner "${agent.name}" (${agent.id})`);
      }
    }

    if (!agent) {
      console.log(`[Workflow] No agent found for transition${targetStatus ? `, moving to ${targetStatus}` : ''}`);
      if (targetStatus) agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus, { skipAutoRefine: true, by: 'workflow' });
      return;
    }

    // Check if agent is busy — if so, wait briefly then check again
    if (agent.status === 'busy') {
      console.log(`[Workflow] Agent "${agent.name}" is busy, waiting up to 30s for it to become idle...`);
      const waitStart = Date.now();
      while (agent.status === 'busy' && Date.now() - waitStart < 30000) {
        await new Promise(r => setTimeout(r, 2000));
      }
      if (agent.status === 'busy') {
        console.log(`[Workflow] Agent "${agent.name}" still busy after 30s — aborting transition`);
        return;
      }
      console.log(`[Workflow] Agent "${agent.name}" is now idle, proceeding`);
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
      } else {
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
