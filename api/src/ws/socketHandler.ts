import { getBoardsByUser, updateLastSeen, getPool, getTasksByAgent } from '../services/database.js';
import { WsEvents } from './events.js';

const connectedUserIds = new Set<string>();

export function getConnectedUserIds(): Set<string> {
  return connectedUserIds;
}

// ── Desktop bridge registry ──────────────────────────────────────────
// Live bridge sockets per user (the desktop app's 2nd connection). The
// Local Folder MCP connector reaches a user's machine by emitWithAck-ing on one
// of these sockets. Single API node + no socket.io adapter, so a plain in-memory
// Map is correct; a Set per user tolerates multiple desktops / reconnections.
const desktopSockets = new Map<string, Set<any>>();
// Last folder metadata announced by a user's desktop (for the connect widget).
const desktopBridgeInfo = new Map<string, { folders: string[]; registeredAt: number }>();

export function isDesktopConnected(userId: string): boolean {
  const set = desktopSockets.get(userId);
  return !!set && set.size > 0;
}

export function getDesktopSocketsForUser(userId: string): Set<any> | undefined {
  return desktopSockets.get(userId);
}

export function getDesktopBridgeInfo(userId: string): { folders: string[]; registeredAt: number } | null {
  return desktopBridgeInfo.get(userId) || null;
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

    let userBoardIds = new Set<string>();
    if (userId) {
      let boards = await getBoardsByUser(userId);
      // getBoardsByUser swallows query errors and returns []. An empty list
      // caused by a transient DB failure would lock this socket out of every
      // board-scoped agent for its whole lifetime — probe the DB to tell a
      // genuinely board-less user apart from a blip, and retry once.
      if (boards.length === 0 && getPool()) {
        try {
          await getPool().query('SELECT 1');
          boards = await getBoardsByUser(userId);
        } catch {
          console.error(`⚠️ Board lookup failed at connect for user ${userId} — disconnecting socket`);
          socket.emit(WsEvents.ERROR, { message: 'Failed to load boards, please reconnect' });
          socket.disconnect(true);
          return;
        }
      }
      for (const board of boards) {
        socket.join(`board:${board.id}`);
        userBoardIds.add(board.id);
      }
    }

    if (userId) {
      socket.join(`user:${userId}`);
      connectedUserIds.add(userId);
      updateLastSeen(userId).catch(() => {});
    }
    if (userRole === 'admin') socket.join('role:admin');

    // ── Desktop bridge: the local-folder app's 2nd connection ──────────
    // Registered in a separate `desktop:${userId}` room + socket registry so
    // the Local Folder MCP connector can proxy tool calls to the user's machine.
    const isDesktopBridge = (socket as any).handshake?.auth?.role === 'desktop-bridge';
    if (isDesktopBridge && userId) {
      socket.join(`desktop:${userId}`);
      let set = desktopSockets.get(userId);
      if (!set) { set = new Set(); desktopSockets.set(userId, set); }
      set.add(socket);
      console.log(`🖥️ Desktop bridge connected for user ${userId}`);

      socket.on(WsEvents.BRIDGE_REGISTER, (data, ack) => {
        const folders = Array.isArray(data?.folders) ? data.folders.map(String) : [];
        desktopBridgeInfo.set(userId, { folders, registeredAt: Date.now() });
        if (typeof ack === 'function') ack({ ok: true });
        // Notify the user's web UI that the desktop state changed.
        io.to(`user:${userId}`).emit(WsEvents.BRIDGE_FOLDER_CHANGED, { connected: true, folders });
      });
    }

    const ws = agentManager.wsEmitter;

    socket.emit(WsEvents.AGENTS_LIST, agentManager.getAllForUser(userId, userRole, userBoardIds));

    function canAccessAgent(agentId) {
      const agent = agentManager.agents.get(agentId);
      if (!agent) return false;
      if (!agent.boardId) return true;
      return userBoardIds.has(agent.boardId);
    }

    // Shared task-execution streamer: emits STREAM_START → chunks → STREAM_END
    // on THIS socket only, forwarding each chunk and pulsing ws.thinking, and
    // converts a thrown error into STREAM_ERROR. Used by the single- and
    // all-task execute handlers, which differ only in the manager call.
    const streamTaskToSocket = async (
      agentId: string,
      run: (onChunk: (chunk: string) => void) => Promise<any>,
    ): Promise<void> => {
      const project = agentManager.agents.get(agentId)?.project || null;
      try {
        socket.emit(WsEvents.STREAM_START, { agentId, project });
        await run((chunk) => {
          socket.emit(WsEvents.STREAM_CHUNK, { agentId, project, chunk });
          ws.thinking(agentId);
        });
        socket.emit(WsEvents.STREAM_END, { agentId, project });
      } catch (err: any) {
        socket.emit(WsEvents.STREAM_ERROR, { agentId, project, error: err.message });
      }
    };

    // ── Chat with streaming ───────────────────────────────────────────
    // The client passes an ack callback as the last argument. We ALWAYS call
    // it exactly once, so the client knows whether its message was accepted,
    // rejected (and why), or failed mid-flight. Previously rejected messages
    // were silently dropped, which is the root cause of "my message just
    // disappeared" bugs.
    socket.on(WsEvents.REQ_CHAT, async (data, ack) => {
      const safeAck = typeof ack === 'function' ? ack : () => {};
      const { agentId, message, messageId, images } = data || {};

      if (!agentId || !message) {
        safeAck({ status: 'error', code: 'invalid', message: 'agentId and message are required' });
        return;
      }

      if (!canAccessAgent(agentId)) {
        safeAck({ status: 'error', code: 'forbidden', message: 'Access denied: you do not have access to this agent\'s board.' });
        return;
      }
      if (!checkSocketRate()) {
        safeAck({ status: 'error', code: 'rate_limit', message: 'Rate limit exceeded. Please wait before sending more messages.' });
        return;
      }

      if (_trackMessageId(messageId)) {
        // Duplicate (auto-retry from client after disconnect) — tell the
        // client it's already being processed so it stops worrying.
        safeAck({ status: 'duplicate', code: 'duplicate', message: 'Duplicate request ignored (already received).' });
        return;
      }

      if (chatInFlight.has(agentId)) {
        safeAck({ status: 'error', code: 'busy', message: 'This agent is already processing a message. Wait for it to finish or stop it.' });
        return;
      }
      chatInFlight.add(agentId);

      const agentData = agentManager.agents.get(agentId);
      const project = agentData?.project || null;

      // Acknowledge acceptance BEFORE streaming so the client can mark its
      // optimistic UI as "delivered" immediately. Failures after this point
      // are surfaced via STREAM_ERROR.
      safeAck({ status: 'accepted', messageId, agentId, project });

      try {
        let sanitizedImages: any = null;
        if (Array.isArray(images) && images.length > 0) {
          sanitizedImages = images.slice(0, 5).filter((img: any) =>
            img && typeof img.data === 'string' && typeof img.mediaType === 'string' &&
            img.data.length < 10 * 1024 * 1024 &&
            /^image\/(png|jpeg|gif|webp)$/.test(img.mediaType)
          ).map((img: any) => ({ data: img.data, mediaType: img.mediaType }));
          if (sanitizedImages.length === 0) sanitizedImages = null;
        }

        // Stream events flow through agentManager so they are board-scoped
        // (every session that has access to this agent sees them) AND cached
        // (a socket that reconnects mid-stream can resume via STREAM_RESUME).
        agentManager.beginStream(agentId, { userMessage: message, userMessageId: messageId });

        await agentManager.sendMessage(agentId, message, (chunk: string) => {
          agentManager.appendStreamChunk(agentId, chunk);
          ws.thinking(agentId);
        }, 0, null, sanitizedImages);

        agentManager.endStream(agentId);
      } catch (err: any) {
        agentManager.errorStream(agentId, err.message);
      } finally {
        chatInFlight.delete(agentId);
      }
    });

    // ── Resume protocol: a client just (re)connected and wants to know
    //    which agents are currently streaming, so it can pick up the live
    //    response without losing the chunks that flew by while it was
    //    disconnected. Always sends a single STREAM_RESUME event with the
    //    full active-stream list — the client uses that list both to seed
    //    its buffers AND to evict stale ones (the case where the server
    //    crashed mid-stream and never sent STREAM_END).
    socket.on(WsEvents.REQ_STREAM_STATE, () => {
      try {
        const active = agentManager.getActiveStreamsForUser(userId, userRole || null, userBoardIds);
        socket.emit(WsEvents.STREAM_RESUME, {
          streams: active.map((s: any) => ({
            agentId: s.agentId,
            project: s.project,
            buffer: s.buffer,
            startedAt: s.startedAt,
            userMessageId: s.userMessageId,
          })),
        });
      } catch (err: any) {
        console.warn(`⚠️ REQ_STREAM_STATE failed for user ${userId}: ${err.message}`);
      }
    });

    // ── Broadcast to all agents (tmux) ────────────────────────────────
    socket.on(WsEvents.REQ_BROADCAST, async (data) => {
      const { message } = data || {};
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
      const { fromId, toId, context } = data || {};
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
    socket.on(WsEvents.REQ_SWARM_STATUS, async () => {
      socket.emit(WsEvents.REQ_SWARM_STATUS, await agentManager.getSwarmStatus(userId, userRole, userBoardIds));
    });

    // ── Get lightweight status for ALL enabled agents ─────────────────
    socket.on(WsEvents.REQ_STATUSES, async () => {
      socket.emit(WsEvents.REQ_STATUSES, await agentManager.getAllStatuses(userId, userRole, userBoardIds));
    });

    // ── Get single agent detailed status ──────────────────────────────
    socket.on(WsEvents.REQ_AGENT_STATUS, async (data) => {
      const { agentId } = data || {};
      if (!agentId) return;
      if (!canAccessAgent(agentId)) return;
      const status = await agentManager.getAgentStatus(agentId);
      if (status) {
        socket.emit(WsEvents.AGENT_STATUS, status);
      }
    });

    // ── Get agents by project ────────────────────────────────────────
    socket.on(WsEvents.REQ_BY_PROJECT, async (data) => {
      const { project } = data || {};
      if (!project) return;
      socket.emit(WsEvents.REQ_BY_PROJECT, await agentManager.getAgentsByProject(project, userId, userRole, userBoardIds));
    });

    // ── Get project summary ──────────────────────────────────────────
    socket.on(WsEvents.REQ_PROJECT_SUMMARY, () => {
      socket.emit(WsEvents.REQ_PROJECT_SUMMARY, agentManager.getProjectSummary(userId, userRole, userBoardIds));
    });

    // ── Stop agent ────────────────────────────────────────────────────
    socket.on(WsEvents.REQ_STOP, (data) => {
      const { agentId } = data || {};
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
      const { agentId, taskId } = data || {};
      if (!agentId || !taskId) return;
      if (!canAccessAgent(agentId)) return;

      await streamTaskToSocket(agentId, (onChunk) => agentManager.executeTask(agentId, taskId, onChunk));
    });

    // ── Execute all pending tasks ─────────────────────────────────────
    socket.on(WsEvents.REQ_TASK_EXECUTE_ALL, async (data) => {
      const { agentId } = data || {};
      if (!agentId) return;
      if (!canAccessAgent(agentId)) return;

      await streamTaskToSocket(agentId, (onChunk) => agentManager.executeAllTasks(agentId, onChunk));
    });

    // ── Voice delegation (Realtime API function call relay) ──────────
    socket.on(WsEvents.REQ_VOICE_DELEGATE, async (data) => {
      const { agentId, targetAgentName, task } = data || {};
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

        await agentManager.addTask(targetAgent.id, `[From ${leaderName}] ${task}`);

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
      const { agentId, targetAgentName, question } = data || {};
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
      const { agentId, functionName, args: rawArgs } = data || {};
      const args = rawArgs || {};
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

      // Handler table — defined inside the event so each entry closes over
      // agentManager / ws / userAgents / agentId. `needsTarget` entries get a
      // resolved `target` (the dispatcher emits the shared not-found message
      // when findAgent misses, so they can assume target is present).
      const VOICE_FNS: Record<string, { needsTarget?: boolean; run: (ctx: { target?: any; args: any }) => Promise<string> | string }> = {
        assign_project: {
          needsTarget: true,
          run: ({ target, args }) => {
            agentManager.update(target.id, { project: args.project_name });
            ws.agentUpdated(target.id);
            console.log(`🎙️ [Voice] assign_project: ${target.name} → ${args.project_name}`);
            return `Assigned ${target.name} to project "${args.project_name}"`;
          },
        },
        get_project: {
          needsTarget: true,
          run: ({ target }) => target.project ? `${target.name} is assigned to project "${target.project}"` : `${target.name} has no project assigned`,
        },
        list_agents: {
          run: () => {
            const enabled = userAgents.filter(a => a.enabled !== false);
            return enabled.map(a => `${a.name} [${a.status}] (${a.role || 'worker'})${a.project ? ` project=${a.project}` : ''}`).join('\n');
          },
        },
        agent_status: {
          needsTarget: true,
          run: async ({ target }) => {
            const agentTasks = await getTasksByAgent(target.id);
            const notDone = agentTasks.filter(t => t.status !== 'done').length;
            const total = agentTasks.length;
            const msgs = (target.conversationHistory || []).length;
            return `${target.name}: status=${target.status}, role=${target.role || 'worker'}, project=${target.project || 'none'}, tasks=${notDone} open/${total} total, messages=${msgs}`;
          },
        },
        get_available_agent: {
          run: ({ args }) => {
            const available = userAgents.find(
              a => a.id !== agentId && a.enabled !== false && a.status === 'idle' && (a.role || '').toLowerCase() === (args.role || '').toLowerCase()
            );
            return available
              ? `Available ${args.role}: ${available.name} [idle]${available.project ? ` project=${available.project}` : ''}`
              : `No idle agent with role "${args.role}" available`;
          },
        },
        list_projects: {
          run: async () => {
            const projects = await agentManager._listAvailableProjects();
            return projects.length > 0 ? `Available projects: ${projects.join(', ')}` : 'No projects found';
          },
        },
        clear_context: {
          needsTarget: true,
          run: async ({ target }) => {
            await agentManager.clearHistory(target.id);
            console.log(`🎙️ [Voice] clear_context: ${target.name}`);
            return `Cleared conversation history for ${target.name}`;
          },
        },
        rollback: {
          needsTarget: true,
          run: ({ target, args }) => {
            const histLen = (target.conversationHistory || []).length;
            const count = Math.min(args.count || 0, histLen);
            if (count === 0) return `${target.name} has no messages to rollback`;
            const newLen = histLen - count;
            target.conversationHistory = target.conversationHistory.slice(0, newLen);
            if (newLen === 0) delete target._compactionArmed;
            agentManager.update(target.id, {});
            ws.agentUpdated(target.id);
            console.log(`🎙️ [Voice] rollback: ${target.name} -${count}`);
            return `Rolled back ${count} message(s) from ${target.name} (${histLen} → ${newLen})`;
          },
        },
        stop_agent: {
          needsTarget: true,
          run: ({ target }) => {
            const stopped = agentManager.stopAgent(target.id);
            if (stopped) ws.agentUpdated(target.id);
            console.log(`🎙️ [Voice] stop_agent: ${target.name} → ${stopped ? 'stopped' : 'not busy'}`);
            return stopped ? `Stopped agent ${target.name}` : `${target.name} is not currently busy`;
          },
        },
        clear_all_chats: {
          run: async () => {
            let count = 0;
            for (const a of userAgents) {
              if (a.id !== agentId && a.enabled !== false) {
                await agentManager.clearHistory(a.id);
                count++;
              }
            }
            console.log(`🎙️ [Voice] clear_all_chats: ${count} agents`);
            return `Cleared conversation history for ${count} agents`;
          },
        },
        clear_all_action_logs: {
          run: () => {
            let count = 0;
            for (const a of userAgents) {
              if (a.id !== agentId && a.enabled !== false) {
                agentManager.clearActionLogs(a.id);
                count++;
              }
            }
            console.log(`🎙️ [Voice] clear_all_action_logs: ${count} agents`);
            return `Cleared action logs for ${count} agents`;
          },
        },
      };

      try {
        let result;

        const entry = VOICE_FNS[functionName];
        if (!entry) {
          result = `Unknown management function: ${functionName}`;
        } else {
          let target;
          if (entry.needsTarget) {
            target = findAgent(args.agent_name);
          }
          if (entry.needsTarget && !target) {
            result = `Agent "${args.agent_name}" not found`;
          } else {
            result = await entry.run({ target, args });
          }
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
          .some(s => (s as any).user?.userId === userId && (s as any).id !== socket.id);
        if (!still) {
          connectedUserIds.delete(userId);
          updateLastSeen(userId).catch(() => {});
        }
      }
      if (isDesktopBridge && userId) {
        const set = desktopSockets.get(userId);
        if (set) {
          set.delete(socket);
          if (set.size === 0) {
            desktopSockets.delete(userId);
            desktopBridgeInfo.delete(userId);
            io.to(`user:${userId}`).emit(WsEvents.BRIDGE_FOLDER_CHANGED, { connected: false, folders: [] });
          }
        }
      }
    });
  });
}
