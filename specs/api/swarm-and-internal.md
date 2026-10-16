# Swarm API & internal routes

Sources: `internalClaudeTokens.ts`, plus the inline MCP handlers in `api/src/index.ts`.

---

## 1. External Swarm API — removed

The external `/api/swarm/*` REST routes and the `/api/swarm/mcp` transport were opened only by the ownerless instance-wide ("legacy") API key. That key has been removed for good (migration `202610160001_remove_legacy_api_keys`), and the surface with it. External integrations use a personal scoped key instead — see [mcp-surfaces.md](mcp-surfaces.md).

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
| `/api/pulsar-gateway/mcp` | The Pulsar Gateway MCP — the **single** MCP injected into CLI runner agents. Exposes task control via one unified `update_task` tool (move the auto-detected current task between columns and/or mark it finished with a summary + commits) plus `list_mcps` / `call_mcp_tool`, through which the agent dynamically discovers and invokes every other MCP available to it or its board (agent plugins ∪ board plugins ∪ direct agent MCPs ∪ Swarm API). Replaces the old per-plugin static MCP wiring at spawn. |
| `/api/gmail/mcp`, `/api/outlook/mcp` | Email; runs in-process and can read agent-side attachment files via the runner bridge. |
| `/api/gdrive/mcp`, `/api/onedrive/mcp` | Cloud storage. |
| `/api/github/mcp`, `/api/slack/mcp`, `/api/jira/mcp`, `/api/wordpress/mcp`, `/api/s3/mcp` | Per-integration MCPs. |
