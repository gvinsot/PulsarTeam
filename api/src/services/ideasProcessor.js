import { getSettings } from './configManager.js';

/**
 * Process a todo in "idea" status: send it as a message to the configured
 * ideas-agent so the refinement is visible in the agent's chat, then move
 * the todo to backlog with the improved description.
 *
 * @param {object}       todo         The todo object (must have .id, .text, .agentId)
 * @param {AgentManager} agentManager The running AgentManager instance
 * @param {SocketIO}     io           Socket.IO server (for streaming to all clients)
 */
export async function processIdeaTodo(todo, agentManager, io) {
  try {
    const settings = await getSettings();
    const ideasAgentName = settings.ideasAgent;

    // Use transition config if available, default to 'backlog'
    const targetStatus = todo._transition?.to || 'backlog';

    if (!ideasAgentName) {
      // No agent configured — silently move to target status
      agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus);
      return;
    }

    // Find agent: prefer transition config agent role, fall back to settings agent name
    const transitionAgentRole = todo._transition?.agent;
    let ideasAgent = null;
    if (transitionAgentRole) {
      ideasAgent = Array.from(agentManager.agents.values()).find(
        a => a.enabled !== false && (a.role || '').toLowerCase() === transitionAgentRole.toLowerCase()
      );
    }
    if (!ideasAgent) {
      ideasAgent = Array.from(agentManager.agents.values()).find(
        a => a.enabled !== false && (a.name || '').toLowerCase() === ideasAgentName.toLowerCase()
      );
    }

    if (!ideasAgent) {
      console.log(`[Workflow] Agent "${transitionAgentRole || ideasAgentName}" not found, moving to ${targetStatus} as-is`);
      agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus);
      return;
    }

    const prompt = `Refine the following task idea into a clear, actionable task description for a development team.

Task: ${todo.text}
${todo.project ? `Project: ${todo.project}` : ''}

Improve the task description with more details or adding relevant context and additionnal related ideas that can improve the product without too much effort. 
Keep it concise but informative.

Reply ONLY with the improved description. No title, no headers, no preamble.`;

    console.log(`[Workflow] Refining "${todo.text}" via agent "${ideasAgent.name}" (${todo.status} → ${targetStatus})`);

    // Stream the refinement through the ideas agent's chat so it's visible in the UI
    let fullResponse = '';

    io.emit('agent:stream:start', {
      agentId: ideasAgent.id,
      agentName: ideasAgent.name,
      project: ideasAgent.project || null,
    });

    try {
      const result = await agentManager.sendMessage(
        ideasAgent.id,
        `[Idea Refinement] ${prompt}`,
        (chunk) => {
          fullResponse += chunk;
          io.emit('agent:stream:chunk', {
            agentId: ideasAgent.id,
            agentName: ideasAgent.name,
            project: ideasAgent.project || null,
            chunk,
          });
        }
      );

      const improved = (result?.content || fullResponse).trim();

      if (improved) {
        // Update todo text with the refined description and move to backlog
        agentManager.updateTodoText(todo.agentId, todo.id, `${todo.text}\n\n---\n${improved}`);
      }
      agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus);
      console.log(`[Workflow] Refined and moved to ${targetStatus}: "${todo.text}"`);
    } finally {
      io.emit('agent:stream:end', {
        agentId: ideasAgent.id,
        agentName: ideasAgent.name,
        project: ideasAgent.project || null,
      });
    }
  } catch (err) {
    console.error(`[Ideas] Error processing "${todo.text}":`, err.message);
    // Move to backlog so it doesn't get stuck
    try {
      agentManager.setTodoStatus(todo.agentId, todo.id, targetStatus);
    } catch (e) {
      console.error(`[Ideas] Failed to move to backlog after error:`, e.message);
    }
  }
}
