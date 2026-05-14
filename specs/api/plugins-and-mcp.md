# Plugins, Agent skills, MCP servers

Sources: `api/src/routes/plugins.ts`, `agentSkills.ts`, `mcpServers.ts`. All routes require JWT.

The product distinguishes three closely-related concepts:
- **Plugin** (a.k.a. "Skill") — a reusable bundle of instructions plus MCP server bindings. Attached to agents to extend their behavior.
- **Agent skill** — a snippet of system-level instructions injected globally for agents that opt in.
- **MCP server** — a JSON-RPC endpoint exposing tools to agents.

---

## 1. Plugins — `/api/plugins/*`

Backward-compat alias: `/api/skills/*`.

### GET `/api/plugins`
List all plugins (API keys masked).

### GET `/api/plugins/:id`
Single plugin.

### POST `/api/plugins`
- **Auth**: `admin`.
- **Body**: `{ name, description?, category?, icon?, instructions, userConfigFields?: [...], mcpServerIds?: string[] }`.

### PUT `/api/plugins/:id`
- **Auth**: `admin`, except: a non-admin caller may update **only their per-agent user-config** for plugins they have attached.
- Preserves API keys that come back masked from the client.

### DELETE `/api/plugins/:id`
- **Auth**: `admin`.

### POST `/api/plugins/:id/mcps/:mcpId`
Bind an MCP server to the plugin. Admin only.

### DELETE `/api/plugins/:id/mcps/:mcpId`
Unbind. Admin only.

---

## 2. Agent skills — `/api/agent-skills/*`

### GET `/api/agent-skills`
List all skills.

### GET `/api/agent-skills/search`
- **Query**: `q` (required).

### GET `/api/agent-skills/:id`
Single skill.

### POST `/api/agent-skills`
- **Auth**: `advanced` or `admin`.
- **Body**: `{ name, prompt, ... }`.

### PUT `/api/agent-skills/:id`
- **Auth**: `advanced` or `admin`.

### DELETE `/api/agent-skills/:id`
- **Auth**: `advanced` or `admin`.

---

## 3. MCP servers — `/api/mcp-servers/*`

### GET `/api/mcp-servers`
List all MCP servers, with each one's connection status and tool inventory. API keys are masked.

### GET `/api/mcp-servers/:id`
Single MCP server (masked).

### POST `/api/mcp-servers`
- **Auth**: `admin`.
- **Body**: `{ name, url, authMode, env?, ... }`.

### PUT `/api/mcp-servers/:id`
- **Auth**: `admin`. Preserves masked API keys.

### DELETE `/api/mcp-servers/:id`
- **Auth**: `admin`.

### POST `/api/mcp-servers/:id/connect`
Force reconnect and refresh the tool list.
- **Auth**: `admin`.

### POST `/api/mcp-servers/:id/test`
Test connectivity. Optional body `{ apiKey }` runs the test with a per-agent override key.
- **Auth**: any JWT (so users can validate their own keys before saving them in a plugin).
