export function setupSocketHandlers(io, agentManager) {
  io.on('connection', (socket) => {
    console.log(`⚡ Client connected: ${socket.user?.username}`);

    // Send initial state
    socket.emit('agents:list', agentManager.getAll());

    // ── Chat with streaming ───────────────────────────────────────────
    socket.on('agent:chat', async (data) => {
      const { agentId, message } = data;
      if (!agentId || !message) return;

      try {
        socket.emit('agent:stream:start', { agentId });

        await agentManager.sendMessage(agentId, message, (chunk) => {
          socket.emit('agent:stream:chunk', { agentId, chunk });
          // Also broadcast the thinking state to all clients
          io.emit('agent:thinking', {
            agentId,
            thinking: agentManager.agents.get(agentId)?.currentThinking || ''
          });
        });

        socket.emit('agent:stream:end', { agentId });
        // Send updated agent with metrics
        const agent = agentManager.getById(agentId);
        if (agent) io.emit('agent:updated', agent);
      } catch (err) {
        socket.emit('agent:stream:error', { agentId, error: err.message });
      }
    });

    // ── Broadcast to all agents (tmux) ────────────────────────────────
    socket.on('broadcast:message', async (data) => {
      const { message } = data;
      if (!message) return;

      socket.emit('broadcast:start', { message });

      try {
        const results = await agentManager.broadcastMessage(
          message,
          (agentId, chunk) => {
            socket.emit('agent:stream:chunk', { agentId, chunk });
            io.emit('agent:thinking', {
              agentId,
              thinking: agentManager.agents.get(agentId)?.currentThinking || ''
            });
          }
        );

        socket.emit('broadcast:complete', { results });
      } catch (err) {
        socket.emit('broadcast:error', { error: err.message });
      }
    });

    // ── Handoff ───────────────────────────────────────────────────────
    socket.on('agent:handoff', async (data) => {
      const { fromId, toId, context } = data;
      if (!fromId || !toId || !context) return;

      try {
        // Stream the target agent's response in real-time
        io.emit('agent:stream:start', { agentId: toId });

        const response = await agentManager.handoff(fromId, toId, context, (chunk) => {
          io.emit('agent:stream:chunk', { agentId: toId, chunk });
          io.emit('agent:thinking', {
            agentId: toId,
            thinking: agentManager.agents.get(toId)?.currentThinking || ''
          });
        });

        io.emit('agent:stream:end', { agentId: toId });
        const agent = agentManager.getById(toId);
        if (agent) io.emit('agent:updated', agent);

        socket.emit('agent:handoff:complete', { fromId, toId, response });
      } catch (err) {
        io.emit('agent:stream:error', { agentId: toId, error: err.message });
        socket.emit('agent:handoff:error', { error: err.message });
      }
    });

    // ── Ping agent status ─────────────────────────────────────────────
    socket.on('agents:refresh', () => {
      socket.emit('agents:list', agentManager.getAll());
    });

    // ── Get swarm status with project assignments ─────────────────────
    socket.on('agents:swarm-status', () => {
      socket.emit('agents:swarm-status', agentManager.getSwarmStatus());
    });

    // ── Get lightweight status for ALL enabled agents (includes project) ─
    socket.on('agents:statuses', () => {
      socket.emit('agents:statuses', agentManager.getAllStatuses());
    });

    // ── Get single agent detailed status ──────────────────────────────
    socket.on('agent:status', (data) => {
      const { agentId } = data || {};
      if (!agentId) return;
      const status = agentManager.getAgentStatus(agentId);
      if (status) {
        socket.emit('agent:status', status);
      }
    });

    // ── Get agents by project ────────────────────────────────────────
    socket.on('agents:by-project', (data) => {
      const { project } = data || {};
      if (!project) return;
      socket.emit('agents:by-project', agentManager.getAgentsByProject(project));
    });

    // ── Get project summary ──────────────────────────────────────────
    socket.on('agents:project-summary', () => {
      socket.emit('agents:project-summary', agentManager.getProjectSummary());
    });

    // ── Stop agent ────────────────────────────────────────────────────
    socket.on('agent:stop', (data) => {
      const { agentId } = data;
      if (!agentId) return;
      
      const stopped = agentManager.stopAgent(agentId);
      if (stopped) {
        socket.emit('agent:stream:end', { agentId, stopped: true });
        io.emit('agent:updated', agentManager.getById(agentId));
      }
    });

    // ── Execute single todo ─────────────────────────────────────────
    socket.on('agent:todo:execute', async (data) => {
      const { agentId, todoId } = data;
      if (!agentId || !todoId) return;

      try {
        socket.emit('agent:stream:start', { agentId });

        const result = await agentManager.executeTodo(agentId, todoId, (chunk) => {
          socket.emit('agent:stream:chunk', { agentId, chunk });
          io.emit('agent:thinking', {
            agentId,
            thinking: agentManager.agents.get(agentId)?.currentThinking || ''
          });
        });

        socket.emit('agent:stream:end', { agentId });
        const agent = agentManager.getById(agentId);
        if (agent) io.emit('agent:updated', agent);
      } catch (err) {
        socket.emit('agent:stream:error', { agentId, error: err.message });
      }
    });

    // ── Execute all pending todos ─────────────────────────────────────
    socket.on('agent:todo:executeAll', async (data) => {
      const { agentId } = data;
      if (!agentId) return;

      try {
        socket.emit('agent:stream:start', { agentId });

        await agentManager.executeAllTodos(agentId, (chunk) => {
          socket.emit('agent:stream:chunk', { agentId, chunk });
          io.emit('agent:thinking', {
            agentId,
            thinking: agentManager.agents.get(agentId)?.currentThinking || ''
          });
        });

        socket.emit('agent:stream:end', { agentId });
        const agent = agentManager.getById(agentId);
        if (agent) io.emit('agent:updated', agent);
      } catch (err) {
        socket.emit('agent:stream:error', { agentId, error: err.message });
      }
    });

    // ── Voice delegation (Realtime API function call relay) ──────────
    socket.on('voice:delegate', async (data) => {
      const { agentId, targetAgentName, task } = data;
      if (!agentId || !targetAgentName || !task) return;

      try {
        // Find target agent by name
        const targetAgent = agentManager.getAll().find(
          a => a.name.toLowerCase() === targetAgentName.toLowerCase()
        );
        if (!targetAgent) {
          socket.emit('voice:delegate:result', {
            agentId,
            targetAgentName,
            error: `Agent "${targetAgentName}" not found in swarm`,
            result: null
          });
          return;
        }

        console.log(`🎙️ [Voice Delegate] "${targetAgentName}" ← task: ${task.slice(0, 80)}...`);

        // Stream to the sub-agent's own chat
        io.emit('agent:stream:start', { agentId: targetAgent.id });

        const leader = agentManager.agents.get(agentId);
        const leaderName = leader?.name || 'Voice Leader';

        // Create a todo on the target agent
        agentManager.addTodo(targetAgent.id, `[From ${leaderName}] ${task}`);

        const response = await agentManager.sendMessage(
          targetAgent.id,
          `[TASK from ${leaderName}]: ${task}`,
          (chunk) => {
            io.emit('agent:stream:chunk', { agentId: targetAgent.id, chunk });
            io.emit('agent:thinking', {
              agentId: targetAgent.id,
              thinking: agentManager.agents.get(targetAgent.id)?.currentThinking || ''
            });
          }
        );

        io.emit('agent:stream:end', { agentId: targetAgent.id });
        const updatedAgent = agentManager.getById(targetAgent.id);
        if (updatedAgent) io.emit('agent:updated', updatedAgent);

        socket.emit('voice:delegate:result', {
          agentId,
          targetAgentName,
          error: null,
          result: response
        });
      } catch (err) {
        console.error(`🎙️ [Voice Delegate] Error: ${err.message}`);
        socket.emit('voice:delegate:result', {
          agentId,
          targetAgentName,
          error: err.message,
          result: null
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.user?.username}`);
    });
  });
}
