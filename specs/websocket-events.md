# WebSocket events

Source of truth: `frontend/src/socketEvents.ts` (mirrored from `api/src/ws/events.ts`).

The Socket.IO connection uses JWT auth on the handshake (`socket.handshake.auth.token`). Origin is validated against the same CORS allow-list as HTTP.

Events are split into:
- **Server → client** (push updates and stream chunks)
- **Client → server** (request events that mostly mirror an HTTP endpoint)

---

## 1. Server → client

### Agent lifecycle
| Event | Payload | Effect |
|---|---|---|
| `agents:list` | `Agent[]` | Initial dump on socket join. |
| `agent:created` | `Agent` | A new agent is now visible to this user. |
| `agent:updated` | `Agent` | One agent's fields changed. |
| `agent:deleted` | `{ id }` | Remove the agent from the list. |
| `agent:status` | `{ id, status }` | Light status change (idle/busy/error). |
| `agent:stopped` | `{ id }` | Emitted after an explicit stop request resolved. |

### Streaming
| Event | Payload | Effect |
|---|---|---|
| `agent:stream:start` | `{ agentId }` | A new assistant turn is starting; clients reset the streaming buffer. |
| `agent:stream:chunk` | `{ agentId, chunk }` | A piece of the streamed reply. |
| `agent:stream:end` | `{ agentId }` | End of the turn. Clients move the buffer into `conversationHistory` (via the next `agent:updated`). |
| `agent:stream:error` | `{ agentId, error }` | Streaming failed; clients show a toast. |

### Agent activity
| Event | Payload | Effect |
|---|---|---|
| `agent:thinking` | `{ agentId, thinking }` | Show/clear a thinking indicator on the agent card. |
| `agent:handoff` | `{ from, to, taskId?, context }` | A task was handed off between agents. |
| `agent:handoff:complete` | `{ ... }` | Sent after handoff machinery finishes. |
| `agent:handoff:error` | `{ ... }` | Handoff failed. |
| `agent:ask` | `{ agentId, question }` | The agent is asking the user a question. |
| `agent:error:report` | `{ agentName, description, isSystemError }` | Agent reported an error; clients display a toast (12 s). |

### Tasks
| Event | Payload | Effect |
|---|---|---|
| `task:updated` | `Task` | Insert or update card in the Kanban view. |
| `task:deleted` | `{ id }` | Remove card. |

### Broadcast
| Event | Payload | Effect |
|---|---|---|
| `broadcast:start` | `{ broadcastId, agentIds }` | Live feed listeners append a section per agent. |
| `broadcast:complete` | `{ broadcastId, agentId, response }` | One agent finished its broadcast reply. |
| `broadcast:error` | `{ broadcastId, agentId, error }` | One agent failed. |

### Voice
| Event | Payload | Notes |
|---|---|---|
| `voice:delegate:result` | `{ requestId, result }` | Result of a delegation initiated from voice. |
| `voice:ask:result` | `{ requestId, result }` | Result of an "ask" tool call. |
| `voice:management:result` | `{ requestId, result }` | Result of a management tool call (e.g. add task). |

### Errors
| Event | Payload | Notes |
|---|---|---|
| `error` | `{ message }` | Generic transport-level error from the server. |

---

## 2. Client → server

These events are accepted by the server-side socket handlers. Most have an equivalent HTTP endpoint and are convenience aliases for clients that already hold a socket.

| Event | Payload | Notes |
|---|---|---|
| `agent:chat` | `{ agentId, message, images? }` | Send a chat message (equiv. to `POST /api/agents/:id/chat`). |
| `broadcast:message` | `{ message, agentIds? }` | Broadcast (equiv. to `POST /api/agents/broadcast/all`). |
| `agent:handoff` | `{ agentId, targetAgentId, context, taskId? }` | Handoff. |
| `agents:refresh` | `{}` | Force a re-emission of `agents:list`. |
| `agents:swarm-status` | `{}` → swarm-status emitted back |
| `agents:statuses` | `{ project? }` → status list |
| `agent:status` | `{ id }` → that agent's status |
| `agents:by-project` | `{ project }` |
| `agents:project-summary` | `{}` |
| `agent:stop` | `{ agentId }` | Cancel in-flight execution. |
| `agent:task:execute` | `{ agentId, taskId }` | Force-execute one task. |
| `agent:task:executeAll` | `{ agentId }` | Process the agent's queue immediately. |
| `voice:delegate` | `{ targetAgentId, message }` | Voice-initiated delegation. |
| `voice:ask` | `{ agentId, question }` | Voice-initiated ask. |
| `voice:management` | `{ action, params }` | Voice-initiated swarm management (e.g. add task). |
