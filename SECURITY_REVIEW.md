# Security Review — AgentsSwarmUI

**Date:** 2026-03-05 (Full Independent Audit)
**Reviewer:** CLAUDE (Autonomous Security Agent)
**Scope:** Full codebase — server, client, DevOps, dependencies

---

## Executive Summary

The AgentsSwarmUI project demonstrates **good security awareness overall**, with many best practices already in place: JWT-based auth, bcrypt password hashing, rate limiting (4 layers), Zod input validation, parameterized SQL queries, shell argument escaping, path traversal prevention, security headers, WebSocket origin validation, per-socket rate limiting, API key sanitization, and commit message sanitization.

Several issues remain open, ranging from **CRITICAL** (infrastructure) to **LOW** (hardening). All remaining issues are **architectural** and require design decisions from the team.

---

## CRITICAL

### 1. Docker Socket Mounted in Server Container
**Location:** `devops/docker-compose.swarm.yml:31`
```yaml
- /var/run/docker.sock:/var/run/docker.sock
```
**Risk:** Container escape → host root access
**Status:** OPEN — requires architecture change

The Docker socket gives the server container full control over the Docker daemon. Any code execution vulnerability inside the server container (e.g., via prompt injection leading to `run_command`) could:
- Start privileged containers
- Mount the host filesystem
- Execute arbitrary commands as root on the host

The sandbox container itself does NOT mount the Docker socket (verified at `sandboxManager.js:234-235`), but the server still needs it to manage sandbox containers.

**Recommendation:**
- Use a restricted Docker proxy like [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) with only `POST /containers/create`, `POST /containers/*/start`, `DELETE /containers/*`, `GET /containers/*` allowed
- Or use Docker API over TCP with TLS mutual auth

### 2. docker-cli and kubectl in Sandbox Image
**Location:** `server/sandbox.Dockerfile:18, 43-44`
```dockerfile
docker-cli docker-cli-compose
# ...
RUN curl -LO ".../kubectl" && chmod +x kubectl && mv kubectl /usr/local/bin/
```
**Risk:** Sandbox escape if Docker socket or Kubernetes service account leaks into the container
**Status:** OPEN

Although the sandbox container does NOT currently mount the Docker socket, having `docker-cli` and `kubectl` pre-installed is a significant risk factor. If any misconfiguration ever exposes these APIs, an agent could:
- Escape the sandbox via Docker commands
- Access Kubernetes cluster resources

**Recommendation:**
- Remove `docker-cli`, `docker-cli-compose`, and `kubectl` from `sandbox.Dockerfile`
- If agents genuinely need these tools, run them through a controlled proxy

### 3. Server and Sandbox Share a Flat Docker Network
**Location:** `sandboxManager.js:232` — `--network bridge` (or configurable via env)
**Risk:** Sandbox container can reach the server, database, and other internal services
**Status:** OPEN

The sandbox container runs on the same network as the server. An agent executing `run_command` could:
- Directly access PostgreSQL (`DATABASE_URL`)
- Access the server's HTTP API internally
- Probe other containers on the same Docker network

**Recommendation:**
- Place the sandbox on an isolated network with no access to the server or database
- Only allow outbound internet access (for `git clone`, `npm install`, etc.) through a proxy

---

## HIGH

### 4. JWT Token Expiry Too Long (24h) with No Revocation
**Location:** `server/src/middleware/auth.js:108`
```js
{ expiresIn: '24h' }
```
**Risk:** Extended window for token theft
**Status:** OPEN

A 24-hour JWT with no refresh mechanism means a stolen token is valid for an entire day. There is no token revocation capability (no blocklist).

**Recommendation:**
- Reduce JWT expiry to 1-2 hours
- Implement refresh tokens with rotation
- Add token revocation (e.g., Redis/DB blocklist)

### 5. No Role-Based Access Control (RBAC)
**Location:** `server/src/middleware/auth.js:133-145`
**Status:** OPEN

The `authenticateToken` middleware verifies the token is valid but never checks `req.user.role`. The user object stores `role: 'admin'`, but it's never enforced. All authenticated users have full admin access to all endpoints (create/delete agents, broadcast, clear histories, manage MCP servers, etc.).

**Recommendation:**
- Add role-based middleware: `admin` can manage agents/plugins, `viewer` can only read
- Protect destructive endpoints (DELETE, broadcast, clear) with admin-only checks

### 6. SSH Keys Shared Across All Sandbox Users
**Location:** `server/src/services/sandboxManager.js:256-259`
```js
await this._execAsRoot(
  `mkdir -p ${sshDir} && cp /root/.ssh/* ${sshDir}/ ...`
);
```
**Risk:** Any agent can push to any repository the SSH key has access to
**Status:** OPEN

All sandbox agent users get a copy of the root SSH keys. This means any agent can push to any Git repository the SSH key has access to, regardless of which project it's assigned to.

**Recommendation:**
- Use per-repository deploy keys (read-only preferred)
- Or generate per-agent SSH keypairs

---

## MEDIUM

### 7. Client-Side Token Storage in localStorage
**Location:** `client/src/api.js:4`, `client/src/App.jsx:175,194`
```js
const token = localStorage.getItem('token');
localStorage.setItem('token', data.token);
```
**Risk:** XSS → token theft
**Status:** OPEN

`localStorage` is accessible to any JavaScript running on the page. If XSS is achieved, the attacker can steal the JWT.

**Mitigating factor:** The strong CSP headers (`default-src 'self'; script-src 'self'`) significantly reduce XSS risk.

**Recommendation:**
- Use `httpOnly` cookies for token storage (prevents JS access entirely)

### 8. In-Memory Users Store
**Location:** `server/src/middleware/auth.js:8`
```js
const users = new Map();
```
**Risk:** No user management, no password change capability, no audit trail
**Status:** OPEN

Users are stored in memory with only a single admin user. No ability to create additional users, change passwords, or audit login history.

**Recommendation:** Move user management to the PostgreSQL database.

### 9. Error Messages May Leak Internal Details
**Location:** Multiple routes — `plugins.js:49`, `mcpServers.js:52`, `realtime.js:230`, `agents.js:146`
```js
res.status(500).json({ error: err.message });
```
**Risk:** Information disclosure — internal paths, library versions, stack traces
**Status:** OPEN

In production, `err.message` could reveal database connection strings, file paths, or library internals.

**Recommendation:** Return generic error messages in production, log details server-side only:
```js
res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
```

### 10. WebSocket Events Lack Input Validation
**Location:** `server/src/ws/socketHandler.js` — all event handlers
**Risk:** Malformed data, injection, DoS
**Status:** OPEN (new finding)

REST routes use Zod validation for all inputs, but WebSocket event handlers (`agent:chat`, `broadcast:message`, `agent:handoff`, `voice:delegate`, `voice:management`, etc.) only check for field presence (`if (!agentId || !message) return`) without type/length validation. A malicious client could send:
- Extremely large `message` strings (memory exhaustion)
- Non-string types for `agentId` (type confusion)
- Crafted `functionName` values in `voice:management`

**Recommendation:**
- Apply the same Zod schemas to WebSocket event data
- Add message length limits (matching the 50KB limit on the REST endpoint)
- Validate UUID format for `agentId` parameters

### 11. `voice:management` Allows Any Authenticated User Management Actions
**Location:** `server/src/ws/socketHandler.js:351-478`
**Risk:** Any authenticated user can perform any management action via WebSocket
**Status:** OPEN (new finding)

The `voice:management` handler accepts a `functionName` parameter that dispatches to management operations (`clear_all_chats`, `stop_agent`, `rollback`, etc.) without additional authorization checks. While the user must be authenticated via the WebSocket JWT, there's no RBAC — any user can clear all agent histories or stop agents.

This compounds issue #5 (no RBAC) but through the WebSocket channel.

---

## LOW

### 12. CSP Allows `unsafe-inline` for Styles
**Location:** `server/src/index.js:54`
```js
style-src 'self' 'unsafe-inline'
```
**Risk:** Style-based attacks (CSS injection, data exfiltration via CSS)
**Status:** OPEN

`unsafe-inline` for styles is needed for most CSS-in-JS frameworks, but it weakens CSP.

**Recommendation:** Consider using nonces or hashes for inline styles if feasible.

### 13. No Request ID / Audit Trail
**Location:** Entire server
**Risk:** Poor forensics / observability
**Status:** OPEN

There's no request ID middleware for correlating log entries across a request lifecycle. Adding request IDs would improve incident investigation.

### 14. `client/dist/` Mounted from Host
**Location:** `docker-compose.swarm.yml:76`
```yaml
- ${HOST_CODE_PATH}/AgentsSwarmUI/client/dist:/usr/share/nginx/html
```
**Risk:** Any modification to host files immediately changes what's served
**Status:** OPEN

The built client is served from a volume mount. Any compromise of the host build directory would immediately serve malicious content.

**Recommendation:** Serve from the built Docker image instead (already done in `client/Dockerfile` — just don't override with volume mount).

### 15. Server Dockerfile Includes docker-cli
**Location:** `server/Dockerfile:20`
```dockerfile
docker-cli \
```
**Risk:** Unnecessary attack surface in server container
**Status:** OPEN (new finding)

The server Dockerfile includes `docker-cli`. While the server does need to execute `docker exec/run/rm` commands (via `child_process.exec` in sandboxManager), having `docker-cli` inside the server container means any RCE vulnerability has Docker CLI readily available.

**Recommendation:** This is architecturally needed currently. Switching to the Docker API (HTTP) would eliminate the need for the CLI binary.

---

## Resolved / Well-Implemented

| Area | Implementation | Location | Grade |
|------|---------------|----------|-------|
| **Password Hashing** | bcrypt with cost 10 | `auth.js:38` | Good |
| **JWT Auth** | Proper verify, required JWT_SECRET (throws if unset) | `auth.js:48-54` | Good |
| **Login Rate Limiting** | 5 attempts/15min per IP, with periodic cleanup | `auth.js:57-78` | Good |
| **API Rate Limiting** | 100 req/min global via express-rate-limit | `index.js:62-69` | Good |
| **WebSocket Rate Limiting** | Per-socket 30 events/min for mutating operations | `socketHandler.js:3-13` | Good |
| **LLM Rate Limiting** | Sliding window 50 req/min for Claude API | `rateLimiter.js` | Good |
| **Input Validation** | Zod schemas on all REST routes | `agents.js`, `plugins.js`, `mcpServers.js` | Good |
| **SQL Injection Prevention** | Parameterized queries ($1, $2) throughout | `database.js` | Excellent |
| **Command Injection Prevention** | Shell arg escaping via `_sh()` helper | `sandboxManager.js:336-338` | Good |
| **Commit Message Sanitization** | Strips backticks, $, \, !, newlines, null bytes | `agentTools.js:253-261` | Good |
| **Path Traversal Prevention** | `..` segment filtering in `normalizePath()` & `_projectPath()` | `agentTools.js:78-88`, `sandboxManager.js:327-334` | Good |
| **Security Headers** | CSP, X-Frame-Options DENY, HSTS, nosniff, XSS-Protection, Referrer-Policy | `index.js:49-57` | Good |
| **WebSocket Auth** | JWT required + origin validation | `index.js:119-139` | Good |
| **CORS** | Configurable origins, not wildcard, credentials enabled | `index.js:26-46` | Good |
| **Body Size Limit** | 1MB JSON limit | `index.js:59` | Good |
| **API Key Masking (REST)** | `sanitizeAgent()` masks keys before response | `agents.js:36-43` | Good |
| **API Key Masking (MCP)** | `sanitize()` replaces with `--------` | `mcpServers.js:18-24` | Good |
| **API Key Masking (WS)** | `_sanitize()` strips keys before `_emit()` | `agentManager.js` | Good |
| **Production Safety** | Exits with `process.exit(1)` if `ADMIN_PASSWORD` unset | `auth.js:20-28` | Good |
| **Sandbox Docker Socket** | Deliberately removed from sandbox | `sandboxManager.js:234-235` | Good |
| **Input Validation Names** | Container names, image refs validated with regex | `sandboxManager.js:340-353` | Good |
| **Agent Username Sanitization** | Only `[a-z0-9]`, max 24 chars | `sandboxManager.js:318-321` | Good |
| **.env in .gitignore** | Both `.env` and `devops/.env` excluded, never committed | `.gitignore` | Good |
| **Dependency Audit** | `npm audit` — 0 vulnerabilities (server & client) | Both `package.json` | Excellent |
| **Default Credentials Warning** | Clear console warning in dev, fatal in production | `auth.js:19-36` | Good |
| **Sandbox Exec Timeout** | 5-minute default, configurable per-call | `sandboxManager.js:101` | Good |
| **Output Truncation** | Agent responses capped at 10KB | `agentTools.js:208` | Good |

---

## Priority Action Items

| Priority | Action | Effort | Status |
|----------|--------|--------|--------|
| **P0** | Replace Docker socket mount with socket proxy | 2h | OPEN |
| **P0** | Remove `docker-cli` and `kubectl` from sandbox Dockerfile | 15m | OPEN |
| **P0** | Isolate sandbox network from server/DB | 1h | OPEN |
| **P1** | Add RBAC to REST endpoints + WebSocket handlers | 3h | OPEN |
| **P1** | Add Zod validation to WebSocket event data | 2h | OPEN |
| **P1** | Reduce JWT expiry + add refresh tokens | 2h | OPEN |
| **P2** | Use httpOnly cookies instead of localStorage | 2h | OPEN |
| **P2** | Sanitize error messages in production | 1h | OPEN |
| **P3** | Move users to database | 4h | OPEN |
| **P3** | Add audit logging / request IDs | 2h | OPEN |
| **P3** | Per-repo deploy keys for sandbox | 2h | OPEN |

---

## Methodology

This audit was conducted by reading every source file in the project:
- **Server:** `index.js`, `auth.js`, `database.js`, `sandboxManager.js`, `agentTools.js`, `agentManager.js`, `llmProviders.js`, `rateLimiter.js`, `githubProjects.js`, `mcpManager.js`, `skillManager.js`, `socketHandler.js`
- **Routes:** `agents.js`, `plugins.js`, `mcpServers.js`, `realtime.js`, `leaderTools.js`, `projects.js`, `templates.js`
- **Client:** `api.js`, `App.jsx`, `LoginPage.jsx`, `socket.js`
- **DevOps:** `docker-compose.swarm.yml`, `Dockerfile` (server), `Dockerfile` (client), `sandbox.Dockerfile`, `.env.example`, `.gitignore`
- **Dependencies:** `npm audit` on both `server/` and `client/`
- **Git history:** Verified `.env` was never committed via `git log --all -- devops/.env`
