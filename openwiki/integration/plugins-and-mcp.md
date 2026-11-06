---
type: architecture
title: Plugins and MCP
description: How plugins bundle instructions and MCP servers, how agents reach tools directly or through the Pulsar Gateway, how remote MCP connections are imported and protected, and how key-scoped MCP surfaces expose the platform to external clients.
tags: [mcp, plugins, integrations, gateway, api-keys]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-f246b9390811248963d78e56
    resource: repo://api/src/index.ts
  - id: openwiki-source-7f1678a542ad7a7ff9c3c124
    resource: repo://api/src/routes/internalRunnerMcp.ts
  - id: openwiki-source-0a1f154159b702138b1d127f
    resource: repo://api/src/services/mcp/actorScope.ts
  - id: openwiki-source-aa8678d059c6403a218c12eb
    resource: repo://api/src/services/mcpHttpHandler.ts
  - id: openwiki-source-5c1fb8a5a8ac96250d5cfe3f
    resource: repo://api/src/services/pulsarGatewayMcp.ts
  - id: openwiki-source-3890497164821bbb2f734558
    resource: repo://api/src/services/remoteMcpFetch.ts
  - id: openwiki-source-b06dd3520205f45e811872a0
    resource: repo://api/src/services/skillManager.ts
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Plugins and MCP

MCP is how agents get tools and how external clients drive the platform. There are three directions to keep separate:

| Direction | What | Where |
|---|---|---|
| Agent to built-in tools | Gmail, GitHub, Code Index and others, served by the API itself | `/api/<name>/mcp`, session or internal JWT |
| Agent to remote servers | Third-party HTTPS MCP servers | Plugins, `remote_mcp_connections` |
| External client to platform | Task and agent control with a personal key | `/api/mcp/*` |

## Plugins

A plugin, called a `Skill` in the code (`services/skillManager.ts`), is a named bundle of **instructions and MCP servers**. Agents and boards each attach plugins, and an agent gets both sets. Plugin instructions go into the prompt, and MCP servers become available tools.

Built-in definitions are in `api/src/data/skills.ts` and `data/mcpServers.ts` and are seeded at startup, so changing a definition there changes every deployment's built-ins. Built-ins include Basic Tools, Delegation, Code Index, the Google and Microsoft integrations, Slack, Jira, GitHub, AWS S3, Azure CLI, the two browsers, and PulsarCD read and action tools.

The plugin name `Skill` predates the current product term, so expect both words in code.

## How an agent reaches tools

Native agents and CLI runners take different routes to the same audited call path, `mcpManager.callToolByNameForAgent`.

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Heuristic: an unescaped angle bracket inside a label breaks rendering; rephrase the label. -->
```text
flowchart LR
  N["Native sandbox agent"] -- "mcp_call tool" --> M[MCPManager]
  C["CLI in runner"] -- "one MCP config entry" --> G["Pulsar Gateway<br/>/api/pulsar-gateway/mcp"]
  G -- "call_mcp_tool" --> M
  M --> B["Built-in MCP handlers"]
  M --> R["Remote MCP servers"]
```

### Pulsar Gateway

**CLI runners get exactly one MCP server: the gateway.** `services/pulsarGatewayMcp.ts` exposes a small fixed tool set:

| Tool | Purpose |
|---|---|
| `update_task` | Move the current task between columns or finish it, with a summary and commits. Always available |
| `list_mcps` | List servers available right now, including tool schemas |
| `call_mcp_tool` | Call a tool on one of them |
| `submit_answer` | Submit an answer for an LLM API request |

Plugins can be attached at any time, so a fixed tool list frozen when the CLI spawned would go stale. The gateway also means that credentials for other servers stay on the API rather than being written into runner configuration. The runner fetches its wiring from `/api/internal/runner-mcp`.

### Built-in MCP handlers

They are mounted in `index.ts` as `app.all(path, authenticateToken, handler)`, using `createMcpHttpHandler` from `services/mcpHttpHandler.ts`.

**Agent context is client-supplied.** It arrives in the `X-Agent-Id` and `X-Board-Id` headers, and it selects whose OAuth tokens are used and whose desktop bridge is reached. So the handler checks both at `edit` level before they reach the server. A runner's service token is also tied to its own agent and board by `internalMcpContextMatches`. Requests with neither header are treated as global.

**Authentication is per server, not per mount.** A request that passes `authenticateToken` has proved who the caller is. Any further role or tenant restriction must be implemented by the server's own tools, so check this when adding a tool that touches shared data.

### Credential resolution

Native integrations resolve tokens in the order **agent, then board, then error**. An earlier fallback that picked the first available user token was removed. Sharing a plugin definition does not share access. OAuth tokens are stored as described in [Persistence and migrations](../data/persistence-and-migrations.md#oauth-tokens).

## Remote MCP servers

The plugin UI can browse the official registry at `registry.modelcontextprotocol.io`, with a 5-minute cache, and import a server. See `docs/remote-mcp.md`, which is in French.

- **Scope:** public HTTPS Streamable HTTP endpoints only, concrete URLs without `{tenant}` parameters, with at most one required header.
- **Authentication:** OAuth with PKCE, and dynamic registration where supported, or an API key with a configurable header.
- **Secrets:** encrypted in `remote_mcp_connections` and `remote_mcp_oauth_flows`. They go through the gateway and are not stored in plugins or injected into CLI configurations.
- **SSRF protection:** `remoteMcpFetch.ts` blocks private, loopback, link-local and metadata ranges, **including at effective DNS resolution**, and refuses redirects. Registry data and OAuth metadata are treated as untrusted.
- **OAuth flows** expire after 10 minutes and are consumed atomically. The callback rechecks the user's rights.
- **Disconnecting** deletes local secrets but doesn't revoke consent at the provider. Users must do that themselves.

## Key-scoped surfaces for external clients

Keys are minted by a user and name their owner: **there is no instance-wide key**. See `specs/api/mcp-surfaces.md` for the full contract.

| Scope | Accepted on | Reach |
|---|---|---|
| `admin` | `/api/mcp/admin`, `/api/mcp/management` | Owner's rights, administrative tools |
| `management` | `/api/mcp/management` | Owner's rights: tasks, boards, agents |
| `insert` | `/api/insert/*`, `/api/mcp/insert` | Task creation on **one board**, and nothing else |
| `browser` | `/api/mcp/browser` | Web tools, with its own rate limit |
| `llm` | `/api/llm/v1/*` | LLM API; see [LLM providers, budgets and usage](../llm/providers-and-usage.md) |

Rules these surfaces follow:

- **The owner is re-read on each request**, so demoting or deleting a user restricts their keys immediately.
- **Same rules as REST.** `mcp/actorScope.ts` implements no access logic. It calls the same `checkBoardAccess`, `checkProjectAccess` and `checkAgentAccess` as the REST routes, so an MCP tool and its REST twin can't drift apart.
- **No enumeration.** A resource outside the caller's scope gets the same "not found" as one that doesn't exist. A 403 would let any key holder discover other tenants' IDs.
- **Insert keys never read the board from the request.** The guard re-proves each time that the owner can still edit the board the key was minted for.
- **Rotation:** minting a ladder scope you already hold invalidates the old key at once.

Key handling is in `services/apiKeyManager.ts` and `middleware/apiKeyAuth.ts`. See [Authentication and authorization](../security/authentication-and-authorization.md).

## Adding a built-in MCP server

1. Write `services/<name>Mcp.ts` with `createMcpHttpHandler`, and mount it in `mcpMounts` in `index.ts`.
2. Add it to `data/mcpServers.ts` and, if it should be attachable, a plugin in `data/skills.ts`.
3. Add its routes to `ROUTE_POLICY`.
4. Decide what each tool does about role and tenant, since the mount only authenticates.
5. Route any outbound request to a user-supplied URL through `lib/ssrfGuard.ts`.

For a new key-scoped surface, also update the prose in `services/apiDocs.ts`.
