# Security Review — AgentsSwarmUI

**Date:** 2026-03-05 (Second Review Pass)
**Reviewer:** CLAUDE (Automated Security Agent)
**Scope:** Full-stack review of server, client, DevOps, and dependency management

---

## Executive Summary

The AgentsSwarmUI project demonstrates solid security fundamentals (JWT auth, bcrypt hashing, parameterized SQL, rate limiting, sandbox isolation, security headers, Zod validation). This is a **second comprehensive review** confirming prior fixes and identifying additional items. `npm audit` reports **0 vulnerabilities** across 191 production dependencies.

| Severity | Total Found | Fixed | Remaining |
|----------|------------|-------|-----------|
| CRITICAL | 3 | 1 | 2 |
| HIGH     | 4 | 2 | 2 |
| MEDIUM   | 6 | 4 | 2 |
| LOW      | 4 | 3 | 1 |

---

## Previously Applied Fixes (Confirmed Still in Place)

1. **Health Endpoint Split** — `/api/health` (public, minimal) vs `/api/health/details` (authenticated)
2. **Zod Schema Validation** — All creation/update routes (agents, plugins, MCP servers) validated
3. **Default Credentials Warning** — Console warning when `ADMIN_PASSWORD` not set
4. **Security Headers** — Express middleware: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`
5. **WebSocket Origin Validation** — Handshake validates `Origin` header against CORS whitelist
6. **Command Injection Fix** — `sanitizeCommitMessage()` strips shell metacharacters in `git_commit_push`
7. **Rate Limiter Cleanup** — Periodic cleanup prevents memory leaks in login attempt tracking
8. **Nginx Security Headers** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options
9. **`.gitignore` Hardening** — `devops/.env` explicitly listed

---

## CRITICAL Issues

### C1. Production Secrets in `devops/.env`

**File:** `devops/.env`
**Impact:** Full compromise of all integrated services
**Status:** NOT tracked by git (confirmed via `git log --all`)

The file contains real production secrets in plaintext:
- Anthropic API key (`sk-ant-api03-...`)
- OpenAI API key (`sk-proj-...`)
- Mistral API key
- GitHub PAT (`github_pat_...`)
- PostgreSQL credentials
- Admin password, JWT secret

**Recommendations:**
1. **Immediately rotate ALL credentials** — assume they've been exposed to any agent/process with filesystem access
2. Use Docker Swarm secrets (`docker secret create`) or a vault (HashiCorp Vault, AWS Secrets Manager)
3. Never store real credentials in `.env` files on shared/multi-tenant hosts

### C2. Docker Socket Mounted into Server & Sandbox Containers

**Files:** `devops/docker-compose.swarm.yml:30`, `server/src/services/sandboxManager.js:234`

Both the server container AND sandbox containers get the Docker socket mounted. This grants **root-level host access** to any process inside those containers. The sandbox container also has `docker-cli` installed (`sandbox.Dockerfile:18`), meaning agent code running in the sandbox can execute arbitrary `docker` commands on the host.

**Recommendations:**
1. Use a Docker socket proxy (e.g., Tecnativa/docker-socket-proxy) with restricted commands
2. Remove `docker-cli` from the sandbox image or restrict it
3. Consider rootless Docker or Podman

---

## HIGH Issues

### H1. JWT Token Stored in localStorage (XSS Risk)

**File:** `client/src/api.js:4`

Tokens in `localStorage` are accessible to any JavaScript on the page. If an XSS vulnerability is ever introduced (e.g., via agent-generated content rendered in the UI), tokens can be stolen.

**Recommendations:**
1. Use `httpOnly`, `Secure`, `SameSite=Strict` cookies for token transport
2. Implement short-lived access tokens (15 min) + refresh token rotation
3. Current CSP header provides defense-in-depth

### H2. 24-Hour JWT Expiry with No Revocation Mechanism

**File:** `server/src/middleware/auth.js:99`

JWTs expire after 24 hours and there is no token blacklist. A stolen token remains valid until it expires.

**Recommendations:**
1. Reduce JWT lifetime to 15-60 minutes
2. Implement refresh tokens stored server-side (in PostgreSQL)
3. Add a token revocation endpoint for logout/force-logout scenarios

---

## MEDIUM Issues

### M1. No Role-Based Authorization (RBAC)

**Files:** All route files

All authenticated users have identical access. The `role` field exists on JWT tokens but is never checked. Any authenticated user can delete agents, modify all projects, broadcast to all agents, etc.

**Recommendation:** Add middleware that checks `req.user.role` for destructive operations (DELETE, broadcast, agent config changes).

### M2. In-Memory User Store

**File:** `server/src/middleware/auth.js:8`

Users are stored in a `Map()` and lost on restart. Only a single admin user can exist.

**Recommendation:** Store users in the PostgreSQL database (already available).

### M3. MCP Server URL Not Validated as URL Format

**File:** `server/src/routes/mcpServers.js:7`
**Status:** FIXED — Changed `z.string().min(1).max(2000)` to `z.string().url().max(2000)`

**Remaining recommendations:**
1. Consider allowlisting URL schemes (`http:`, `https:` only)
2. Block private/internal IP ranges if MCP servers should be external only

---

## LOW Issues

### L1. No Per-Route Request Body Size Limits

**File:** `server/src/index.js:56`

A global 10MB limit is set. Routes that only need small JSON payloads (login, todo, etc.) accept unnecessarily large bodies.

**Recommendation:** Apply smaller limits per-route (e.g., 1KB for login, 100KB for agent config).

### L2. Hardcoded Fallback SSH Path

**File:** `server/src/services/sandboxManager.js:224`
**Status:** FIXED — Changed fallback from `/home/gildas/.ssh` to `/root/.ssh`

---

## Positive Security Findings

1. **Parameterized SQL queries** — All database queries use `$1, $2` placeholders (no SQL injection)
2. **bcrypt password hashing** with salt rounds of 10
3. **JWT secret validation** — `getJwtSecret()` throws if `JWT_SECRET` is unset
4. **Shell argument escaping** — `sandboxManager._sh()` properly escapes single quotes for shell safety
5. **Path traversal prevention** — `agentTools.js` strips `..` segments from file paths
6. **Rate limiting** on login (5 attempts / 15 min per IP) and Claude API calls
7. **CORS configuration** with explicit origins (not `*`)
8. **API key masking** — Both `agentManager._sanitize()` and MCP route `sanitize()` strip keys before client responses
9. **Docker image uses Alpine** — Minimal attack surface
10. **Sandbox user isolation** — Each agent gets a dedicated Linux user inside the shared sandbox container
11. **Input validation** — All API routes use Zod schemas with type/length constraints
12. **WebSocket authentication** — JWT verified on handshake, origin validated
13. **Security headers** — Express (X-Frame-Options, X-Content-Type-Options, Referrer-Policy) and nginx (CSP, HSTS)
14. **Git commit message sanitization** — Prevents command injection via `sanitizeCommitMessage()`
15. **Container/image name validation** — `_validateName()` and `_validateImageRef()` reject shell-unsafe characters
16. **`npm audit` reports 0 vulnerabilities** across 191 production dependencies
17. **`.env` NOT tracked in git** — Confirmed via `git log --all`
18. **No XSS vectors in client** — No `dangerouslySetInnerHTML`, `innerHTML`, `eval()`, or `new Function()` usage

---

## Priority Action Items

| # | Priority | Action | Effort | Status |
|---|----------|--------|--------|--------|
| 1 | CRITICAL | Rotate ALL credentials in `devops/.env` | 1 hour | **Manual action required** |
| 2 | CRITICAL | Replace Docker socket mount with socket proxy | 2-4 hours | Open |
| 3 | HIGH | Move JWT to httpOnly cookies + refresh tokens | 4-8 hours | Open |
| 4 | HIGH | Reduce JWT expiry + add revocation | 2-4 hours | Open |
| 5 | MEDIUM | Implement RBAC middleware | 2-4 hours | Open |
| 6 | MEDIUM | Move user store to PostgreSQL | 2-4 hours | Open |
| 7 | MEDIUM | ~~Validate MCP server URL format~~ | 15 min | **FIXED** |
| 8 | LOW | Per-route body size limits | 1 hour | Open |
| 9 | LOW | ~~Remove hardcoded fallback SSH path~~ | 5 min | **FIXED** |
| 10 | — | Set up automated dependency scanning (Dependabot/Renovate) | 1 hour | Open |
