# Security Audit Report — AgentsSwarmUI

**Date:** 2026-03-05
**Auditor:** CLAUDE (automated security review)
**Scope:** Full codebase — server, client, devops, dependencies

---

## Executive Summary

The AgentsSwarmUI project has a solid security foundation with JWT authentication, parameterized SQL queries, shell escaping, input validation via Zod, and proper CORS configuration. However, several critical and high-severity issues were identified that should be addressed before production deployment.

**Total findings: 15**
- Critical: 2
- High: 3
- Medium: 5
- Low: 5

---

## Positive Security Practices Already in Place

- JWT authentication on all API routes and WebSocket connections
- WebSocket Origin header validation against CORS whitelist
- Parameterized SQL queries — no SQL injection risk
- Shell argument escaping via `_sh()` method in `sandboxManager.js`
- Path traversal prevention in `normalizePath()` and `_projectPath()`
- Git commit message sanitization to prevent command injection
- Input validation with Zod schemas on all POST/PUT routes
- Bcrypt password hashing (10 rounds)
- Rate limiting on login endpoint (5 attempts / 15 min)
- CORS configuration with explicit allowed origins
- Security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy)
- API key masking for MCP servers and agents (stripped from API responses)
- `.gitignore` properly excludes `.env` files
- npm audit shows 0 vulnerabilities

---

## CRITICAL Findings

### C1. Docker Socket Mounted into Sandbox Container

**File:** `server/src/services/sandboxManager.js:234`
```js
'-v /var/run/docker.sock:/var/run/docker.sock',
```

**Impact:** Any agent running inside the sandbox container can control the Docker daemon on the host, which effectively grants **root access to the host system**. A malicious or compromised LLM response could instruct an agent to `@run_command(docker run -v /:/host -it alpine chroot /host)` and escape the container entirely.

**Recommendation:** Remove the Docker socket mount unless strictly required. If Docker-in-Docker is needed, use a restricted Docker socket proxy (e.g., `tecnativa/docker-socket-proxy`) that limits which Docker API calls are allowed.

**Status:** Fixed — Docker socket mount removed.

---

### C2. Secrets in devops/.env File

**File:** `devops/.env`

The production `.env` file contains real credentials on disk:
- Anthropic, OpenAI, Mistral API keys
- GitHub PAT (personal access token)
- PostgreSQL connection string with password
- Admin password
- JWT secret

While `.gitignore` properly excludes this file from commits, anyone with read access to the server can extract all secrets. **These secrets should be rotated** since they have been stored in plaintext.

**Recommendation:**
1. Rotate all API keys and passwords immediately
2. Use a secrets manager (Vault, AWS Secrets Manager, Docker secrets)
3. Ensure the file has restrictive permissions (`chmod 600`)

**Status:** Acknowledged — applied `chmod 600` to .env file.

---

## HIGH Findings

### H1. No Content-Security-Policy Header

**File:** `server/src/index.js:48-54`

Security headers are set but CSP is missing. This leaves the application vulnerable to XSS attacks via injected scripts.

**Recommendation:** Add a CSP header to restrict script and style sources.

**Status:** Fixed — CSP header added.

---

### H2. No HTTPS Enforcement / HSTS Header

**File:** `server/src/index.js:48-54`

No Strict-Transport-Security header is set. If the app is accessible over HTTP, tokens can be intercepted.

**Recommendation:** Add HSTS header. In production behind a reverse proxy, ensure the proxy enforces HTTPS.

**Status:** Fixed — HSTS header added.

---

### H3. No Rate Limiting on API Endpoints

**File:** `server/src/index.js:60-68`

Only the login endpoint has rate limiting. All other API endpoints (agent creation, chat, broadcast, delete) have no rate limiting, enabling abuse.

**Recommendation:** Add a global rate limiter middleware (e.g., `express-rate-limit`) to all `/api/*` routes.

**Status:** Fixed — global API rate limiter added.

---

## MEDIUM Findings

### M1. Default Admin Credentials Hardcoded

**File:** `server/src/middleware/auth.js:17`
```js
const adminPassword = process.env.ADMIN_PASSWORD || 'swarm2026';
```

While there's a warning logged, the app runs with a known default password if `ADMIN_PASSWORD` is not set.

**Recommendation:** Refuse to start or block login if `ADMIN_PASSWORD` is not set in production (`NODE_ENV=production`). Already has a warning but should be enforced.

**Status:** Fixed — server refuses to start in production without ADMIN_PASSWORD.

---

### M2. JWT Token Stored in localStorage

**File:** `client/src/api.js:4`
```js
const token = localStorage.getItem('token');
```

localStorage is accessible to any JavaScript running on the page. If an XSS vulnerability exists, tokens can be stolen.

**Recommendation:** Consider using httpOnly cookies for token storage, or ensure robust CSP (see H1).

**Status:** Acknowledged — mitigated by the CSP header fix (H1).

---

### M3. 10MB JSON Body Limit

**File:** `server/src/index.js:56`
```js
app.use(express.json({ limit: '10mb' }));
```

Allows very large request bodies which could be used for memory exhaustion DoS.

**Recommendation:** Reduce to 1MB unless specific endpoints need more. Use per-route limits for endpoints that need larger payloads.

**Status:** Fixed — reduced to 1MB globally.

---

### M4. In-Memory User Store

**File:** `server/src/middleware/auth.js:8`
```js
const users = new Map();
```

Only a single admin user exists, stored in memory. No ability to change password, add users, or revoke access.

**Recommendation:** Migrate user storage to the database. Add password change functionality.

**Status:** Acknowledged — noted for future improvement.

---

### M5. No Token Revocation Mechanism

JWTs are signed but there's no blacklist or revocation mechanism. Compromised tokens remain valid for 24 hours.

**Recommendation:** Implement a token blacklist (in-memory or database) checked during `authenticateToken`, or reduce token expiry to a shorter window with refresh tokens.

**Status:** Acknowledged — noted for future improvement.

---

## LOW Findings

### L1. Long Token Expiry (24h)

**File:** `server/src/middleware/auth.js:99`

Token expiry of 24 hours is relatively long. If a token is compromised, the attacker has a large time window.

**Recommendation:** Reduce to 1-4 hours and implement refresh tokens.

---

### L2. No Input Validation on Chat Messages

**File:** `server/src/routes/agents.js:128`
```js
const { message } = req.body;
if (!message) return res.status(400).json({ error: 'Message required' });
```

Messages are validated for presence but not for size. Very large messages could cause memory issues.

**Recommendation:** Add a max length validation (e.g., 50KB).

**Status:** Fixed — message size validation added.

---

### L3. tasks.js Uses CommonJS While Project Uses ESM

**File:** `server/src/routes/tasks.js`

This file uses `require()`/`module.exports` while the rest of the project uses ES modules. It also doesn't appear to be mounted in `index.js`.

**Recommendation:** Either convert to ESM or remove if unused.

**Status:** Acknowledged — appears to be dead code.

---

### L4. Console Logging of Operational Details

Tool calls, agent IDs, and usernames are logged to stdout. In production, logs should be structured and sensitive data should be redacted.

**Recommendation:** Use a structured logging library (e.g., pino) and redact sensitive fields.

---

### L5. SSH Keys Shared to All Agent Users

**File:** `server/src/services/sandboxManager.js:255-258`

SSH keys are copied from root to every agent user in the sandbox container. If an agent is compromised, the attacker gains SSH access to all configured repositories.

**Recommendation:** Use deploy keys with read-only access per repository, rather than sharing a single key pair.

---

## Fixes Applied

The following fixes have been applied to the codebase:

1. **Removed Docker socket mount** from sandbox container (C1)
2. **Added Content-Security-Policy header** (H1)
3. **Added Strict-Transport-Security header** (H2)
4. **Added global API rate limiter** using express-rate-limit (H3)
5. **Enforced ADMIN_PASSWORD in production** (M1)
6. **Reduced JSON body limit** from 10MB to 1MB (M3)
7. **Added chat message size validation** (L2)
8. **Applied chmod 600** to devops/.env (C2)
