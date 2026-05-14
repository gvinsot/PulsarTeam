# API Specifications

This folder documents the HTTP and WebSocket surface of the PulsarTeam API service (`api/`). All endpoints below are mounted on the API host, typically reverse-proxied to `https://<your-host>/api`.

Per-domain endpoint lists:

- [auth.md](auth.md) — login, OAuth, terms, impersonation
- [users.md](users.md) — user management (admin)
- [agents.md](agents.md) — agents, chat, history, per-agent tasks, RAG, handoff
- [tasks.md](tasks.md) — global task router (cross-board)
- [boards.md](boards.md) — boards, workflow, shares, audit
- [projects.md](projects.md) — projects, board linkage, GitHub helpers
- [plugins-and-mcp.md](plugins-and-mcp.md) — plugins, agent skills, MCP servers
- [integrations.md](integrations.md) — GitHub, Gmail, Drive, OneDrive, Outlook, Slack, Jira, WordPress, S3
- [budget-and-llm.md](budget-and-llm.md) — budgets, LLM configs
- [code-index.md](code-index.md) — code-index API & MCP
- [swarm-and-internal.md](swarm-and-internal.md) — external Swarm API, internal token routes
- [misc.md](misc.md) — health, settings, realtime, leader tools, contact

WebSocket events are documented separately in [../websocket-events.md](../websocket-events.md).

---

## 1. Authentication models

The API uses **four** authentication modes:

| Mode | Header | Used by |
|---|---|---|
| JWT Bearer | `Authorization: Bearer <jwt>` | All `/api/*` user routes. JWT is issued by `/api/auth/login` or any of the OAuth callbacks. Payload includes `userId`, `username`, `role`, optional `impersonatedBy`. Validated by `authenticateToken` middleware. |
| API key (user) | `Authorization: Bearer <api_key>` | All `/api/swarm/*` external endpoints. Keys are generated per user via the API-key modal in the UI. Each key is hashed at rest, only the prefix is returned in subsequent reads. |
| Internal coder key | `Authorization: Bearer <CODER_API_KEY>` | `/api/internal/*`. Used by the runner service to read/write Claude OAuth tokens for the user's agents. Configured via a Docker secret. |
| Public | — | `/api/auth/login`, `/api/auth/*/status`, `/api/auth/*/url`, all OAuth `oauth-redirect` handlers, `/api/contact`, `/api/health`. |

Role requirements (`admin`, `advanced`, `basic`) are enforced by `requireRole(...)` middleware on top of `authenticateToken`. Board-level permissions (`read`, `edit`, `admin`) are checked per request against the `board_shares` table.

---

## 2. Common conventions

- **Content type**: `application/json` for both requests and responses unless noted (image uploads accept `multipart/form-data` on chat).
- **Body size limit**: 1 MB on JSON requests (set in `api/src/index.ts`).
- **CORS**: origin allow-list via env (`buildCorsOptions`). WebSocket also enforces the same allow-list against the `Origin` header.
- **Rate limits**:
  - Global limiter: 300 requests / minute / IP across `/api/*`.
  - `/api/auth/login`: 5 attempts / 15 min / IP.
  - `/api/contact`: 5 / hour / IP.
- **Timestamps**: ISO 8601 strings (UTC) unless explicitly noted as epoch ms.
- **IDs**: UUID v4 unless otherwise documented (agent IDs, task IDs, board IDs, project IDs, plugin IDs).
- **Errors**: JSON body `{ error: string, details?: object }` with the appropriate HTTP status. 401 means missing/invalid auth; 403 means authenticated but forbidden; 404 means resource not found or not accessible by the caller; 409 means a conflict (e.g. deleting a task currently being executed).
- **Soft delete**: Tasks support soft delete (`deleted_at` not null). They can be restored or hard-deleted by admins. Most other resources are hard-deleted.

---

## 3. Real-time channel

Socket.IO is mounted on the same HTTP server. Authentication is via `socket.handshake.auth.token` (a JWT). The handshake rejects sockets whose Origin is not on the CORS allow-list.

Each user joins implicit rooms keyed by `userId`. Events scoped to a particular agent are emitted to the room of every authorized viewer.

See [../websocket-events.md](../websocket-events.md) for the full event catalog.

---

## 4. Versioning

There is no `/v1/` prefix today; the API surface evolves additively. Breaking changes are coordinated with the frontend in the same release.
