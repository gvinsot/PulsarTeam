---
type: security
title: Authentication and authorization
description: The credentials the API accepts, including session cookies with CSRF claims, scoped API keys, internal service keys and tokens, plus the board-based access rules for multi-tenant data, the checks that are easy to omit, and SSRF protection.
tags: [security, authentication, authorization, csrf, api-keys, multi-tenant]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-6828cc50875858895127fef3
    resource: repo://api/src/lib/agentAccess.ts
  - id: openwiki-source-e7711e3a3275ccefc2e4d4db
    resource: repo://api/src/lib/ssrfGuard.ts
  - id: openwiki-source-718a1b04812722f9a50956d6
    resource: repo://api/src/middleware/apiKeyAuth.ts
  - id: openwiki-source-04fd08ccc91dab29fe59233c
    resource: repo://api/src/middleware/auth.ts
  - id: openwiki-source-ee56b2d45afc85e638cfa746
    resource: repo://api/src/middleware/authz.ts
  - id: openwiki-source-a3e767cec5a0a60941086356
    resource: repo://api/src/middleware/coderApiKeyAuth.ts
  - id: openwiki-source-f3d87edadc66e938652ab3af
    resource: repo://api/src/middleware/csrf.ts
  - id: openwiki-source-002206b3237fe52a964a6fd4
    resource: repo://api/src/middleware/session.ts
  - id: openwiki-source-60bc682462b115f00d75ac6a
    resource: repo://api/src/services/apiKeyManager.ts
  - id: openwiki-source-fb4b7ee7e0adec9c82cd802b
    resource: repo://api/src/services/userApproval.ts
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Authentication and authorization

PulsarTeam is multi-tenant and publicly routed, and agents hold their owners' OAuth tokens. The repo records that its most frequent bug has been a handler that didn't check tenant access, so this is the first thing to review in any change involving an ID from a request.

## Credentials

| Credential | Used by | Guard | Identity |
|---|---|---|---|
| Session cookie | Browsers | `authenticateToken`, plus CSRF | User, 24-hour JWT |
| `Authorization: Bearer <jwt>` | Desktop bridge, scripts, internal MCP client | `authenticateToken` | User or internal service |
| Scoped API key | External integrations | `requireApiKeyScope(scope)` | The key's owner, re-read per request |
| `CODER_API_KEY` | Runners on `/api/internal/*` | `authenticateCoderApiKey` | Service, no tenant |
| OAuth login | Google, Microsoft, GitHub | `routes/authLogin.ts` | User, after admin approval |

## Sessions

`middleware/session.ts` owns minting and verifying tokens. Use it rather than calling `jwt.sign` directly, so the CSRF claim can't be forgotten.

- **Cookie:** `HttpOnly`, `SameSite=Lax`, `Secure` in production. It is named `__Host-pt_session` in production, a prefix that prevents setting it from a sibling subdomain, and `pt_session` in development.
- **No credential in the page:** an XSS can't steal the session. It could still act as the user from within the page, which `SECURITY.md` accepts as a limitation.
- **No revocation:** tokens are stateless JWTs. Logging out drops the cookie, but a captured token stays valid until it expires. Rotating `JWT_SECRET` is the only way to invalidate every live session.

Passwords use bcrypt, cost 12. New OAuth accounts start `pending` and receive no session or board until an admin approves them (`services/userApproval.ts`). Admins can impersonate approved users, and the session records `impersonatedBy`.

`cookieSecurity` is a backstop that forces safe flags on every outgoing cookie.

### CSRF

A cookie is sent automatically, including on requests a third-party page causes. So each session has a random `csrf` claim **inside the signed token**. The client gets it in the login or `/auth/verify` response, holds it in memory, and returns it in `X-CSRF-Token`. A double-submit cookie was avoided because a sibling subdomain could set it.

`csrfProtection` requires the header unless:

- The method is `GET`, `HEAD` or `OPTIONS`.
- The request uses a Bearer token, which a browser never attaches by itself.
- There is no valid session cookie, so a stale cookie can't block a new login.
- It is a login or OAuth callback path, which replaces the session rather than using it. A transient error can land a user on the login page without the in-memory token.

Origin is deliberately not checked on HTTP, because the desktop app serves the SPA from `127.0.0.1` and proxies `/api`. **WebSocket handshakes do check `Origin`**, as they can't carry the header: Socket.IO in `index.ts`, the terminal in `routes/terminal.ts` and voice in `routes/voiceProxy.ts`.

## Roles and resource access

Roles are `basic`, `advanced` and `admin`, enforced through `requireRole(...)`, which names its guard so that the route inventory can see it. **A role is not sufficient for tenant data.**

### Boards

`checkBoardAccess` in `middleware/authz.ts` is the rule:

| Caller | Access |
|---|---|
| Board owner | `admin` |
| System admin | `admin` |
| Share in `board_shares` | The share's level: `read`, `edit` or `admin` |
| Anyone else | 403 |

### Agents

`lib/agentAccess.ts` is the single decision point for every surface taking a caller-supplied agent ID. **Acting as an agent is a privilege**, since an agent holds its owner's tokens and a bridge to their machine.

1. An agent on a board: board access decides.
2. An agent with no board but an owner: only that owner.
3. An agent with neither: admins only. This happens when an owner is deleted, as `owner_id` becomes NULL.

Listings go through `getAllForUser`, and prompts through `lib/agentScope.ts`, so they stay within the same bounds.

### What to check in a new handler

If a handler takes a board, project, task or agent ID:

1. Check access with `authz.ts` or `lib/*Access.ts`.
2. Choose the level deliberately. Acting as an agent or running it is `edit`, not `read`.
3. Add the route to `ROUTE_POLICY`. An `['authenticateToken']` entry doesn't mean authorization happened, because [the inventory only sees middleware](../architecture/api-control-plane.md#route-guard-inventory).
4. Add a test using `helpers/routeHarness.ts`.

## API keys

`services/apiKeyManager.ts` and `middleware/apiKeyAuth.ts`. **Every key names an owner and a scope, and there is no instance-wide key.** See [Plugins and MCP](../integration/plugins-and-mcp.md#key-scoped-surfaces-for-external-clients) for what each scope opens.

- **Claims aren't stored in the key.** The owner's row is re-read per request, so a demotion or deletion restricts all keys at once.
- **Storage:** an HMAC-SHA256 of the key with a server secret, `API_KEY_SECRET`, or one derived from `JWT_SECRET` with HKDF if unset. A database dump alone can't validate a key. Rotating `JWT_SECRET` without a separate `API_KEY_SECRET` therefore also affects API keys.
- **Fail closed:** a row that isn't cleanly scoped resolves to nothing.
- **Insert keys:** the owner's edit access to the board is rechecked per request, and may be limited to allowed columns.

## Internal service credentials

`CODER_API_KEY` is shared among all runners and the API, and carries no tenant, so the routes behind it trust their callers. In Swarm, the edge also blocks `/api/internal/*`. Agents can't read it, as described in [Agent isolation and secrets](agent-isolation.md).

The API also mints internal JWTs for its own MCP client (`resolveInternalMcpConfig`), marked `internal: true` with an admin role. Those issued for a runner carry `mcpAgentId` and `mcpBoardId`, and the MCP entry point requires an exact match with the request's headers.

`lib/agentAccess.ts` notes that internal sessions are still trusted on other API surfaces, and that this binding is specific to the MCP boundary.

## SSRF

The API shares a network with other services, and URLs can come from agent input, meaning whatever the agent just read. `lib/ssrfGuard.ts` rejects URLs pointing inside the perimeter.

It **doesn't follow redirects**, so a caller must revalidate each hop with `redirect: 'manual'`, or hand the URL to a fetcher that guards its own hops. `assertAdminServiceUrl` allows private addresses, for admin-configured endpoints only, and never for task input. Remote MCP has its own stricter fetcher, `remoteMcpFetch.ts`.

## Rate limits

`/api/` has a limit of 300 requests per minute per IP. `browser` and `llm` keys have their own per-key limits.

## Reporting

Report suspected vulnerabilities through GitHub's private reporting, as `SECURITY.md` explains, not in public issues.
