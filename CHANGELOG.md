# Changelog

Notable changes to PulsarTeam. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**On versions:** the `v1.0.<n>` git tags are per-deploy markers written by the
release script — there are over 1100 of them and they do not correspond to
releases. This file records changes worth knowing about, not tags. Entries are
added under `[Unreleased]` as work lands.

## [Unreleased]

### Security

- The login JWT no longer reaches browser JavaScript. It travels in an
  `HttpOnly` session cookie (`__Host-pt_session` in production, `pt_session` in
  development; `SameSite=Lax`, `Secure` in production, 24 h) instead of being
  returned in the login response and kept in `localStorage`, where any
  successful XSS was a session exfiltration. The credential can no longer be
  lifted off the page and replayed elsewhere — an XSS can still act as the user
  from inside the page, so this narrows the blast radius rather than closing it.
- CSRF protection to go with it. Every session token carries a random `csrf`
  claim, handed to the client once in the login / `/api/auth/verify` response
  and held in memory only; `csrfProtection`, mounted globally on `/api`,
  requires a matching `X-CSRF-Token` header on every method other than
  GET/HEAD/OPTIONS. `Authorization: Bearer` requests are exempt — a browser
  never attaches one by itself — so the internal MCP client, the API scripts
  and the test suite are unaffected.
- New `POST /api/auth/logout` (clears the cookie) and
  `POST /api/auth/stop-impersonation`, which re-mints the admin's own session
  from an `impersonatorId` claim after re-checking the account is still an
  admin. The frontend used to end an impersonation by keeping the admin's JWT
  in `localStorage` under `originalToken`; nothing in the page can read a
  cookie, so the way back now lives server-side.
- The terminal WebSocket (`/ws/agents/:id/terminal`) no longer accepts
  `?token=<jwt>`. A JWT in a query string ends up in proxy logs, browser
  history and referrers; the upgrade now authenticates with the session cookie
  or a bearer header, and validates `Origin` against the CORS allow-list the
  way the Socket.IO handshake already did. Socket.IO in turn falls back to the
  cookie when `handshake.auth.token` is absent, which is the browser's path
  now — `auth.token` stays for the desktop bridge.
- The API's cookie-hardening middleware (`HttpOnly` + `SameSite=Lax` +
  `Secure`-in-production on every `Set-Cookie`) is now actually mounted. It had
  been written and unit-tested but never wired into `index.ts`, so it protected
  nothing at runtime.
- The call-graph diagram — the application's only `dangerouslySetInnerHTML` —
  no longer renders untrusted Mermaid with `securityLevel: 'loose'`. Mermaid now
  runs in `strict` mode (its own DOMPurify pass, HTML labels off, click
  directives disabled) and the resulting SVG goes through a new allowlist
  sanitiser, `frontend/src/lib/sanitizeSvg.ts`, before it reaches the DOM. The
  diagram source is derived from repository contents and optionally rewritten by
  an LLM, so it was never trustworthy input.
- Resolved every dependency advisory in the `api` and `frontend` production
  trees — 8 high severity, including `ws` (uninitialized memory disclosure, and
  memory-exhaustion DoS from tiny fragments) on a service whose WebSocket is the
  core feature. Also `socket.io-parser`, `ip-address` via `express-rate-limit`,
  `path-to-regexp`, `qs` via `express`, `uuid`, `hono`, and `react-router`.
  `npm audit --omit=dev` now reports zero for both.
- `api`, `frontend`, `mcp-browser` and `office-service` images now run as
  unprivileged users. Hardening previously existed only at the compose layer, so
  the images were root anywhere else they were deployed.
- `api`'s production image no longer ships `gcc`, `g++`, `make`, `musl-dev`,
  `python3`, `docker-cli`, `shadow` or `util-linux`. The compiler toolchain moved
  to a build stage; the rest was never used — the API imports no
  `child_process` anywhere.
- `runner-service` keeps running as root, now with an explicit block in its
  Dockerfile explaining that its isolation is per-agent UIDs (which require
  `CAP_CHOWN`/`CAP_SETUID`/`CAP_SETGID` in the parent) and that adding `USER`
  would collapse every agent onto one shared UID.
- The SPA shell now carries a `Content-Security-Policy`. Only the API's
  responses had one before, so the page that actually runs the application's
  JavaScript had none. It is set by the frontend's nginx
  (`frontend/nginx-security-headers.conf`), not by Traefik, because the API's
  OAuth result pages need their own per-request nonce policy. Scripts are
  same-origin only (plus `blob:` for the voice AudioWorklets), with no inline
  script and no `eval`.
- The page no longer loads anything from a third-party origin, so nothing
  external is left without Subresource Integrity. Inter and JetBrains Mono are
  bundled through `@fontsource-variable/*`, since a Google Fonts stylesheet is
  generated per user agent and can never be pinned by hash. The Umami tracker is
  a vendored copy (`frontend/public/vendor/umami.js`) that still reports to
  `stats.methodinfo.fr` through `data-host-url`.
- nginx serves the SPA shell only for the paths the app handles (`/`, `/terms`,
  `/privacy`, `/auth/{google,microsoft,github}/callback`). Any other path that
  is not a file now answers 404 instead of 200 with `index.html`.
- Fixed `'\U0001f50c'` in the MCP plugin route, which is not a JavaScript escape
  and rendered as the literal text `U0001f50c` instead of an icon.

### Added

- A **Mark all seen** button in the board toolbar, shown while the active board
  has unseen MCP/API tasks. `POST /api/boards/:id/tasks/viewed-all` acknowledges
  them all in one atomic statement — filters do not narrow it — so the unseen
  badge next to the board name clears without opening every card. Same guards as
  the per-task acknowledgement: browser cookie session plus read access.
- ESLint 10 + typescript-eslint and Prettier in `api` and `frontend` — the repo
  previously had no linter or formatter of any kind. `npm run lint`,
  `npm run lint:fix`, `npm run format`, `npm run format:check`, plus
  `npm run typecheck` in `api`.
- `@typescript-eslint/no-explicit-any` runs as a warning with `--max-warnings`
  pinned to the current count, so `any` can only decrease. `react-hooks` rules
  in the frontend.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and this file.
- `.git-blame-ignore-revs`, recording the repo-wide Prettier pass so `git blame`
  skips it. Enable locally with
  `git config blame.ignoreRevsFile .git-blame-ignore-revs`; GitHub reads it
  automatically.

### Changed

- Prettier applied repo-wide (324 files). Reformatting displaced two
  `eslint-disable-next-line react-hooks/exhaustive-deps` directives in
  `ExternalVoiceChatTab.tsx` onto the wrong line, voiding the suppressions —
  they are re-attached, and one of the two turned out to have been broken
  already. The frontend `any` ceiling therefore drops 139 -> 137 with the `any`
  count itself unchanged.
- Both `tsconfig.json` files enable `strictFunctionTypes`, `strictBindCallApply`,
  `noImplicitThis`, `alwaysStrict`, `noFallthroughCasesInSwitch` and
  `noImplicitReturns`, and document every remaining strict flag with its
  measured error count as an explicit ratchet. 68 Express handlers and 12
  `useEffect` callbacks were rewritten to satisfy `noImplicitReturns`; no
  behaviour changes (Express ignores a handler's return value, and the effects
  now `return undefined` on their early path).
- **Deploy-affecting:** the `frontend` container listens on **8080** instead of
  80, because a non-root nginx cannot bind a privileged port and
  `no-new-privileges:true` neutralises the usual `setcap` workaround.
  `docker-compose.yml` now maps `80:8080`, and the Traefik service-port label in
  `devops/docker-compose.swarm.yml` targets 8080.
- **Deploy-affecting:** the `api` process runs as uid 10001, so `/run/secrets/*`
  must be readable by that uid. Docker's default secret mode (0444) already is.
- **Deploy-affecting:** `office-service` runs as uid 10002 and needs `/data` to
  be owned by it. A new `office-data` volume inherits this from the image; an
  existing one needs a one-time
  `docker run --rm -v office-data:/data alpine chown -R 10002:10002 /data`.

### Fixed

- Agents no longer need GitHub reconnecting several times a day. A GitHub user
  token was treated as an eternal, per-scope credential, and both halves of that
  are wrong for a GitHub App: the token expires after 8 h, and authorizing again
  as the same account **revokes the token minted by the previous
  authorization**. With one copy stored per agent/board, connecting agent N
  silently killed agents 1..N-1 — production logs showed five agents being
  re-authorized in rotation all day, each fix breaking the previous one. The
  callback now keeps the `refresh_token` and expiry and renews the token in the
  background, and the connections of one GitHub account share a single live
  token: one connect covers every agent, and a token rejected mid-flight is
  recovered (refreshed, or replaced by the account's live token from another
  scope) before anyone is asked to reconnect. Connections belonging to a
  different GitHub account are never touched.
