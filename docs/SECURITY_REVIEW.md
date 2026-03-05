# Security Review — AgentsSwarmUI

**Date:** 2026-03-05 (Updated)
**Reviewer:** CLAUDE (Autonomous Security Agent)
**Scope:** Full codebase — server, client, DevOps, dependencies

---

## Executive Summary

The AgentsSwarmUI project demonstrates **good security awareness overall**, with many best practices already in place: JWT-based auth, bcrypt password hashing, rate limiting, Zod input validation, parameterized SQL queries, shell argument escaping, path traversal prevention, security headers, WebSocket origin validation, per-socket rate limiting, and API key sanitization.

Several issues were identified, ranging from **CRITICAL** (credential exposure) to **LOW** (hardening recommendations). Some previously identified issues have been resolved since the initial review.

---

## CRITICAL

### 1. Production Secrets in `devops/.env` on Disk
**Location:** `devops/.env`
**Risk:** Total compromise of all integrated services
**Status:** OPEN — requires human action (secret rotation)

The `devops/.env` file contains **real production secrets**:
- `ANTHROPIC_API_KEY` (sk-ant-api03-...)
- `OPENAI_API_KEY` (sk-proj-...)
- `MISTRAL_API_KEY`
- `GITHUB_TOKEN` (github_pat_...)
- `DATABASE_URL` with password
- `JWT_SECRET`
- `ADMIN_PASSWORD`

**While this file is correctly in `.gitignore`** and has never been committed to git history (verified via `git log --all -- devops/.env`), it exists on disk and could be exposed through:
- Backup processes
- Docker volume mounts
- Developer machine compromise
- Accidental `git add -f`

**Recommendation:**
- **Immediately rotate ALL exposed keys** (Anthropic, OpenAI, Mistral, GitHub PAT, JWT secret, admin password, DB password)
- Use a secrets manager (Docker Secrets, Vault, AWS SSM) instead of `.env` files
- Add a pre-commit hook that blocks `devops/.env` from being staged

### 2. Docker Socket Mounted in Production
**Location:** `devops/docker-compose.swarm.yml:31`
```yaml
- /var/run/docker.sock:/var/run/docker.sock
```
**Risk:** Container escape → host root access
**Status:** OPEN — requires architecture change

The Docker socket gives the server container full control over the Docker daemon, meaning any code execution inside the container (including agent-generated code) can:
- Start privileged containers
- Mount the host filesystem
- Execute arbitrary commands as root on the host

Note: The sandbox container itself does NOT mount the Docker socket (comment at `sandboxManager.js:235` confirms deliberate removal). But the server container still needs it to manage sandbox containers.

**Recommendation:**
- Use a restricted Docker proxy like [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) with only `POST /containers/create`, `POST /containers/*/start`, `DELETE /containers/*`, and `GET /containers/*` allowed
- Or use Docker API over TCP with TLS mutual auth

---

## HIGH

### 3. JWT Token Expiry Too Long (24h) with No Refresh Mechanism
**Location:** `server/src/middleware/auth.js:108`
```js
{ expiresIn: '24h' }
```
**Risk:** Extended window for token theft
**Status:** OPEN

A 24-hour JWT with no refresh mechanism means a stolen token is valid for an entire day. There is no token revocation capability.

**Recommendation:**
- Reduce JWT expiry to 1-2 hours
- Implement refresh tokens with rotation
- Add token revocation capability (e.g., maintain a blocklist in Redis/DB)

### 4. No Role-Based Access Control (RBAC)
**Location:** `server/src/middleware/auth.js:133-145`
**Status:** OPEN

The `authenticateToken` middleware verifies the token is valid but never checks `req.user.role`. All authenticated users have full admin access to all endpoints (create/delete agents, broadcast, clear histories, etc.).

**Recommendation:**
- Add role checks: `admin` can manage agents, `viewer` can only read
- Protect destructive endpoints (DELETE, broadcast, clear) with admin-only middleware

---

## MEDIUM

### 5. Client-Side Token Storage in localStorage
**Location:** `client/src/api.js:4`, `client/src/App.jsx:175,194`
```js
const token = localStorage.getItem('token');
localStorage.setItem('token', data.token);
```
**Risk:** XSS → token theft

`localStorage` is accessible to any JavaScript running on the page. If XSS is achieved, the attacker can steal the JWT.

**Mitigating factor:** The strong CSP headers (`default-src 'self'; script-src 'self'`) significantly reduce XSS risk.

**Recommendation:**
- Use `httpOnly` cookies for token storage (prevents JS access)
- Or use `sessionStorage` (clears on tab close, slight improvement)

### 6. SSH Keys Shared Across All Sandbox Agent Users
**Location:** `server/src/services/sandboxManager.js:256-259`

All sandbox agent users get a copy of the root SSH keys. This means any agent can push to any Git repository the SSH key has access to.

**Recommendation:**
- Use deploy keys (read-only) per repository
- Or use per-agent SSH keypairs

### 7. In-Memory Users Store
**Location:** `server/src/middleware/auth.js:8`
```js
const users = new Map();
```
**Risk:** No user management, no password change capability

Users are stored in memory with only a single admin user. No ability to create additional users, change passwords, or audit login history.

**Recommendation:** Move user management to the PostgreSQL database.

### 8. Error Messages May Leak Internal Details
**Location:** Multiple routes (e.g., `agents.js:146`, `plugins.js:49`)
```js
res.status(500).json({ error: err.message });
```
In production, this could reveal internal paths, library details, or stack traces.

**Recommendation:** Return generic error messages in production, log details server-side only.

---

## LOW

### 9. Missing `helmet` Middleware
The security headers are set manually (which is correct and comprehensive: CSP, X-Frame-Options, HSTS, nosniff, XSS-Protection, Referrer-Policy), but using `helmet` would provide additional defaults and stay updated with emerging best practices.

### 10. No Request ID / Audit Trail
There's no request ID middleware for correlating log entries across a request lifecycle. Adding `express-request-id` or similar would improve observability and forensic capabilities.

### 11. `client/dist/` Mounted from Host
**Location:** `docker-compose.swarm.yml:76`
The built client is served from a volume mount of the host's `dist/` folder. Any modification to the host files immediately changes what's served. Consider serving from a built image instead.

---

## Resolved Issues (from initial review)

| Issue | Resolution |
|-------|-----------|
| **WebSocket JWT_SECRET direct access** | Now uses `getJwtSecret()` (confirmed at `index.js:132`) |
| **API keys leaked via WebSocket** | `agentManager._sanitize()` strips `apiKey` before all `_emit()` calls; `getAll()` and `getById()` also return sanitized data |
| **API keys in REST responses** | `agents.js:sanitizeAgent()` masks keys; `mcpServers.js:sanitize()` replaces with `••••••••` |
| **Default password in production** | Server exits with `process.exit(1)` if `ADMIN_PASSWORD` unset in `NODE_ENV=production` |
| **Docker socket in sandbox** | Removed from sandbox container (comment at `sandboxManager.js:234-235`) |

---

## What's Already Done Well

| Area | Implementation | Grade |
|------|---------------|-------|
| **Password Hashing** | bcrypt with cost 10 | Good |
| **JWT Auth** | Proper verify, required JWT_SECRET (throws if unset) | Good |
| **Login Rate Limiting** | 5 attempts/15min per IP, with periodic cleanup | Good |
| **API Rate Limiting** | 100 req/min global + per-socket WS limiter (30/min) | Good |
| **Input Validation** | Zod schemas on all REST routes, UUID regex on WS | Good |
| **SQL Injection** | Parameterized queries ($1, $2) throughout | Excellent |
| **Command Injection** | Shell arg escaping via `_sh()`, commit msg sanitization | Good |
| **Path Traversal** | `..` segment filtering in `normalizePath()` and `_projectPath()` | Good |
| **Security Headers** | CSP, X-Frame-Options DENY, HSTS, nosniff, XSS-Protection, Referrer-Policy | Good |
| **WebSocket Auth** | JWT required + origin validation | Good |
| **WebSocket Rate Limiting** | Per-socket 30 events/min for mutating operations | Good |
| **CORS** | Configurable origins, not wildcard, credentials enabled | Good |
| **Body Size Limit** | 1MB JSON limit | Good |
| **Dependency Audit** | `npm audit` — 0 vulnerabilities | Excellent |
| **API Key Masking** | `_sanitize()` strips keys before all client-facing data | Good |
| **Production Safety** | Exits if ADMIN_PASSWORD missing in production | Good |
| **Sandbox Isolation** | Per-agent Linux users, separate container, no Docker socket in sandbox | Good |
| **LLM Rate Limiting** | Sliding window rate limiter for Claude API (50 req/min default) | Good |

---

## Priority Action Items

| Priority | Action | Effort | Status |
|----------|--------|--------|--------|
| **P0** | Rotate all secrets in `devops/.env` | 1 hour | OPEN |
| **P0** | Replace Docker socket mount with socket proxy | 2 hours | OPEN |
| **P1** | Add RBAC to endpoints | 2 hours | OPEN |
| **P1** | Reduce JWT expiry + add refresh tokens | 2 hours | OPEN |
| **P2** | Use httpOnly cookies instead of localStorage | 2 hours | OPEN |
| **P2** | Sanitize error messages in production | 1 hour | OPEN |
| **P3** | Move users to database | 4 hours | OPEN |
| **P3** | Add audit logging / request IDs | 2 hours | OPEN |
| **P3** | Per-repo deploy keys for sandbox | 2 hours | OPEN |
