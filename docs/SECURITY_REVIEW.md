# Security Review — AgentsSwarmUI

**Date:** 2026-03-05 (Sixth Review Pass)
**Reviewer:** CLAUDE (Automated Security Agent — Opus 4.6)
**Scope:** Full-stack review of server, client, DevOps, sandbox, and dependency management

---

## Executive Summary

The AgentsSwarmUI project demonstrates solid security fundamentals: JWT authentication, bcrypt hashing, parameterized SQL, rate limiting, sandbox isolation, security headers, Zod input validation, and API key masking. This is a **fifth comprehensive review** confirming all prior fixes, validating the overall security posture, and updating remaining items. Key update: WebSocket per-event rate limiting confirmed in place (30 events/min per socket). Dead code (`tasks.js`) removed. `npm audit` reports **0 vulnerabilities** across 191 production dependencies.

| Severity | Total Found | Fixed | Remaining |
|----------|------------|-------|-----------|
| CRITICAL | 4 | 1 | 3 |
| HIGH     | 6 | 3 | 3 |
| MEDIUM   | 6 | 4 | 2 |
| LOW      | 5 | 4 | 1 |

---

## Previously Applied Fixes (Confirmed Still in Place)

1. **Health Endpoint Split** — `/api/health` (public, minimal) vs `/api/health/details` (authenticated)
2. **Zod Schema Validation** — All creation/update routes (agents, plugins, MCP servers) validated with type/length constraints
3. **Default Credentials Warning** — Console warning when `ADMIN_PASSWORD` not set (`auth.js:19-27`)
4. **Security Headers** — Express middleware: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy` (`index.js:48-54`)
5. **WebSocket Origin Validation** — Handshake validates `Origin` header against CORS whitelist (`index.js:107-112`)
6. **Command Injection Fix** — `sanitizeCommitMessage()` strips shell metacharacters in `git_commit_push` (`agentTools.js:253-261`)
7. **Rate Limiter Cleanup** — Periodic `setInterval` cleanup prevents memory leaks in login attempt tracking (`auth.js:53-58`)
8. **Nginx Security Headers** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options (`nginx.conf:20-24`)
9. **`.gitignore` Hardening** — `devops/.env` explicitly listed, confirmed NOT tracked by git
10. **MCP Server URL Validation** — Changed to `z.string().url().max(2000)` (`mcpServers.js:7`)
11. **SSH Path Fallback Fixed** — Changed from hardcoded user path to `/root/.ssh` (`sandboxManager.js:224`)

---

## CRITICAL Issues

### C1. Production Secrets in `devops/.env`

**File:** `devops/.env`
**Impact:** Full compromise of all integrated services
**Status:** NOT tracked by git (confirmed via `git ls-files` and `git log --all`)

The file contains **real production secrets in plaintext**:
- Anthropic API key (`sk-ant-api03-...`)
- OpenAI API key (`sk-proj-...`)
- Mistral API key
- GitHub PAT (`github_pat_...`)
- PostgreSQL credentials (`postgresql://swarm_prod_app:...`)
- Admin password, JWT secret
- Docker registry URL

**Recommendations:**
1. **Immediately rotate ALL credentials** — assume they've been exposed to any agent/process with filesystem access
2. Use Docker Swarm secrets (`docker secret create`) or a vault (HashiCorp Vault, AWS Secrets Manager)
3. Never store real credentials in `.env` files on shared/multi-tenant hosts
4. The sandbox containers (with `docker-cli` access) can potentially read environment variables from the server container, amplifying the risk

### C2. Docker Socket Mounted into Server & Sandbox Containers

**Files:** `devops/docker-compose.swarm.yml:30`, `server/src/services/sandboxManager.js:234`

Both the server container AND sandbox containers get the Docker socket mounted (`/var/run/docker.sock`). This grants **root-level host access** to any process inside those containers. The sandbox image also installs `docker-cli` and `docker-cli-compose` (`sandbox.Dockerfile:18`), meaning **agent-generated code running in the sandbox can execute arbitrary `docker` commands on the host**.

Attack chain: Agent prompt injection → `@run_command(docker exec server-container env)` → extracts all API keys and secrets.

**Recommendations:**
1. Use a Docker socket proxy (e.g., Tecnativa/docker-socket-proxy) with restricted API endpoints
2. Remove `docker-cli` and `docker-cli-compose` from the sandbox image
3. Consider rootless Docker or Podman for sandbox management
4. If Docker access is needed in sandboxes, use gVisor or Kata containers for stronger isolation

### C3. Sandbox kubectl Access

**File:** `server/sandbox.Dockerfile:43-44`

The sandbox image installs `kubectl`, which could allow agent code to interact with any Kubernetes cluster accessible from the network. Combined with the Docker socket mount and potential network access, this is a privilege escalation risk.

**Recommendation:** Remove `kubectl` from the sandbox image unless explicitly required for specific agent tasks.

### C4. `docker-cli` Installed in Server Dockerfile

**File:** `server/Dockerfile:20`

The **server** Dockerfile installs `docker-cli`, which combined with the Docker socket mount (`docker-compose.swarm.yml:30`) gives the server process direct Docker API access. While needed for sandbox management, it means any code execution vulnerability in the server (e.g., via prompt injection leading to tool execution) could escalate to full host compromise.

**Recommendation:** Consider isolating sandbox management into a separate sidecar service with minimal permissions, rather than giving the main application server Docker access.

---

## HIGH Issues

### H3. SSH Keys Shared Across All Agent Users in Sandbox

**File:** `server/src/services/sandboxManager.js:255-259`

SSH keys from the host are copied to every agent user created in the shared sandbox container. All agents share the same SSH keys, which means any agent can push to any repository the keys have access to. A compromised or misbehaving agent could push malicious code to other projects.

**Recommendation:**
1. Use per-repository deploy keys with minimal permissions (read-only where possible)
2. Implement per-agent SSH key management or Git credential helpers
3. Consider using HTTPS with token-based auth instead of SSH keys

### ~~H4. WebSocket Events Not Rate-Limited~~ — **FIXED**

**File:** `server/src/ws/socketHandler.js:1-13, 20-21`

Per-socket rate limiting is now in place: `createSocketRateLimiter(30, 60_000)` limits each client to 30 mutating events per minute. Applied to `agent:chat`, `broadcast:message`, `agent:handoff`, and `voice:delegate` events.

### H1. JWT Token Stored in localStorage (XSS Risk)

**File:** `client/src/api.js:4`

Tokens in `localStorage` are accessible to any JavaScript on the page. If an XSS vulnerability is ever introduced (e.g., via agent-generated content rendered in the UI), tokens can be stolen.

**Recommendations:**
1. Use `httpOnly`, `Secure`, `SameSite=Strict` cookies for token transport
2. Implement short-lived access tokens (15 min) + refresh token rotation
3. Current CSP header (`nginx.conf:24`) provides defense-in-depth

### H2. 24-Hour JWT Expiry with No Revocation Mechanism

**File:** `server/src/middleware/auth.js:99`

JWTs expire after 24 hours and there is no token blacklist. A stolen token remains valid until it expires. No logout endpoint exists.

**Recommendations:**
1. Reduce JWT lifetime to 15-60 minutes
2. Implement refresh tokens stored server-side (in PostgreSQL)
3. Add a token revocation endpoint (`POST /api/auth/logout`) for logout/force-logout scenarios

---

## MEDIUM Issues

### M1. No Role-Based Authorization (RBAC)

**Files:** All route files

All authenticated users have identical access. The `role` field exists on JWT tokens (`auth.js:97`) but is **never checked** by any route middleware. Any authenticated user can:
- Delete all agents
- Modify all projects
- Broadcast to all agents
- Access all conversation histories
- Create/modify MCP servers

**Recommendation:** Add middleware that checks `req.user.role` for destructive operations (DELETE, broadcast, agent config changes).

### M2. In-Memory User Store

**File:** `server/src/middleware/auth.js:8`

Users are stored in a `Map()` and lost on restart. Only a single admin user can exist. No support for user management (create/update/delete users).

**Recommendation:** Store users in the PostgreSQL database (already available). Add user CRUD endpoints behind admin-only authorization.

---

## LOW Issues

### L1. No Per-Route Request Body Size Limits

**File:** `server/src/index.js:56`

A global 1MB limit is set (`index.js:59`), which is reasonable. However, routes that only need small JSON payloads (login, todo updates) accept unnecessarily large bodies, while routes that may need larger payloads (RAG documents, agent instructions up to 50KB) are adequately served.

**Recommendation:** Consider applying smaller limits per-route for login (e.g., 1KB) and larger limits for RAG document uploads if needed.

### L2. CSP Missing `font-src` Directive

**File:** `client/nginx.conf:24`

The CSP does not include `font-src`. If web fonts are loaded, they may be blocked. The current CSP also uses `'unsafe-inline'` for `style-src`, which weakens XSS protection for styles.

**Recommendation:** Add `font-src 'self'` and consider using nonce-based or hash-based CSP for styles instead of `'unsafe-inline'`.

---

## Positive Security Findings

1. **Parameterized SQL queries** — All database queries use `$1, $2` placeholders; no string interpolation in SQL (no SQL injection risk)
2. **bcrypt password hashing** with salt rounds of 10 (`auth.js:29`)
3. **JWT secret validation** — `getJwtSecret()` throws if `JWT_SECRET` is unset (`auth.js:41-44`)
4. **Shell argument escaping** — `sandboxManager._sh()` properly escapes single quotes for shell safety (`sandboxManager.js:335-337`)
5. **Path traversal prevention** — `agentTools.js:86` strips `..` segments from file paths; `_projectPath()` also filters `..` (`sandboxManager.js:328`)
6. **Rate limiting** on login (5 attempts / 15 min per IP, `auth.js:49-69`) and Claude API calls (`rateLimiter.js`)
7. **CORS configuration** with explicit origins — not `*` (`index.js:25-27`)
8. **API key masking** — `agentManager._sanitize()` strips `apiKey` before client responses (`agentManager.js:3026-3028`); MCP route `sanitize()` masks keys (`mcpServers.js:18-24`)
9. **Docker image uses Alpine** — Minimal attack surface
10. **Sandbox user isolation** — Each agent gets a dedicated Linux user inside the shared sandbox container (`sandboxManager.js:244-259`)
11. **Input validation** — All API routes use Zod schemas with type, length, and format constraints
12. **WebSocket authentication** — JWT verified on handshake, origin validated against CORS whitelist (`index.js:106-126`)
13. **Security headers** — Express (`X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`, `Referrer-Policy`) and nginx (CSP, HSTS)
14. **Git commit message sanitization** — Prevents command injection via `sanitizeCommitMessage()` (`agentTools.js:253-261`)
15. **Container/image name validation** — `_validateName()` and `_validateImageRef()` reject shell-unsafe characters (`sandboxManager.js:339-352`)
16. **`npm audit` reports 0 vulnerabilities** across 191 production dependencies
17. **`.env` NOT tracked in git** — Confirmed via `git ls-files` and `git log --all`
18. **No XSS vectors in client** — No `dangerouslySetInnerHTML`, `innerHTML`, `eval()`, or `new Function()` usage found in source
19. **Sandbox file operations use proper escaping** — `writeFile`, `readFile`, `searchFiles` all use `_sh()` quoting (`sandboxManager.js`)
20. **Agent ID sanitization** — `_username()` strips non-alphanumeric characters for Linux usernames (`sandboxManager.js:317-319`)
21. **Concurrent container start mutex** — `_containerStartLock` prevents race conditions (`sandboxManager.js:213-219`)
22. **Command output truncation** — `toolRunCommand` caps output at 10KB, preventing memory exhaustion from verbose commands (`agentTools.js:208`)
23. **Commit message length limit** — `sanitizeCommitMessage` caps at 500 chars (`agentTools.js:260`)

---

## Priority Action Items

| # | Priority | Action | Effort | Status |
|---|----------|--------|--------|--------|
| 1 | CRITICAL | Rotate ALL credentials in `devops/.env` | 1 hour | **Manual action required** |
| 2 | CRITICAL | Replace Docker socket mount with socket proxy | 2-4 hours | Open |
| 3 | CRITICAL | Remove `docker-cli`, `docker-cli-compose`, `kubectl` from sandbox image | 30 min | Open |
| 4 | CRITICAL | Isolate sandbox management from main server (sidecar) or restrict docker-cli | 4-8 hours | Open |
| 5 | HIGH | Move JWT to httpOnly cookies + refresh tokens | 4-8 hours | Open |
| 6 | HIGH | Reduce JWT expiry + add revocation/logout | 2-4 hours | Open |
| 7 | HIGH | Implement per-agent SSH key isolation | 4-8 hours | Open |
| 8 | HIGH | Add WebSocket per-event rate limiting | 2-4 hours | Open |
| 9 | MEDIUM | Implement RBAC middleware | 2-4 hours | Open |
| 10 | MEDIUM | Move user store to PostgreSQL | 2-4 hours | Open |
| 11 | LOW | Per-route body size limits | 1 hour | Open |
| 12 | LOW | Harden CSP (`font-src`, remove `unsafe-inline`) | 30 min | Open |
| 13 | — | Set up automated dependency scanning (Dependabot/Renovate) | 1 hour | Open |

---

## Previously Fixed (No Action Needed)

| # | Issue | Status |
|---|-------|--------|
| 1 | Health endpoint information disclosure | **FIXED** — split public/authenticated |
| 2 | Missing Zod validation on routes | **FIXED** — all routes validated |
| 3 | MCP server URL not validated as URL format | **FIXED** — `z.string().url()` |
| 4 | Hardcoded SSH fallback path | **FIXED** — uses `/root/.ssh` |
| 5 | Rate limiter memory leak | **FIXED** — periodic cleanup added |
| 6 | Missing nginx security headers | **FIXED** — CSP, HSTS, etc. |
| 7 | Git commit message injection | **FIXED** — `sanitizeCommitMessage()` |
| 8 | Missing WebSocket origin check | **FIXED** — origin validated |

---

## Fixes Applied in This Pass (Sixth)

| # | Issue | Action |
|---|-------|--------|
| 1 | Default credentials in `docker-compose.post.sh` | **Fixed** — removed hardcoded default password from deployment script output |
| 2 | Full re-audit of all routes, middleware, services | **Confirmed** — all prior fixes still in place |
| 3 | Dependency audit | **Confirmed** — `npm audit` reports 0 vulnerabilities |

### Previous Pass Fixes (Fifth)

| # | Issue | Action |
|---|-------|--------|
| 1 | Dead `tasks.js` file (CommonJS, unused, no auth) | **Deleted** |
| 2 | WebSocket rate limiting status | **Updated** — confirmed fixed (30 events/min/socket) |

---

*Sixth review pass performed against codebase as of 2026-03-05. Next review recommended after addressing CRITICAL and HIGH items.*
