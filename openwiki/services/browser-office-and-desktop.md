---
type: service
title: Browser, office and desktop services
description: The supporting services around the API, namely the public web browser tools, the authenticated browser with session handoff, the office document engine, per-container disk throttling, and the desktop companion that shares a local folder, each with its trust boundary.
tags: [services, browser, office, desktop, security, mcp]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-d78f840d58dab3ef49890217
    resource: repo://api/src/services/browserMcp.ts
  - id: openwiki-source-967fa9c4838d013218b52f17
    resource: repo://api/src/services/flaresolverr.ts
  - id: openwiki-source-e0e0356df4fd599a793ddbac
    resource: repo://api/src/services/localFolderMcp.ts
  - id: openwiki-source-f3e5a459bad5c50b6c24a1da
    resource: repo://desktop/src/bridge.ts
  - id: openwiki-source-699a4b1477cba9c8b51c5167
    resource: repo://desktop/src/fsGuard.ts
  - id: openwiki-source-771f720f3e92953f4d1e266a
    resource: repo://docs/authenticated-browser.md
  - id: openwiki-source-9019618add504a2ad1b7c3a7
    resource: repo://io-limiter/io_limiter.py
  - id: openwiki-source-76c1ea57ad1bd15265b24a0a
    resource: repo://mcp-auth-browser/src/egress.py
  - id: openwiki-source-9c5e73f5c6faea96350a9a75
    resource: repo://mcp-browser/src/server.py
  - id: openwiki-source-3aeffccda80bf49baa3c1e65
    resource: repo://office-engine/README.md
  - id: openwiki-source-ab1f912f9136394f8f738aa7
    resource: repo://office-service/Dockerfile
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Browser, office and desktop services

These components give agents tools beyond code. All treat their input as hostile, since URLs and documents reach them from agent activity.

| Component | Purpose | Boundary to protect |
|---|---|---|
| `mcp-browser` | Search, crawl and extract public web pages | Internal network, through SSRF |
| `mcp-auth-browser` | Browse with a user's shared session | That user's session, and egress |
| `office-engine`, `office-service` | Read, edit, generate and convert documents | Parsers handling untrusted files |
| `desktop/` | Share a local folder with agents | The user's machine |
| `io-limiter` | Throttle runner disk writes | Node performance |

## `mcp-browser`

A FastAPI service using crawl4ai and Playwright, reached by agents through `/api/browser/mcp` and by external services with a `browser` key at 30 calls per minute. FlareSolverr is a fallback for protected pages. Search results come from DuckDuckGo (`ddg_results.py`).

**SSRF is checked twice, deliberately.** `services/browserMcp.ts` checks first for a clear refusal, and `mcp-browser/src/server.py` checks again, since only it sees the redirects crawl4ai follows:

- A hostname is rejected if **any** resolved address is private, as a mixed answer could otherwise connect to the private one. Unparseable addresses count as private.
- CGNAT is added explicitly because Python's `is_private` doesn't cover it.
- A crawl whose **final** URL is private has its content withheld.

## `mcp-auth-browser`

This runs a server-side Chromium that uses a website session explicitly shared by a user. `docs/authenticated-browser.md` has the full user flow.

**It is a one-time handoff, not remote control.** The browser extension in `frontend/browser-session-extension`, which isn't published in a store, copies cookies, including HttpOnly ones, optionally local storage, and the current page URL. After that, navigation happens on the server, and the local browser can close.

Key properties:

- **Pairing:** a request is tied to the user and selected agent or board, and expires after 10 minutes.
- **Controls:** Pause sharing blocks access. Disconnect destroys the remote session.
- **No logging of credentials:** `/api/auth-browser/control` is a special case in the API's error handler, so a parse failure can't log session data.

**Egress is forced through a proxy.** `src/egress.py` is a loopback HTTPS CONNECT proxy used for all of Chromium's requests, including redirects and subresources. It resolves once, validates every answer, and connects to that IP, which defeats DNS rebinding. It allows HTTPS on port 443 only, with no private destinations. It never logs URLs or browser authentication data.

**Deployment requires the post-deploy step.** `docker stack deploy` ignores service `security_opt`, so `devops/configure-auth-browser.py` applies the custom seccomp profile needed for Chromium's non-root sandbox. See [Deployment and operations](../operations/deployment.md#hooks). The service is pinned to `server-b`, to keep interactive credentials off a cross-node hop.

**Cloudflare challenges:** `services/flaresolverr.ts` sends only the **root of the site**, never cookies or paths, because FlareSolverr is unauthenticated on `backend`. Only clearance cookies and its user agent come back.

Because this tool uses real sessions, it can read whatever the shared account can. The plugin provides navigation and reading, with no publishing tools.

## Office

`office-engine` is a Python package that serves 17 tools over Streamable HTTP MCP. Because it's MCP, any configured model can use it through the [Pulsar Gateway](../integration/plugins-and-mcp.md#pulsar-gateway).

It has two homes, with one codebase:

| Home | Files |
|---|---|
| `office-service` (Docker) | Cloud connector files and uploads, under `OFFICE_ROOT` |
| Desktop sidecar, bundled with PyInstaller | The user's local folder; files never leave the machine |

Read, edit and generate use pure libraries: `python-docx`, `openpyxl`, `python-pptx`, `pypdf`, `PyMuPDF` and `markitdown`. Only `convert.py` uses headless LibreOffice.

Paths are confined to `OFFICE_ROOT`, with size caps, in `util.py`.

The image runs as an unprivileged user, UID 10002, because LibreOffice parsing attacker-supplied documents is historically rich in CVEs. An existing `office-data` volume stays root-owned, so migrate it once using the command in `office-service/Dockerfile`.

## `io-limiter`

Swarm has no block IO settings: `docker stack deploy` drops `blkio_config`. A runner doing `npm install` or `cargo build` could therefore starve Postgres and everything else on the node.

This daemon runs once per x86_64 node. Every `IO_LIMITER_INTERVAL` seconds, 15 by default, it finds local containers with the label `io.pulsarteam.io-limit.write-bps=<rate>` and writes a throttle to their cgroup. Cgroup v2 covers buffered writeback, while v1 throttles direct IO only. Setting `RUNNER_IO_WRITE_BPS` controls the runners' value.

It uses the standard library, runs read-only with all capabilities dropped, and needs the host's cgroup and the Docker socket mounted, read-only for the socket.

## Desktop companion

`desktop/` is a Node and native-webview app, not Electron, using WebView2, WKWebView or WebKitGTK. It lets agents work on a local folder **without files leaving the machine**.

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Heuristic: an unescaped angle bracket inside a label breaks rendering; rephrase the label. -->
```text
flowchart LR
  A[Agent] --> L["Local Folder MCP<br/>on the API"]
  L -- "bridge:tool:call over socket" --> B["desktop bridge"]
  B --> F["fsGuard: allow-listed folder"]
  B --> S["Office sidecar"]
  W["Webview"] --> H["Local host 127.0.0.1"]
  H -- "proxies /api, /socket.io" --> API[Platform]
```

The MCP tools have no server-side implementation: each one sends a request over the socket to the user's connected desktop. The API reaches a desktop by resolving the agent to its owner and addressing `desktop:<userId>`, so it has no route to another user's machine.

**`fsGuard.ts` is the trust boundary, and it never trusts the server.** Every path is confined to a user-chosen folder:

- Symlink escapes are defeated by resolving the real path of the deepest existing ancestor.
- Traversal, absolute, and Windows device or UNC paths are rejected.
- Destructive writes go to a `pulsar-output/` subfolder unless overwriting is explicitly requested.
- Reads are capped at 25 MiB.

Every call is recorded in an activity log the user can see, so they know what agents did.

The local host proxies the platform, which is why [CSRF checks don't validate `Origin`](../security/authentication-and-authorization.md#csrf). The bridge reuses the user's JWT for its own socket.

Known limitations: `desktop` has unfixed advisories in the `webview-nodejs` chain, as listed in `SECURITY.md`, and needs `cmake` and a C++ toolchain to install. `docs/desktop-packaging.md` covers packaging.

## Testing

| Component | Command | In CI? |
|---|---|---|
| `mcp-browser`, `mcp-auth-browser`, `office-engine` | `python3 -m pytest -q tests` | No |
| `io-limiter` | `pytest -q` | No |
| `desktop` | `npm test`, including `fsGuard` | Yes |
