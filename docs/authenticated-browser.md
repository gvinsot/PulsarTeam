# Authenticated Browser

The built-in **Authenticated Browser** plugin exposes `/api/auth-browser/mcp` in
PulsarTeam. A private `mcp-auth-browser` worker runs Chromium with Playwright on the
cluster. It uses a website session explicitly shared from the user's own browser.

The extension performs a **one-time handoff**, not remote control of a local tab:
local sign-in → cookies, optional local storage and current page URL → PulsarTeam
API → isolated server Chromium. Every subsequent MCP navigation, read and scroll
uses that server session. It never sends navigation commands to the extension.

The separate LinkedIn plugin is retired. Use Authenticated Browser with the exact
website origin, such as `https://www.linkedin.com/` or
`https://www.legifrance.gouv.fr/`. The plugin provides general page navigation and
reading; it does not reproduce specialized API tools or provide publishing tools.
Existing Authenticated Browser assignments keep the same `skill-auth-browser` and
`mcp-auth-browser` identifiers. Retired built-in LinkedIn definitions are removed
from the database by the existing startup cleanup after deployment. An old
LinkedIn session is not automatically moved to another plugin; reconnect explicitly.

## Connect and share a session

1. Add **Authenticated Browser** to an agent or board. Open PulsarTeam over HTTPS
   in Chrome or Edge, outside private browsing.
2. Install **PulsarTeam — Authenticated Browser**. Download the ZIP from the plugin
   and extract it. Open `chrome://extensions` or `edge://extensions`, enable
   **Developer mode**, click **Load unpacked**, and select the extracted folder.
   The source lives in `frontend/browser-session-extension`; `npm run dev` and
   `npm run build` generate the archive. This extension is not published in a store.
3. Enter the exact HTTPS website origin and click **Connect in my browser**. The
   request is tied to your user and the selected agent or board, and expires after
   ten minutes. No cluster browser is started yet.
4. Open the extension from that PulsarTeam tab. Check the source website and
   destination server, then click **Open website**. Grant access to those origins
   and to the website's parent domains used for cookies. A dedicated tab opens in
   the same browser profile; no permanent access to all websites is granted.
5. Sign in normally in that tab, including SSO or MFA if needed. Return to the
   selected website origin, check the signed-in account and open the page to share.
6. Open the extension from the website tab and click **Transfer session**. Website
   cookies, including HttpOnly cookies, and the current page URL are copied to the
   cluster. The server opens that page, not the website's login landing page. Include local
   storage only if the website needs it. Keep the original PulsarTeam tab and
   connection panel open: the page imports the session through its authenticated
   API client and normal CSRF protection.
7. The server checks for readable rendered content before confirming the transfer.
   After success, both local tabs and the local browser may be closed. Agents can
   now browse the website on the cluster. **Pause sharing** blocks their
   access; **Resume sharing** restores it. **Disconnect** destroys the remote
   copy. To change accounts or renew an expired session, disconnect and reconnect.

The rendering check rejects detected login pages and empty application shells;
it does not independently verify the account identity on every website. Only its
creator can import or resume it; authorized editors can revoke it. Users who can
run the board's agents can access the shared account through those agents.
Disconnecting here neither signs out your local browser nor revokes provider access.

## Update or troubleshoot the extension

Version **1.0.3** transfers the current signed-in page URL and is required by the
new import endpoint. Older extensions are rejected with an update instruction.
Labels and explanations are in English. It includes the transfer
fix from 1.0.1: parent-domain and host cookies with the same name and path are
merged only when every imported field is identical. Conflicting cookies are still
rejected; use a dedicated browser profile if needed.

Replace the installed extension's files with the new ZIP contents, then click
**Reload** on the extensions page. Cancel the old pairing and the old PulsarTeam
connection request before starting again.

The extension reports specific reasons such as an expired request, a reloaded
PulsarTeam tab, revoked permissions, conflicting cookies, or a failed import.
Version 1.0.0 hid all these errors behind a generic failure message. Browser
exceptions are never displayed verbatim because they may contain private data.

If an import is rejected, read the message in PulsarTeam. If the outcome cannot be
confirmed, check the session status before reconnecting. A transfer with an
uncertain outcome cannot be replayed automatically.

`browser_status` reports `browserLocation: "server"` and `canRead` for agent access.
The human UI's `canControl` flag only grants session management to its creator;
it is omitted from MCP responses. Local tab focus has no effect on server browsing.
Ordinary navigation keeps the session ID. Empty content is a bounded rendering
error, not a successful blank result and not an instruction to repeat sign-in.
Login redirects require a new explicit local transfer (`reauth_required`). The
server does not follow them into Google or another identity provider. Popups cannot
replace the server-owned page, including while sharing is paused.

## Tools and limitations

- `browser_status`: check session availability, sharing status and expiration.
- `browser_read`: read visible page text and links on the same origin.
- `browser_navigate`: open an HTTPS page on the exact shared origin and read it.
- `browser_scroll`: scroll the page and read more content.

There are no agent tools for arbitrary JavaScript, cookie or storage export,
clicking, or submitting forms. Websites still execute their own JavaScript, and
navigation or a GET request can have side effects on a poorly designed website.
This is not a universal read-only guarantee. Page content remains untrusted and
may contain prompt injection.

Public HTTPS subresources such as scripts, images, CDNs and frames are allowed.
The origin restriction applies to top-level navigation. Website scripts may send
data to their own external services. WebSockets, service workers, downloads,
camera and microphone access are disabled, so some sites will not work.

MFA and passkeys can be used for local login, but their keys are never exported.
Device-bound cookies, partitioned cookies, IndexedDB and sessionStorage are not
supported. A website may reject a session copied to a different browser or IP,
or request a fresh challenge. Local login does not remove these restrictions.
API OAuth tokens do not create browser sessions. A real LinkedIn connection is
not certified by the synthetic integration tests.

## Transfer protection

- A one-use request is bound to the website, controller and agent/board scope.
  Requests expire after ten minutes; replay and user/scope substitution are refused.
- The extension verifies the exact source tab and cookie store, the original
  PulsarTeam document, its HTTPS origin and the current request before transfer.
  Reloading or navigating the PulsarTeam tab requires a new pairing.
- Only cookies applicable to the website's home or current page are collected.
  Parent-domain cookies are narrowed to the exact host at import and `Secure` is
  enforced. Third-party SSO cookies, saved passwords, history and full browser
  profiles are not copied.
- No session JSON is exported to disk. Cookies stay out of URLs, DOM attributes,
  logs, React state and extension storage. They pass transiently through the
  extension, the page, the API and the worker's temporary browser profile, so
  trust in the PulsarTeam instance and protection against XSS remain essential.
- Pairing metadata alone is stored in `chrome.storage.session`. Newly granted
  optional permissions are removed when pairing finishes, is cancelled or expires.
  Host grants are exact, without wildcards, and stop at the public/private suffix
  boundaries provided by `tldts`. PulsarTeam's own domain cannot be exported.

## Cloudflare challenges

When a top-level response carries `cf-mitigated: challenge`, the worker reports
it without reading the challenge page. The API asks its internal FlareSolverr
service to solve the website root only, without the user's cookies or page path.
It sends back only `cf_clearance`, `__cf_bm` and `_cfuvid`, plus the solver's
User-Agent. The worker rebuilds its context with that User-Agent, preserves the
user session, and retries once. If the challenge remains, the agent stops.

FlareSolverr is on the `backend` network without authentication. Only the API
calls it for this plugin; the isolated worker cannot reach it. The clearance
also depends on the public egress IP, so worker and solver must use the same IP.
Changing the User-Agent can cause a website to reject the copied session.
During initial import, a detected challenge fails the transfer explicitly; it is
not published as a ready session.

## Deployment

Deploy the API, frontend and `mcp-auth-browser` worker together for this handoff
contract, then reload extension 1.0.3 and transfer a fresh session. The worker
deployment destroys its existing in-memory sessions.

Provision the same random **AUTH_BROWSER_KEY**, at least 32 characters, for
`team-api` and `mcp-auth-browser`. Do not reuse JWT_SECRET. Both services read
`/run/secrets/AUTH_BROWSER_KEY` before the development environment variable.
An empty secret disables the connector. `AUTH_BROWSER_SERVICE_URL` is an
administrator setting, never an agent-supplied URL. QA and production have
separate secrets and must each be configured.

The worker publishes no ports and joins only the encrypted `auth-browser` overlay
shared with the API. It does not join `backend` or the PostgreSQL network. Human
controls require a real user session, edit access and CSRF protection. TLS is
required at ingress. Diagnostic proxies must not log session-import bodies.

Each session has its own Chromium process and local CONNECT proxy. The proxy
validates all DNS answers and connects directly to an approved IP, rejecting
private/special addresses, DNS rebinding and ports other than 443. Redirects and
subresources use the same proxy. QUIC and direct WebRTC UDP are disabled.
These application controls do not replace a network firewall or browser audit.

Chromium runs as a non-root user with `chromium_sandbox=True`; there is no fallback
to `--no-sandbox`. Hosts must support user namespaces and a compatible seccomp
profile. Validate the Linux container on its target node; Windows tests are not
a substitute. Do not disable the sandbox to work around startup failures.

The stack mounts `/tmp` with long-form `volumes: type: tmpfs`, because the
installed Swarm CLI ignored the `tmpfs:` shorthand. The worker and API run on
`server-b`, avoiding cross-node traffic for this encrypted overlay.

`docker-compose.post.sh` applies the service-specific seccomp profile and
`NoNewPrivileges=true` through the Docker API because the installed stack CLI
ignores these `security_opt` options. It respects `STACK_NAME`, including
`qa-pulsarteam`, preserves images and secrets, and avoids restarting an already
compliant service. Manual reconciliation on the manager:

```sh
python3 devops/configure-auth-browser.py qa-pulsarteam
```

`devops/auth-browser-seccomp.json` derives from the Docker Moby profile referenced
in its license file. It adds `clone`, `setns`, `unshare` and `chroot` for Chromium's
sandbox with `cap_drop: ALL`; kernel capability checks and the default denial
remain in place. It adds no host capabilities or global daemon changes.

Browser profiles live in temporary storage, never in a database or persistent
volume. Limits: eight hours absolute lifetime, thirty minutes idle, six sessions.
Status polling does not extend a session. A worker restart or update loses all
sessions. Provider expiration requires manual reconnection; automatic OAuth
renewal is not promised.

Internal MCP tokens are bound to their agent and board. Headers cannot select a
different agent. Regenerate MCP configurations or restart runners that still
use tokens without that binding when deploying the authenticated browser.

## Validation

```sh
cd frontend
npm run test:browser-extension
npm run build
```

Worker tests, from the repository root:

```sh
python -m pip install -r mcp-auth-browser/requirements.txt
python -m unittest discover -s mcp-auth-browser/tests -v
```

Real MV3 extension and Chromium tests against synthetic sites (build the extension
bundle first using the frontend command above):

```sh
python -m playwright install chromium
BROWSER_E2E=1 python -m unittest discover -s mcp-auth-browser/tests -v
```

The integration test covers HttpOnly cookies, strict deduplication, local storage,
origin isolation, session sharing and suspension. It closes the local browser
before navigating twice on the server with the same session. Chromium regressions
also cover delayed SPA rendering, empty pages, HTTP login redirects and popup
isolation. Unit tests cover replay,
expiration, user/scope substitution, safe diagnostics and uncertain outcomes.
MV3 tests pre-grant fixture origins; native permission dialogs and installation
remain manual checks.
