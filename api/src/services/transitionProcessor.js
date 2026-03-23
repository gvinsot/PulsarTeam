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

  try {
    // Find agent by role
    let agent = null;
    if (transitionRole) {
      agent = findAgentByRole(agentManager, transitionRole);
    }

    // Fallback: try global ideasAgent setting (by name, for backward compat)
    if (!agent) {
      const settings = await getSettings();
      if (settings.ideasAgent) {
        agent = Array.from(agentManager.agents.values()).find(
          a => a.enabled !== false && (a.name || '').toLowerCase() === settings.ideasAgent.toLowerCase()
        );
      }
    }

    if (!agent) {
      console.log(`[Workflow] No agent with role "${transitionRole}" found${targetStatus ? `, moving to ${targetStatus}` : ''}`);
      if (targetStatus) agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus, { skipAutoRefine: true, by: 'workflow' });
      return;
    }

    const instructions = todo._transition?.instructions || '';
    const isExecution = !instructions || instructions.includes('[EXECUTE]');

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
      // Execution mode: mark in_progress, send the task directly
      agentManager.setTodoStatus(todo.agentId, todo.id, 'in_progress', { skipAutoRefine: true, by: agent.name });
      prompt = todo.text;
      messagePrefix = '[TASK]';
      console.log(`[Workflow] Executing "${todo.text}" via ${agent.name} (role: ${agent.role})`);
    } else {
      // Refinement mode: ask for an improved description
      prompt = `Refine the following task:\n\nTask: ${todo.text}\n${todo.project ? `Project: ${todo.project}\n` : ''}\n${instructions}\n\nReply ONLY with the improved description.`;
      messagePrefix = '[Auto-Transition]';
      console.log(`[Workflow] Refining "${todo.text}" via ${agent.name} (role: ${agent.role})`);
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
        `${messagePrefix} ${prompt}`,
        (chunk) => {
          fullResponse += chunk;
          io.emit('agent:stream:chunk', {
            agentId: agent.id,
            agentName: agent.name,
            project: agent.project || null,
            chunk,
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

      console.log(`[Workflow] Done: "${todo.text}" via ${agent.name}${targetStatus ? ` -> ${targetStatus}` : ''}`);
    } finally {
      io.emit('agent:stream:end', {
        agentId: agent.id,
        agentName: agent.name,
        project: agent.project || null,
      });
    }
  } catch (err) {
    console.error(`[Workflow] Error processing "${todo.text}":`, err.message);
    try {
      const instructions = todo._transition?.instructions || '';
      const isExec = !instructions || instructions.includes('[EXECUTE]');
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
