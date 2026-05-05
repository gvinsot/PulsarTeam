import { getBoardsByUser, updateLastSeen } from '../services/database.js';
import { WsEvents } from './events.js';

const connectedUserIds = new Set<string>();

export function getConnectedUserIds(): Set<string> {
  return connectedUserIds;
}

// ── Per-socket rate limiter for mutating WebSocket events ────────────
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
const _recentMessageIds = new Map();
function _trackMessageId(messageId) {
  if (!messageId) return false;
  if (_recentMessageIds.has(messageId)) return true;
  _recentMessageIds.set(messageId, Date.now());
  setTimeout(() => _recentMessageIds.delete(messageId), 60_000);
  return false;
}

export function setupSocketHandlers(io, agentManager) {
  io.on('connection', async (socket) => {
    console.log(`⚡ Client connected: ${socket.user?.username}`);

    const checkSocketRate = createSocketRateLimiter(30, 60_000);
    const chatInFlight = new Set();

    // ── Per-user & per-board rooms for isolation ─────────────────────
    const userId = socket.user?.userId;
    const userRole = socket.user?.role;
    if (userId) {
      socket.join(`user:${userId}`);
      connectedUserIds.add(userId);
      updateLastSeen(userId).catch(() => {});
    }
    if (userRole === 'admin') socket.join('role:admin');

    let userBoardIds = new Set<string>();
    if (userId) {
      try {
        const boards = await getBoardsByUser(userId);
        for (const board of boards) {
          socket.join(`board:${board.id}`);
          userBoardIds.add(board.id);
        }
      } catch { /* no boards available */ }
    }

    const ws = agentManager.wsEmitter;

    socket.emit(WsEvents.AGENTS_LIST, agentManager.getAllForUser(userId, userRole, userBoardIds));

    function canAccessAgent(agentId) {
      const agent = agentManager.agents.get(agentId);
      if (!agent) return false;
      if (!agent.boardId) return true;
      return userBoardIds.has(agent.boardId);
    }

    // ── Chat with streaming ───────────────────────────────────────────
    socket.on(WsEvents.REQ_CHAT, async (data) => {
      const { agentId, message, messageId, images } = data;
      if (!agentId || !message) return;

      if (!canAccessAgent(agentId)) {
        socket.emit(WsEvents.ERROR, { message: 'Access denied: you do not have access to this agent\'s board.' });
        return;
      }
      if (!checkSocketRate()) {
        socket.emit(WsEvents.ERROR, { message: 'Rate limit exceeded. Please wait before sending more messages.' });
        return;
      }

      if (_trackMessageId(messageId)) {
        console.warn(`⚠️ Duplicate messageId ${messageId} rejected (replay)`);
        return;
      }

      if (chatInFlight.has(agentId)) {
        console.warn(`⚠️ Duplicate chat request ignored for agent ${agentId} (already in-flight)`);
        return;
      }
      chatInFlight.add(agentId);

      const agentData = agentManager.agents.get(agentId);
      const project = agentData?.project || null;

      try {
        socket.emit(WsEvents.STREAM_START, { agentId, project });

        let sanitizedImages = null;
        if (Array.isArray(images) && images.length > 0) {
          sanitizedImages = images.slice(0, 5).filter(img =>
            img && typeof img.data === 'string' && typeof img.mediaType === 'string' &&
            img.data.length < 10 * 1024 * 1024 &&
            /^image\/(png|jpeg|gif|webp)$/.test(img.mediaType)
          ).map(img => ({ data: img.data, mediaType: img.mediaType }));
          if (sanitizedImages.length === 0) sanitizedImages = null;
        }

        await agentManager.sendMessage(agentId, message, (chunk) => {
          socket.emit(WsEvents.STREAM_CHUNK, { agentId, project, chunk });
          ws.thinking(agentId);
        }, 0, null, sanitizedImages);

        socket.emit(WsEvents.STREAM_END, { agentId, project });
      } catch (err) {
        socket.emit(WsEvents.STREAM_ERROR, { agentId, project, error: err.message });
      } finally {
        chatInFlight.delete(agentId);
      }
    });

    // ── Broadcast to all agents (tmux) ────────────────────────────────
    socket.on(WsEvents.REQ_BROADCAST, async (data) => {
      const { message } = data;
      if (!message) return;
      if (!checkSocketRate()) {
        socket.emit(WsEvents.ERROR, { message: 'Rate limit exceeded. Please wait before sending more messages.' });
        return;
      }

      socket.emit(WsEvents.BROADCAST_START, { message });

      try {
        const visibleAgents = agentManager._agentsForUser(userId, userRole, userBoardIds);
        const visibleIds = new Set(visibleAgents.map(a => a.id));
        const results = await agentManager.broadcastMessage(
          message,
          (agentId, chunk) => {
            if (!visibleIds.has(agentId)) return;
            const a = agentManager.agents.get(agentId);
            socket.emit(WsEvents.STREAM_CHUNK, { agentId, project: a?.project || null, chunk });
            ws.thinking(agentId);
          },
          visibleIds
        );

        socket.emit(WsEvents.BROADCAST_COMPLETE, { results });
      } catch (err) {
        socket.emit(WsEvents.BROADCAST_ERROR, { error: err.message });
      }
    });

    // ── Handoff ───────────────────────────────────────────────────────
    socket.on(WsEvents.REQ_HANDOFF, async (data) => {
      const { fromId, toId, context } = data;
      if (!fromId || !toId || !context) return;
      if (!canAccessAgent(fromId) || !canAccessAgent(toId)) {
        socket.emit(WsEvents.HANDOFF_ERROR, { error: 'Access denied' });
        return;
      }
      if (!checkSocketRate()) {
        socket.emit(WsEvents.ERROR, { message: 'Rate limit exceeded.' });
        return;
      }

      const targetAgent = agentManager.agents.get(toId);
      const targetProject = targetAgent?.project || null;

      try {
        ws.emit(WsEvents.STREAM_START, { agentId: toId, project: targetProject });

        const response = await agentManager.handoff(fromId, toId, context, (chunk) => {
          ws.emit(WsEvents.STREAM_CHUNK, { agentId: toId, project: targetProject, chunk });
          ws.thinking(toId);
        });

        ws.emit(WsEvents.STREAM_END, { agentId: toId, project: targetProject });

        socket.emit(WsEvents.HANDOFF_COMPLETE, { fromId, toId, response });
      } catch (err) {
        ws.streamError(toId, err.message);
        socket.emit(WsEvents.HANDOFF_ERROR, { error: err.message });
      }
    });

    // ── Ping agent status ─────────────────────────────────────────────
    socket.on(WsEvents.REQ_REFRESH, () => {
      socket.emit(WsEvents.AGENTS_LIST, agentManager.getAllForUser(userId, userRole, userBoardIds));
    });

    // ── Get swarm status with project assignments ─────────────────────
    socket.on(WsEvents.REQ_SWARM_STATUS, () => {
      socket.emit(WsEvents.REQ_SWARM_STATUS, agentManager.getSwarmStatus(userId, userRole, userBoardIds));
    });

    // ── Get lightweight status for ALL enabled agents ─────────────────
    socket.on(WsEvents.REQ_STATUSES, () => {
      socket.emit(WsEvents.REQ_STATUSES, agentManager.getAllStatuses(userId, userRole, userBoardIds));
    });

    // ── Get single agent detailed status ──────────────────────────────
    socket.on(WsEvents.REQ_AGENT_STATUS, (data) => {
      const { agentId } = data || {};
      if (!agentId) return;
      if (!canAccessAgent(agentId)) return;
      const status = agentManager.getAgentStatus(agentId);
      if (status) {
        socket.emit(WsEvents.AGENT_STATUS, status);
      }
    });

    // ── Get agents by project ────────────────────────────────────────
    socket.on(WsEvents.REQ_BY_PROJECT, (data) => {
      const { project } = data || {};
      if (!project) return;
      socket.emit(WsEvents.REQ_BY_PROJECT, agentManager.getAgentsByProject(project, userId, userRole, userBoardIds));
    });

    // ── Get project summary ──────────────────────────────────────────
    socket.on(WsEvents.REQ_PROJECT_SUMMARY, () => {
      socket.emit(WsEvents.REQ_PROJECT_SUMMARY, agentManager.getProjectSummary(userId, userRole, userBoardIds));
    });

    // ── Stop agent ────────────────────────────────────────────────────
    socket.on(WsEvents.REQ_STOP, (data) => {
      const { agentId } = data;
      if (!agentId) return;
      if (!canAccessAgent(agentId)) return;

      const stopped = agentManager.stopAgent(agentId);
      if (stopped) {
        socket.emit(WsEvents.STREAM_END, { agentId, stopped: true });
        ws.agentUpdated(agentId);
      }
    });

    // ── Execute single task ─────────────────────────────────────────
    socket.on(WsEvents.REQ_TASK_EXECUTE, async (data) => {
      const { agentId, taskId } = data;
      if (!agentId || !taskId) return;
      if (!canAccessAgent(agentId)) return;

      const taskAgent = agentManager.agents.get(agentId);
      const taskProject = taskAgent?.project || null;

      try {
        socket.emit(WsEvents.STREAM_START, { agentId, project: taskProject });

        const result = await agentManager.executeTask(agentId, taskId, (chunk) => {
          socket.emit(WsEvents.STREAM_CHUNK, { agentId, project: taskProject, chunk });
          ws.thinking(agentId);
        });

        socket.emit(WsEvents.STREAM_END, { agentId, project: taskProject });
      } catch (err) {
        socket.emit(WsEvents.STREAM_ERROR, { agentId, project: taskProject, error: err.message });
      }
    });

    // ── Execute all pending tasks ─────────────────────────────────────
    socket.on(WsEvents.REQ_TASK_EXECUTE_ALL, async (data) => {
      const { agentId } = data;
      if (!agentId) return;
      if (!canAccessAgent(agentId)) return;

      const execAgent = agentManager.agents.get(agentId);
      const execProject = execAgent?.project || null;

      try {
        socket.emit(WsEvents.STREAM_START, { agentId, project: execProject });

        await agentManager.executeAllTasks(agentId, (chunk) => {
          socket.emit(WsEvents.STREAM_CHUNK, { agentId, project: execProject, chunk });
          ws.thinking(agentId);
        });

        socket.emit(WsEvents.STREAM_END, { agentId, project: execProject });
      } catch (err) {
        socket.emit(WsEvents.STREAM_ERROR, { agentId, project: execProject, error: err.message });
      }
    });

    // ── Voice delegation (Realtime API function call relay) ──────────
    socket.on(WsEvents.REQ_VOICE_DELEGATE, async (data) => {
      const { agentId, targetAgentName, task } = data;
      if (!agentId || !targetAgentName || !task) return;
      if (!checkSocketRate()) {
        socket.emit(WsEvents.VOICE_DELEGATE_RESULT, { agentId, targetAgentName, error: 'Rate limit exceeded', result: null });
        return;
      }

      try {
        const targetAgent = agentManager.getAllForUser(userId, userRole, userBoardIds).find(
          a => a.name.toLowerCase() === targetAgentName.toLowerCase()
        );
        if (!targetAgent) {
          socket.emit(WsEvents.VOICE_DELEGATE_RESULT, {
            agentId,
            targetAgentName,
            error: `Agent "${targetAgentName}" not found in swarm`,
            result: null
          });
          return;
        }

        console.log(`🎙️ [Voice Delegate] "${targetAgentName}" ← task: ${task.slice(0, 80)}...`);

        ws.streamStart(targetAgent.id);

        const leader = agentManager.agents.get(agentId);
        const leaderName = leader?.name || 'Voice Leader';

        agentManager.addTask(targetAgent.id, `[From ${leaderName}] ${task}`);

        const response = await agentManager.sendMessage(
          targetAgent.id,
          `[TASK from ${leaderName}]: ${task}`,
          (chunk) => {
            ws.streamChunk(targetAgent.id, chunk);
            ws.thinking(targetAgent.id);
          }
        );

        ws.streamEnd(targetAgent.id);

        socket.emit(WsEvents.VOICE_DELEGATE_RESULT, {
          agentId,
          targetAgentName,
          error: null,
          result: response
        });
      } catch (err) {
        console.error(`🎙️ [Voice Delegate] Error: ${err.message}`);
        socket.emit(WsEvents.VOICE_DELEGATE_RESULT, {
          agentId,
          targetAgentName,
          error: err.message,
          result: null
        });
      }
    });

    // ── Voice ask (lightweight question to another agent) ────────────
    socket.on(WsEvents.REQ_VOICE_ASK, async (data) => {
      const { agentId, targetAgentName, question } = data;
      if (!agentId || !targetAgentName || !question) return;
      if (!checkSocketRate()) {
        socket.emit(WsEvents.VOICE_ASK_RESULT, { agentId, targetAgentName, error: 'Rate limit exceeded', result: null });
        return;
      }

      try {
        const targetAgent = agentManager.getAllForUser(userId, userRole, userBoardIds).find(
          a => a.name.toLowerCase() === targetAgentName.toLowerCase()
        );
        if (!targetAgent) {
          socket.emit(WsEvents.VOICE_ASK_RESULT, { agentId, targetAgentName, error: `Agent "${targetAgentName}" not found in swarm`, result: null });
          return;
        }

        if (targetAgent.status === 'busy') {
          socket.emit(WsEvents.VOICE_ASK_RESULT, { agentId, targetAgentName, error: `Agent "${targetAgentName}" is currently busy`, result: null });
          return;
        }

        console.log(`🎙️ [Voice Ask] "${targetAgentName}" ← question: ${question.slice(0, 80)}`);

        const voiceAgent = agentManager.agents.get(agentId);
        const voiceName = voiceAgent?.name || 'Voice Leader';

        ws.streamStart(targetAgent.id);

        const answer = await agentManager.sendMessage(
          targetAgent.id,
          `[QUESTION from ${voiceName}]: ${question}\n\nPlease provide a concise, direct answer.`,
          (chunk) => {
            ws.streamChunk(targetAgent.id, chunk);
          },
          1,
          { type: 'ask-question', fromAgent: voiceName }
        );

        ws.streamEnd(targetAgent.id);

        socket.emit(WsEvents.VOICE_ASK_RESULT, { agentId, targetAgentName, error: null, result: answer });
      } catch (err) {
        console.error(`🎙️ [Voice Ask] Error: ${err.message}`);
        socket.emit(WsEvents.VOICE_ASK_RESULT, { agentId, targetAgentName, error: err.message, result: null });
      }
    });

    // ── Voice management tools (quick sync operations) ────────────────
    socket.on(WsEvents.REQ_VOICE_MANAGEMENT, async (data) => {
      const { agentId, functionName, args } = data;
      if (!agentId || !functionName) return;
      if (!canAccessAgent(agentId)) {
        socket.emit(WsEvents.VOICE_MANAGEMENT_RESULT, { agentId, functionName, error: 'Access denied', result: null });
        return;
      }

      const voiceAgent = agentManager.agents.get(agentId);
      if (!voiceAgent) {
        socket.emit(WsEvents.VOICE_MANAGEMENT_RESULT, { agentId, functionName, error: 'Voice agent not found', result: null });
        return;
      }

      const userAgents = agentManager.getAllForUser(userId, userRole, userBoardIds);
      const findAgent = (name) => userAgents.find(
        a => a.name.toLowerCase() === (name || '').toLowerCase() && a.id !== agentId && a.enabled !== false
      );

      try {
        let result;

        switch (functionName) {
          case 'assign_project': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            agentManager.update(target.id, { project: args.project_name });
            ws.agentUpdated(target.id);
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
            const enabled = userAgents.filter(a => a.enabled !== false);
            result = enabled.map(a => `${a.name} [${a.status}] (${a.role || 'worker'})${a.project ? ` project=${a.project}` : ''}`).join('\n');
            break;
          }
          case 'agent_status': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            const notDone = agentManager._getAgentTasks(target.id).filter(t => t.status !== 'done').length;
            const total = agentManager._getAgentTasks(target.id).length;
            const msgs = (target.conversationHistory || []).length;
            result = `${target.name}: status=${target.status}, role=${target.role || 'worker'}, project=${target.project || 'none'}, tasks=${notDone} open/${total} total, messages=${msgs}`;
            break;
          }
          case 'get_available_agent': {
            const available = userAgents.find(
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
            const histLen = (target.conversationHistory || []).length;
            const count = Math.min(args.count || 0, histLen);
            if (count === 0) { result = `${target.name} has no messages to rollback`; break; }
            const newLen = histLen - count;
            target.conversationHistory = target.conversationHistory.slice(0, newLen);
            if (newLen === 0) delete target._compactionArmed;
            agentManager.update(target.id, {});
            ws.agentUpdated(target.id);
            result = `Rolled back ${count} message(s) from ${target.name} (${histLen} → ${newLen})`;
            console.log(`🎙️ [Voice] rollback: ${target.name} -${count}`);
            break;
          }
          case 'stop_agent': {
            const target = findAgent(args.agent_name);
            if (!target) { result = `Agent "${args.agent_name}" not found`; break; }
            const stopped = agentManager.stopAgent(target.id);
            result = stopped ? `Stopped agent ${target.name}` : `${target.name} is not currently busy`;
            if (stopped) ws.agentUpdated(target.id);
            console.log(`🎙️ [Voice] stop_agent: ${target.name} → ${stopped ? 'stopped' : 'not busy'}`);
            break;
          }
          case 'clear_all_chats': {
            let count = 0;
            for (const a of userAgents) {
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
            for (const a of userAgents) {
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

        socket.emit(WsEvents.VOICE_MANAGEMENT_RESULT, { agentId, functionName, error: null, result });
      } catch (err) {
        console.error(`🎙️ [Voice Management] ${functionName} error: ${err.message}`);
        socket.emit(WsEvents.VOICE_MANAGEMENT_RESULT, { agentId, functionName, error: err.message, result: null });
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.user?.username}`);
      if (userId) {
        const still = Array.from(io.sockets.sockets.values())
          .some(s => (s as any).user?.userId === userId && s.id !== socket.id);
        if (!still) {
          connectedUserIds.delete(userId);
          updateLastSeen(userId).catch(() => {});
        }
      }
    });
  });
}
