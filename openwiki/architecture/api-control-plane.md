---
type: architecture
title: API control plane
description: How the Express and Socket.IO server in api/ starts, orders its middleware, mounts routers and enforces a route guard inventory, plus how realtime events are routed to board rooms and how the OpenAPI document is generated from running code.
tags: [api, express, socket-io, middleware, openapi, realtime]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-f246b9390811248963d78e56
    resource: repo://api/src/index.ts
  - id: openwiki-source-74879709ce07476c56447ef5
    resource: repo://api/src/lib/runtimeSecurity.ts
  - id: openwiki-source-bde11cd9619298242a462d02
    resource: repo://api/src/services/__tests__/routeInventory.test.ts
  - id: openwiki-source-2fd89c4007b10f3861796631
    resource: repo://api/src/services/apiDocs.ts
  - id: openwiki-source-ed823a1a7a116335ddb74f40
    resource: repo://api/src/ws/emitter.ts
  - id: openwiki-source-6d56416190da2d0a0b5e77ac
    resource: repo://api/src/ws/socketHandler.ts
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# API control plane

`api/` is the control plane: REST, WebSocket, MCP surfaces and all database access. It is Express 4 with Socket.IO, in TypeScript with ESM, so relative imports must end in `.js` even though files are `.ts`. `api/src/index.ts` is the single wiring file.

**The API is built to run as one node.** The desktop bridge registry notes "single API node + no socket.io adapter", and live agent state, chat locks and streams are held in process memory. Running two replicas of one deployment would split that state. Separate deployments, such as QA and production, can share a database; see [Tasks and workflow engine](../tasks/workflow-engine.md#environments).

## Startup order

`start()` in `index.ts` runs these steps in order. A thrown error exits the process, with one notable exception: if the database stays unreachable after 5 attempts, `initDatabase` logs the failure and returns `false`, and the server **carries on without persistence**.

1. `assertPatchedRuntime()` refuses a Node version without the Brotli fix (CVE-2026-111497).
2. `validateProductionSecrets()` and `validateCorsConfig()` check configuration.
3. `initDatabase()` connects and runs migrations.
4. Seeds the admin user and API key table.
5. Loads and seeds MCP servers, then plugins, using `BUILTIN_MCP_SERVERS` and `BUILTIN_SKILLS`.
6. Loads agents and starts the task loop.
7. Starts listening.
8. **Only then** connects MCP servers, because internal ones such as the code index call the API's own localhost endpoints.

`ExecutionManager` and `AgentManager` depend on each other. The manager is built first with a late-bound `resolveProvider`, so an agent not yet bound still resolves to its real runner, not the sandbox.

## Request pipeline

Order is significant. Middleware runs in this order before the routers:

| Step | Middleware | Purpose |
|---|---|---|
| 1 | `cors` | Allow-list from `CORS_ORIGINS` |
| 2 | `cookieSecurity` | Forces `HttpOnly`, `SameSite`, and `Secure` in production, on every cookie |
| 3 | `securityHeaders` | HSTS, CSP and others. OAuth callback pages set their own CSP with a nonce |
| 4 | `lockEnvironmentFromHost` | Fixes this replica's environment from the first public hostname seen |
| 5 | `rejectBrotliRequestBodies` | Part of the same CVE defence |
| 6 | `express.json` | 1 MB body limit |
| 7 | `apiLimiter` | 300 requests per minute per IP on `/api/` |
| 8 | `csrfProtection` | See [Authentication and authorization](../security/authentication-and-authorization.md) |

Three upgrade handlers share the HTTP server: Socket.IO at `/socket.io/`, the terminal proxy at `/ws/agents/:id/terminal`, and the voice proxy at `/ws/voice/{stt,tts}/:agentId`. Each ignores paths it does not own.

### Router families

| Prefix | Guard | Used by |
|---|---|---|
| `/api/auth`, OAuth redirect routers | Mostly public | Login and OAuth |
| `/api/agents`, `/api/tasks`, `/api/boards` and others | `authenticateToken` | The SPA and bearer clients |
| `/api/users` | `authenticateToken` + `requireRole('admin')` | Admin panel |
| `/api/internal/*` | `authenticateCoderApiKey` | Runner services |
| `/api/insert`, `/api/llm`, `/api/mcp/*` | `requireApiKeyScope(...)` | External API keys |
| `/api/health` | Public | Status and DB probe; returns 503 after 2 consecutive DB failures |

**Check authorization inside handlers too.** `authenticateToken` only proves who the caller is; board and agent access is separate.

### Route guard inventory

`api/src/services/__tests__/routeInventory.test.ts` is the main authorization control in the repository. It boots the real app, walks Express's routing stack, and compares every route with `ROUTE_POLICY`:

- A route with no entry fails the test.
- A route whose guards differ from its entry fails the test.
- An entry for a route that no longer exists fails the test.
- The count of `PUBLIC` routes is pinned by `EXPECTED_PUBLIC_ROUTES`, currently 20.

**To add a route:** add an entry with its guards. A new public route must also bump the count, with a comment explaining why.

The test's header states its limit: it sees only middleware. An `['authenticateToken']` entry means there is no further guard *middleware*, not that there is no authorization. Inline checks such as `checkBoardAccess`, and closures such as `requirePlugin`, are invisible to it.

### Validation and errors

Bodies and queries are validated with zod schemas in `api/src/schemas/` through `lib/validate.ts`, which replaces the value with the parsed result and returns a uniform 400. Wrap async handlers with `lib/asyncHandler.ts`.

The error handler logs with a random `errorId` and returns that ID to the client. Production responses show `Internal server error` without details. `/api/auth-browser/control` is a special case: a JSON parse failure there could contain session credentials in its message, so that request gets a fixed response and nothing is logged.

Outbound requests to user-supplied URLs must use `lib/ssrfGuard.ts`.

## Realtime

Event names are defined in `api/src/ws/events.ts`, and **mirrored by hand in `frontend/src/socketEvents.ts`**. Change both together.

**Connecting.** `io.use` rejects a disallowed `Origin`, then authenticates from `auth.token` or the session cookie. On connection, each socket joins rooms:

| Room | Members |
|---|---|
| `board:<id>` | Sockets of users with access to that board |
| `user:<id>` | All of a user's sockets |
| `role:admin` | Admins |
| `desktop:<id>` | That user's desktop bridge connections |

If a user's boards cannot be loaded, the socket is disconnected rather than left with partial membership. Client requests are handled in `ws/socketHandler.ts`.

**Emitting.** All events should pass through `WsEmitter` (`ws/emitter.ts`). It chooses the task's own board first, then the payload's board, then the board of the referenced agent, and debounces `agent:updated`.

**If no board can be found, the event goes to every connected socket** (`this.io.emit`). This fallback matters for tenant isolation, because an agent or payload without a board is visible to all users. Keep this in mind when adding events. Task payloads are reduced by a projection before being sent.

## OpenAPI document

`services/apiDocs.ts` builds an OpenAPI 3.1 document, served by `routes/apiDocs.ts` and shown in the API keys dialog. It generates anything that could drift:

- Request bodies come from the zod schemas through `z.toJSONSchema`.
- Each MCP surface's tool list is the `tools/list` answer of a real server instance, over an in-memory transport.
- Task response fields come from `TASK_VIEW_KEYS`.

The remaining prose sits next to the mounts it describes. `apiDocs.test.ts` pins it to the route inventory, so **a new public surface needs its prose updated there**.

## Process failure and shutdown

`unhandledRejection` and `uncaughtException` are logged and **the service continues**, as MCP transports can raise them asynchronously. A process in an unexpected state therefore stays up, so do not rely on a crash to reveal these errors: look for them in the logs.

On SIGTERM, shutdown stops the task loop, closes sockets, disconnects MCP servers, destroys execution environments and ends the pool last. A failsafe exits after 8 seconds, ahead of Docker's 10-second kill.

## Where to look

| Change | File |
|---|---|
| Router mounts | `src/index.ts` |
| Routes | `src/routes/<domain>.ts`, plus `src/routes/lib/` |
| Schemas | `src/schemas/<domain>.ts` |
| Events | `src/ws/events.ts` and `frontend/src/socketEvents.ts` |
| Functional behaviour | `specs/api/<domain>.md`, `specs/websocket-events.md` |
