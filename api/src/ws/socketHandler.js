// ── Per-socket rate limiter for mutating WebSocket events ────────────
// Prevents a single client from flooding chat/broadcast/delegation events.
function createSocketRateLimiter(maxEvents = 30, windowMs = 60_000) {
  const timestamps = [];
  return function checkLimit() {
    const now = Date.now();
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
    if (timestamps.length >= maxEvents) return false;
    timestamps.push(now);
    return true;
  };
}

// Global dedup cache: stores recently processed messageIds to reject replays.
// Each entry is auto-evicted after 60 seconds.
const _recentMessageIds = new Map();
function _trackMessageId(messageId) {
  if (!messageId) return false; // no ID → cannot dedup, allow through
  if (_recentMessageIds.has(messageId)) return true; // duplicate
  _recentMessageIds.set(messageId, Date.now());
  setTimeout(() => _recentMessageIds.delete(messageId), 60_000);
  return false; // first time
}

export function setupSocketHandlers(io, agentManager) {
  io.on('connection', (socket) => {
    console.log(`⚡ Client connected: ${socket.user?.username}`);

    // Per-socket rate limiter — 30 mutating events per minute
    const checkSocketRate = createSocketRateLimiter(30, 60_000);

    // Track agents with in-flight chat requests on this socket to prevent duplicates
    const chatInFlight = new Set();

    // Send initial state — filtered by user (admin sees all, others see own + unowned)
    const userId = socket.user?.userId;
    const userRole = socket.user?.role;
    socket.emit('agents:list', agentManager.getAllForUser(userId, userRole));

    // ── Chat with streaming ───────────────────────────────────────────
    socket.on('agent:chat', async (data) => {
      const { agentId, message, messageId } = data;
      if (!agentId || !message) return;
      if (!checkSocketRate()) {
        socket.emit('error', { message: 'Rate limit exceeded. Please wait before sending more messages.' });
        return;
      }

      // Global dedup: reject replayed events (e.g. socket.io reconnect buffer)
      if (_trackMessageId(messageId)) {
        console.warn(`⚠️ Duplicate messageId ${messageId} rejected (replay)`);
        return;
      }

      // Prevent duplicate concurrent requests for the same agent
      if (chatInFlight.has(agentId)) {
        console.warn(`⚠️ Duplicate chat request ignored for agent ${agentId} (already in-flight)`);
        return;
      }
      chatInFlight.add(agentId);

      const agentData = agentManager.agents.get(agentId);
      const project = agentData?.project || null;

      try {
        socket.emit('agent:stream:start', { agentId, project });

        await agentManager.sendMessage(agentId, message, (chunk) => {
          socket.emit('agent:stream:chunk', { agentId, project, chunk });
          // Also broadcast the thinking state to all clients
          io.emit('agent:thinking', {
            agentId,
            project,
            thinking: agentManager.agents.get(agentId)?.currentThinking || ''
          });
        });

        socket.emit('agent:stream:end', { agentId, project });
        // Note: agentManager.sendMessage() already emits agent:updated internally
      } catch (err) {
        socket.emit('agent:stream:error', { agentId, project, error: err.message });
      } finally {
        chatInFlight.delete(agentId);
      }
    });

    // ── Broadcast to all agents (tmux) ────────────────────────────────
    socket.on('broadcast:message', async (data) => {
      const { message } = data;
      if (!message) return;
      if (!checkSocketRate()) {
        socket.emit('error', { message: 'Rate limit exceeded. Please wait before sending more messages.' });
        return;
      }

      socket.emit('broadcast:start', { message });

      try {
        const results = await agentManager.broadcastMessage(
          message,
          (agentId, chunk) => {
            const a = agentManager.agents.get(agentId);
            socket.emit('agent:stream:chunk', { agentId, project: a?.project || null, chunk });
            io.emit('agent:thinking', {
              agentId,
              project: a?.project || null,
              thinking: a?.currentThinking || ''
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
      if (!checkSocketRate()) {
        socket.emit('error', { message: 'Rate limit exceeded.' });
        return;
      }

      const targetAgent = agentManager.agents.get(toId);
      const targetProject = targetAgent?.project || null;

      try {
        // Stream the target agent's response in real-time
        io.emit('agent:stream:start', { agentId: toId, project: targetProject });

        const response = await agentManager.handoff(fromId, toId, context, (chunk) => {
          io.emit('agent:stream:chunk', { agentId: toId, project: targetProject, chunk });
          io.emit('agent:thinking', {
            agentId: toId,
            project: targetProject,
            thinking: agentManager.agents.get(toId)?.currentThinking || ''
          });
        });

        io.emit('agent:stream:end', { agentId: toId, project: targetProject });
        // Note: agentManager already emits agent:updated internally

        socket.emit('agent:handoff:complete', { fromId, toId, response });
      } catch (err) {
        io.emit('agent:stream:error', { agentId: toId, project: targetProject, error: err.message });
        socket.emit('agent:handoff:error', { error: err.message });
      }
    });

    // ── Ping agent status ─────────────────────────────────────────────
    socket.on('agents:refresh', () => {
      socket.emit('agents:list', agentManager.getAllForUser(userId, userRole));
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

    // ── Execute single task ─────────────────────────────────────────
    socket.on('agent:task:execute', async (data) => {
      const { agentId, taskId } = data;
      if (!agentId || !taskId) return;

      const taskAgent = agentManager.agents.get(agentId);
      const taskProject = taskAgent?.project || null;

      try {
        socket.emit('agent:stream:start', { agentId, project: taskProject });

        const result = await agentManager.executeTask(agentId, taskId, (chunk) => {
          socket.emit('agent:stream:chunk', { agentId, project: taskProject, chunk });
          io.emit('agent:thinking', {
            agentId,
            project: taskProject,
            thinking: agentManager.agents.get(agentId)?.currentThinking || ''
          });
        });

        socket.emit('agent:stream:end', { agentId, project: taskProject });
        // Note: agentManager.executeTask() already emits agent:updated internally
      } catch (err) {
        socket.emit('agent:stream:error', { agentId, project: taskProject, error: err.message });
      }
    });

    // ── Execute all pending tasks ─────────────────────────────────────
    socket.on('agent:task:executeAll', async (data) => {
      const { agentId } = data;
      if (!agentId) return;

      const execAgent = agentManager.agents.get(agentId);
      const execProject = execAgent?.project || null;

      try {
        socket.emit('agent:stream:start', { agentId, project: execProject });

        await agentManager.executeAllTasks(agentId, (chunk) => {
          socket.emit('agent:stream:chunk', { agentId, project: execProject, chunk });
          io.emit('agent:thinking', {
            agentId,
            project: execProject,
            thinking: agentManager.agents.get(agentId)?.currentThinking || ''
          });
        });

        socket.emit('agent:stream:end', { agentId, project: execProject });
        // Note: agentManager.executeAllTasks() already emits agent:updated internally
      } catch (err) {
        socket.emit('agent:stream:error', { agentId, project: execProject, error: err.message });
      }
    });

    // ── Voice delegation (Realtime API function call relay) ──────────
    socket.on('voice:delegate', async (data) => {
      const { agentId, targetAgentName, task } = data;
      if (!agentId || !targetAgentName || !task) return;
      if (!checkSocketRate()) {
        socket.emit('voice:delegate:result', { agentId, targetAgentName, error: 'Rate limit exceeded', result: null });
        return;
      }

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

        const voiceTargetProject = targetAgent.project || null;

        // Stream to the sub-agent's own chat
        io.emit('agent:stream:start', { agentId: targetAgent.id, project: voiceTargetProject });

        const leader = agentManager.agents.get(agentId);
        const leaderName = leader?.name || 'Voice Leader';

        // Create a task on the target agent
        agentManager.addTask(targetAgent.id, `[From ${leaderName}] ${task}`);

        const response = await agentManager.sendMessage(
          targetAgent.id,
          `[TASK from ${leaderName}]: ${task}`,
          (chunk) => {
            io.emit('agent:stream:chunk', { agentId: targetAgent.id, project: voiceTargetProject, chunk });
            io.emit('agent:thinking', {
              agentId: targetAgent.id,
              project: voiceTargetProject,
              thinking: agentManager.agents.get(targetAgent.id)?.currentThinking || ''
            });
          }
        );

        io.emit('agent:stream:end', { agentId: targetAgent.id, project: voiceTargetProject });
        // Note: agentManager.sendMessage() already emits agent:updated internally

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

    // ── Voice ask (lightweight question to another agent) ────────────
    socket.on('voice:ask', async (data) => {
      const { agentId, targetAgentName, question } = data;
      if (!agentId || !targetAgentName || !question) return;

      try {
        const targetAgent = agentManager.getAll().find(
          a => a.name.toLowerCase() === targetAgentName.toLowerCase()
        );
        if (!targetAgent) {
          socket.emit('voice:ask:result', { agentId, targetAgentName, error: `Agent "${targetAgentName}" not found in swarm`, result: null });
          return;
        }

        if (targetAgent.status === 'busy') {
          socket.emit('voice:ask:result', { agentId, targetAgentName, error: `Agent "${targetAgentName}" is currently busy`, result: null });
          return;
        }

        console.log(`🎙️ [Voice Ask] "${targetAgentName}" ← question: ${question.slice(0, 80)}`);

        const voiceAgent = agentManager.agents.get(agentId);
        const voiceName = voiceAgent?.name || 'Voice Leader';
        const targetProject = targetAgent.project || null;

        io.emit('agent:stream:start', { agentId: targetAgent.id, project: targetProject });

        const answer = await agentManager.sendMessage(
          targetAgent.id,
          `[QUESTION from ${voiceName}]: ${question}\n\nPlease provide a concise, direct answer.`,
          (chunk) => {
            io.emit('agent:stream:chunk', { agentId: targetAgent.id, project: targetProject, chunk });
          },
          1,
          { type: 'ask-question', fromAgent: voiceName }
        );

        io.emit('agent:stream:end', { agentId: targetAgent.id, project: targetProject });
        // Note: agentManager.sendMessage() already emits agent:updated internally

        socket.emit('voice:ask:result', { agentId, targetAgentName, error: null, result: answer });
      } catch (err) {
        console.error(`🎙️ [Voice Ask] Error: ${err.message}`);
        socket.emit('voice:ask:result', { agentId, targetAgentName, error: err.message, result: null });
      }
    });

    // ── Voice management tools (quick sync operations) ────────────────
    socket.on('voice:management', async (data) => {
      const { agentId, functionName, args } = data;
      if (!agentId || !functionName) return;

      const voiceAgent = agentManager.agents.get(agentId);
      if (!voiceAgent) {
        socket.emit('voice:management:result', { agentId, functionName, error: 'Voice agent not found', result: null });
        return;
      }

      // Helper to find an agent by name (excluding self)
      const findAgent = (name) => Array.from(agentManager.agents.values()).find(
        a => a.name.toLowerCase() === (name || '').toLowerCase() && a.id !== agentId && a.enabled !== false
      );

      try {
        let result;

        switch (functionName) {
          case 'assign_project': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            agentManager.update(target.id, { project: args.project_name });
            io.emit('agent:updated', agentManager.getById(target.id));
            result = `Assigned ${target.name} to project "${args.project_name}"`;
            console.log(`🎙️ [Voice] assign_project: ${target.name} → ${args.project_name}`);
            break;
          }
          case 'get_project': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            result = target.project ? `${target.name} is assigned to project "${target.project}"` : `${target.name} has no project assigned`;
            break;
          }
          case 'list_agents': {
            const enabled = Array.from(agentManager.agents.values()).filter(a => a.enabled !== false);
            result = enabled.map(a => `${a.name} [${a.status}] (${a.role || 'worker'})${a.project ? ` project=${a.project}` : ''}`).join('\n');
            break;
          }
          case 'agent_status': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            const pending = (target.todoList || []).filter(t => t.status === 'pending' || t.status === 'error').length;
            const total = (target.todoList || []).length;
            const msgs = (target.conversationHistory || []).length;
            result = `${target.name}: status=${target.status}, role=${target.role || 'worker'}, project=${target.project || 'none'}, tasks=${pending} pending/${total} total, messages=${msgs}`;
            break;
          }
          case 'get_available_agent': {
            const available = Array.from(agentManager.agents.values()).find(
              a => a.id !== agentId && a.enabled !== false && a.status === 'idle' && (a.role || '').toLowerCase() === (args.role || '').toLowerCase()
            );
            result = available
              ? `Available ${args.role}: ${available.name} [idle]${available.project ? ` project=${available.project}` : ''}`
              : `No idle agent with role "${args.role}" available`;
            break;
          }
          case 'list_projects': {
            const projects = await agentManager._listAvailableProjects();
            result = projects.length > 0 ? `Available projects: ${projects.join(', ')}` : 'No projects found';
            break;
          }
          case 'clear_context': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            agentManager.clearHistory(target.id);
            result = `Cleared conversation history for ${target.name}`;
            console.log(`🎙️ [Voice] clear_context: ${target.name}`);
            break;
          }
          case 'rollback': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            const histLen = target.conversationHistory.length;
            const count = Math.min(args.count || 0, histLen);
            if (count === 0) { result = `${target.name} has no messages to rollback`; break; }
            const newLen = histLen - count;
            target.conversationHistory = target.conversationHistory.slice(0, newLen);
            if (newLen === 0) delete target._compactionArmed;
            agentManager.update(target.id, {});
            io.emit('agent:updated', agentManager.getById(target.id));
            result = `Rolled back ${count} message(s) from ${target.name} (${histLen} → ${newLen})`;
            console.log(`🎙️ [Voice] rollback: ${target.name} -${count}`);
            break;
          }
          case 'stop_agent': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            const stopped = agentManager.stopAgent(target.id);
            result = stopped ? `Stopped agent ${target.name}` : `${target.name} is not currently busy`;
            if (stopped) io.emit('agent:updated', agentManager.getById(target.id));
            console.log(`🎙️ [Voice] stop_agent: ${target.name} → ${stopped ? 'stopped' : 'not busy'}`);
            break;
          }
          case 'clear_all_chats': {
            let count = 0;
            for (const a of agentManager.agents.values()) {
              if (a.id !== agentId && a.enabled !== false) {
                agentManager.clearHistory(a.id);
                count++;
              }
            }
            result = `Cleared conversation history for ${count} agents`;
            console.log(`🎙️ [Voice] clear_all_chats: ${count} agents`);
            break;
          }
          case 'clear_all_action_logs': {
            let count = 0;
            for (const a of agentManager.agents.values()) {
              if (a.id !== agentId && a.enabled !== false) {
                agentManager.clearActionLogs(a.id);
                count++;
              }
            }
            result = `Cleared action logs for ${count} agents`;
            console.log(`🎙️ [Voice] clear_all_action_logs: ${count} agents`);
            break;
          }
          default:
            result = `Unknown management function: ${functionName}`;
        }

        socket.emit('voice:management:result', { agentId, functionName, error: null, result });
      } catch (err) {
        console.error(`🎙️ [Voice Management] ${functionName} error: ${err.message}`);
        socket.emit('voice:management:result', { agentId, functionName, error: err.message, result: null });
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.user?.username}`);
    });
  });
}
