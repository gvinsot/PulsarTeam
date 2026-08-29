# Security Policy

PulsarTeam runs untrusted model output against real credentials, real
repositories and a real Docker host. Security reports are welcome and taken
seriously.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's private vulnerability reporting:

> https://github.com/gvinsot/PulsarTeam/security/advisories/new

If that is unavailable to you, open a normal issue containing only the words
"security report, please contact me" and no technical detail, and a maintainer
will arrange a private channel.

Please include, as far as you can establish it:

- affected component (`api`, `frontend`, `runner-service`, `mcp-browser`,
  `office-service`, `desktop`) and version or commit,
- what an attacker gains, and the privilege level they need to start from,
- a reproduction — a request sequence, a crafted document, or a prompt,
- deployment shape: this repo's `docker-compose.yml`, the Swarm stack in
  `devops/`, or something else.

Expect an acknowledgement within a few days. There is no bug bounty.

## Supported versions

There is a single supported line: the current `main` branch, and the image tags
built from it. The `v1.0.<n>` tags are per-deploy markers, not maintained
releases — no fixes are backported to earlier ones. Update to the latest `main`
before reporting a bug so you are not chasing something already fixed.

## Scope

In scope: authentication and authorisation flaws, sandbox and agent-isolation
escapes, SSRF and command injection reachable from agent input, secret
disclosure, XSS, dependency vulnerabilities that are actually reachable in this
codebase.

Out of scope: anything requiring the operator's own admin credentials (an admin
is designed to be able to run code — that is the product); findings against a
deployment that ignores the hardening in `docker-compose.yml`; missing headers
on endpoints already behind an authenticated proxy; automated-scanner output
with no demonstrated impact.

## Security model in place

**Secrets.** Read from `/run/secrets/<NAME>` (`api/src/secrets.ts`,
`runner-service/src/secrets.py`), not environment variables, so they stay out of
`/proc/<pid>/environ` and `docker inspect`. Env vars remain a development
fallback only.

**Agent isolation.** Each agent's CLI subprocess runs under its own
deterministic UID in 20000..60000 with a `0700` HOME
(`runner-service/src/agent_user.py`). The runner container therefore starts
privileged — see the "No USER directive" block in `runner-service/Dockerfile`
for why, and do not remove it.

**Container hardening.** Every service in `docker-compose.yml` runs with
`cap_drop: ALL`, a minimal `cap_add`, `no-new-privileges:true`, and tmpfs for
writable paths. As of the image-hardening pass, `api`, `frontend`,
`mcp-browser` and `office-service` also drop to an unprivileged UID _in the
image_, so they stay unprivileged when deployed without this compose file.

**Transport and headers.** HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy` and a CSP are set in `api/src/index.ts`. Every outgoing cookie
is forced to `HttpOnly` + `SameSite` + `Secure`-in-production by
`api/src/middleware/cookieSecurity.ts` — the session cookie sets those flags
itself, so this is the backstop for anything else that ever sets one.

**Sessions.** The login JWT is delivered as an `HttpOnly`, `SameSite=Lax`,
`Secure`-in-production cookie — `__Host-pt_session` in production, `pt_session`
in development — minted in `api/src/middleware/session.ts`. Nothing in the page
can read it, so a script injection can no longer lift the credential and replay
it somewhere else; the SPA holds no credential in `localStorage` or
`sessionStorage` at all. `Authorization: Bearer` remains accepted for
non-browser callers (the internal MCP client, scripts, the desktop bridge),
because an explicit header is not ambient authority.

**CSRF.** A cookie is attached by the browser to requests a third-party page
caused — the one exposure a bearer header never had. Every session therefore
carries a random `csrf` claim *inside* the signed token, handed to the SPA once
in the login and `/api/auth/verify` responses and held in memory only.
`api/src/middleware/csrf.ts` requires it back in `X-CSRF-Token` on every request
that is not `GET`/`HEAD`/`OPTIONS` and authenticates with the cookie. A
cross-origin page can neither read that claim (the cookie is `HttpOnly`, the
response is behind the CORS allow-list) nor set the header without a preflight
the allow-list refuses. Bearer-authenticated and unauthenticated requests are
exempt, and so is a request whose session cookie no longer verifies — a stale
cookie must not lock a user out of logging back in.

**WebSocket handshakes.** A browser cannot put a custom header on a WebSocket
handshake, so `X-CSRF-Token` is unavailable there. Socket.IO
(`api/src/index.ts`) and the terminal WebSocket (`api/src/routes/terminal.ts`)
both authenticate from the same session cookie and validate the handshake
`Origin` against the CORS allow-list instead, with `SameSite=Lax` as the second
layer. The terminal endpoint's `?token=<jwt>` query parameter is gone: it parked
a live credential in URLs, proxy access logs and referrers.

**Untrusted rendering.** The one `dangerouslySetInnerHTML` in the app (the
call-graph diagram) renders Mermaid in `securityLevel: 'strict'` and then passes
the result through the allowlist sanitiser in `frontend/src/lib/sanitizeSvg.ts`.

## Known limitations

These are accepted, understood weaknesses rather than undiscovered bugs. Reports
that restate them without new impact will be closed as known.

- **An XSS could still act as the user.** The `HttpOnly` session cookie removes
  *exfiltration* — a script cannot read the credential and replay it from
  elsewhere — but the browser still attaches the cookie to requests an injected
  script makes from the page, and same-origin script can read the CSRF token out
  of an `/api/auth/verify` response. No cookie design fixes that. The XSS surface
  is therefore still kept deliberately minimal: exactly one raw-HTML sink,
  sanitised twice.
- **Sessions cannot be revoked before they expire.** The session token is a
  stateless 24h JWT. `/api/auth/logout` drops the cookie, and impersonation is
  swapped server-side, but a token captured before either stays valid until its
  `exp`. There is no server-side session store or deny-list, and rotating
  `JWT_SECRET` is the only way to invalidate every live session at once.
- **The `desktop` companion app** has unfixed advisories in the
  `webview-nodejs` → `libwebview-nodejs` → `cmake-js` → `tar` chain. The only
  available fix is a breaking downgrade of `webview-nodejs`. `api` and
  `frontend` are at zero advisories.
- **`runner-service` runs as root** by design (see above). Its containment is
  the capability allowlist, not the container UID. Deploying it without an
  equivalent `cap_drop`/`no-new-privileges` policy is unsafe.
- **An agent with the Basic Tools plugin executes commands** in its workspace.
  That is the feature, not a vulnerability. The boundary that matters is the
  per-agent UID and the container's capability set.
