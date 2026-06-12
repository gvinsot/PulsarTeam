# Swarm API & internal routes

Sources: `api/src/routes/swarmApi.ts`, `internalClaudeTokens.ts`, plus the inline MCP handlers in `api/src/index.ts`.

---

## 1. External Swarm API — `/api/swarm/*`

Authenticated with a **user API key** (Bearer token). The key is created from the UI's API-key modal and stored hashed. The Swarm API is intended for programmatic integration with external automations (CI, schedulers, other LLM agents).

### GET `/api/swarm/agents`
List the user's agents.
- **Query**: `project?`, `status?` (idle|busy|error).
- **Response 200**: `{ count, agents: [...] }`.

### GET `/api/swarm/agents/:id`
Agent detail (resolves by ID or by `name`). Includes tasks and metrics.

### GET `/api/swarm/boards`
List the user's boards.
- **Response 200**: `{ count, boards: [...] }`.

### POST `/api/swarm/agents/:id/tasks`
Queue a new task on an agent. The board is auto-resolved if there is exactly one; otherwise it must be provided.
- **Body**: `{ task, project?, status?, board_id?, repo_full_name?, storage_path?, ... }`.
- **Response 200**: `{ success, task, agent, board_id }`.

### MCP transports

| Endpoint | Description |
|---|---|
| `ALL /api/swarm/mcp` | JSON-RPC over HTTP — the canonical transport. |

---

## 2. Internal routes — `/api/internal/*`

These are server-to-server routes used by the runner service. They are protected by the shared `CODER_API_KEY` Bearer secret, **not** a user JWT.

### GET `/api/internal/claude-tokens/:ownerId`
Return the Claude OAuth token for a given user (so the runner can call Anthropic on the user's behalf).

### POST `/api/internal/claude-tokens/:ownerId`
Store a refreshed token.
- **Body**: `{ accessToken, refreshToken, expiresIn? | expiresAt? }`.

### DELETE `/api/internal/claude-tokens/:ownerId`
Revoke the stored token.

---

## 3. Internal MCP endpoints (JWT-protected)

Mounted directly in `api/src/index.ts`. Each `ALL /api/<name>/mcp` exposes a JSON-RPC handler for an MCP server that the API runs in-process.

| Path | Purpose |
|---|---|
| `/api/code-index/mcp` | Local code-index symbol/semantic search. |
| `/api/gandi-dns/mcp` | Gandi DNS management. |
| `/api/auto-learn/mcp` | Auto-learning utility (records facts agents discover). |
| `/api/browser/mcp` | Headless browser tools. |
| `/api/swarm-api/mcp` | The Swarm API MCP, internal-bound — used by agents to delegate to other agents. |
| `/api/gmail/mcp`, `/api/outlook/mcp` | Email; runs in-process and can read agent-side attachment files via the runner bridge. |
| `/api/gdrive/mcp`, `/api/onedrive/mcp` | Cloud storage. |
| `/api/github/mcp`, `/api/slack/mcp`, `/api/jira/mcp`, `/api/wordpress/mcp`, `/api/s3/mcp` | Per-integration MCPs. |
