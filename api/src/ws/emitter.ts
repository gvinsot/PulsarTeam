import { WsEvents } from './events.js';

/**
 * Centralized WebSocket emitter — every real-time event goes through here.
 * Handles board-scoped routing and agent:updated debouncing.
 */
export class WsEmitter {
  private io: any;
  private agents: Map<string, any>;
  private _updateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _updatePending: Map<string, boolean> = new Map();
  private sanitize: (agent: any) => any;

  constructor(io: any, agents: Map<string, any>, sanitize: (agent: any) => any) {
    this.io = io;
    this.agents = agents;
    this.sanitize = sanitize;
  }

  /** Emit an event scoped to the board of the given agent (falls back to broadcast). */
  emit(event: string, data: any) {
    if (!this.io) return;

    if (event === WsEvents.AGENT_UPDATED && data?.id) {
      this._debouncedUpdate(event, data);
      return;
    }

    if ((event === WsEvents.AGENT_CREATED || event === WsEvents.AGENT_DELETED) && data?.boardId) {
      this.io.to(`board:${data.boardId}`).emit(event, data);
      return;
    }

    this._emitScoped(event, data);
  }

  /** Emit scoped to the most authoritative board we can derive, or broadcast.
   *
   * Priority: the task's OWN board (data.task.boardId) → a board on the payload
   * (data.boardId) → the board of the agent referenced by the payload
   * (data.id/data.agentId). For task:updated the payload is { agentId, task }
   * where agentId is the task OWNER — routing by the owner agent's board sent
   * the event to the wrong room whenever the owner is on a different board than
   * the task (or has no board), e.g. a batch where the agent that picked the
   * task up is not the board's primary agent. The task carries its own board,
   * so route by that first. */
  private _emitScoped(event: string, data: any) {
    const agentId = data?.id || data?.agentId;
    const agentBoardId = agentId ? this.agents.get(agentId)?.boardId : undefined;
    const boardId = data?.task?.boardId || data?.boardId || agentBoardId;
    if (boardId) {
      this.io.to(`board:${boardId}`).emit(event, data);
      return;
    }
    this.io.emit(event, data);
  }

  /** Debounce agent:updated to avoid flooding clients during rapid state changes. */
  private _debouncedUpdate(event: string, data: any) {
    const agentId = data.id;
    this._updatePending.set(agentId, true);
    if (this._updateTimers.has(agentId)) return;

    const timer = setTimeout(() => {
      this._updateTimers.delete(agentId);
      const wasPending = this._updatePending.has(agentId);
      this._updatePending.delete(agentId);
      if (wasPending) {
        const agent = this.agents.get(agentId);
        if (agent) {
          this._emitScoped(event, this.sanitize(agent));
        }
      }
    }, 300);
    this._updateTimers.set(agentId, timer);
  }

  /** Flush any pending debounced update for an agent immediately. */
  flush(agentId: string) {
    const timer = this._updateTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this._updateTimers.delete(agentId);
    }
    const wasPending = this._updatePending.has(agentId);
    this._updatePending.delete(agentId);
    if (wasPending && this.io) {
      const agent = this.agents.get(agentId);
      if (agent) {
        this._emitScoped(WsEvents.AGENT_UPDATED, this.sanitize(agent));
      }
    }
  }

  // ── Convenience methods for the most common emit patterns ────────────

  /** Emit stream lifecycle events for an agent. */
  streamStart(agentId: string, extra?: Record<string, any>) {
    const agent = this.agents.get(agentId);
    this.emit(WsEvents.STREAM_START, {
      agentId,
      agentName: agent?.name,
      project: agent?.project || null,
      ...extra,
    });
  }

  streamChunk(agentId: string, chunk: string, extra?: Record<string, any>) {
    const agent = this.agents.get(agentId);
    this.emit(WsEvents.STREAM_CHUNK, {
      agentId,
      agentName: agent?.name,
      project: agent?.project || null,
      chunk,
      ...extra,
    });
  }

  streamEnd(agentId: string, extra?: Record<string, any>) {
    const agent = this.agents.get(agentId);
    this.emit(WsEvents.STREAM_END, {
      agentId,
      agentName: agent?.name,
      project: agent?.project || null,
      ...extra,
    });
  }

  streamError(agentId: string, error: string, extra?: Record<string, any>) {
    const agent = this.agents.get(agentId);
    this.emit(WsEvents.STREAM_ERROR, {
      agentId,
      agentName: agent?.name,
      project: agent?.project || null,
      error,
      ...extra,
    });
  }

  /** Emit agent thinking state. */
  thinking(agentId: string) {
    const agent = this.agents.get(agentId);
    this.emit(WsEvents.AGENT_THINKING, {
      agentId,
      agentName: agent?.name,
      project: agent?.project || null,
      thinking: agent?.currentThinking || '',
    });
  }

  /** Emit agent:updated with fresh sanitized data. */
  agentUpdated(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent) {
      this.emit(WsEvents.AGENT_UPDATED, this.sanitize(agent));
    }
  }
}
