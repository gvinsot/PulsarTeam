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
reading and interaction (click, fill, select, key presses and file upload). Agents
can complete a user-requested publication through the website's own interface;
there is no platform-specific publication API or guarantee of website support.
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
3. Enter the exact HTTPS website origin and click **Connect in my browser**.
   LinkedIn's `https://linkedin.com` is normalized to `https://www.linkedin.com`
   before pairing, so the request and permissions match its signed-in website. The
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

### Several websites

One plugin instance shares several websites. Each website has its own server
Chromium session and account (worker key `<agent|board scope>@<host>`), listed in
the connection panel with its own **Pause sharing**, **Resume sharing** and
**Disconnect** buttons. Add another one with **Add another website** once the
current transfer is done: only one transfer waits at a time per agent or board,
because the extension pairs with exactly one request on the PulsarTeam page.

For an agent, its own sessions come first; its board's sessions add the other
websites. Per website, an agent session in any phase (even a pending transfer)
wins, so it never falls through to the board's account for that same website.
`browser_navigate` uses the session of the URL's website. The other tools take an
optional `site`; it is required only when several websites are connected.
Every session counts towards the worker's capacity (`MAX_SESSIONS`).

## Update or troubleshoot the extension

Version **1.0.5** retains Instagram parent-cookie provenance so its publishing
API at `i.instagram.com` can receive the required cookies. Update/reload the
extension and share Instagram again: old transfers intentionally contain no
parent-domain information, so the worker cannot safely broaden them afterwards.
The transfer popup discloses this additional Instagram API scope. Host-only
cookies stay host-only; all other sites retain exact-host-only imports.

Version **1.0.4** explains when the website tab is on a different origin and offers
**Restart in PulsarTeam**. Cancel the old request there and reconnect with the final
signed-in website address. Opening the popup in another tab offers **Return to
website tab**. A redirect does not silently extend permissions or transfer cookies.

Version 1.0.3 introduced transfer of the current signed-in page URL, required by the
new import endpoint. Earlier extensions are rejected with an update instruction.
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

- `browser_status`: list the shared websites, each with its availability
  (`canRead`), sharing status and expiration.
- `browser_read`: read the page: visible text (including open shadow DOM), same-origin
  links, the accessibility tree (`aria`: roles, checked boxes, field values, selected
  options) and same-origin iframes. `format` picks `text`, `aria` or `both` (default).
- `browser_navigate`: open an HTTPS page on the exact origin of a shared website
  (whose session is used) and read it.
- `browser_scroll`: scroll the page and read more content.
- `browser_click`, `browser_fill`, `browser_press`, `browser_select`: interact with
  one control on the shared main page, including open shadow roots. A target is
  `{by: "role", value: "button", name: "Publish"}`, `{by: "label", value: "Title"}`
  or `{by: "css", value: "#observed-id"}`. Read the page first; targets must match
  exactly one element. Fill replaces the text; select uses native option values.
  Password/hidden credential inputs and iframe targeting are refused.
- `browser_upload_sources`: list the current task's attachment IDs and filenames.
- `browser_upload`: set one file input, including a hidden one. `browser_read`
  now returns `fileInputs` selectors. Provide either an `attachment_id` from the
  current task (existing 10 MB attachment limit) or a direct public HTTPS
  `source_url`, with optional `filename` (250 MB maximum). Runner/local paths,
  private URLs and redirects are not supported. Do not make a private file
  public just to use this tool. Sources are streamed without website cookies to
  a bounded temporary worker file, retained until the session closes because
  the website may read it after a later Publish click. Failed transfers are
  erased immediately. Total staged files are capped at 500 MB across the worker;
  disconnect unused sessions to release storage. No file bytes
  pass through the model. The upload is bound to the original session ID.
- `browser_screenshot`: JPEG of the viewport, or with `full_page` of the whole page in
  4000 px sections (`section` 1, 2, …; the result reports `section` and `sections`).
  Agents on a model without image support receive a text notice instead.
- `browser_save_pdf`: render the page as a PDF (`media`: `screen`, the default, keeps
  the on-screen look at 1280 px; `print` uses the site's A4 print stylesheet) and
  attach it to the agent's current task. No current task, no PDF. 10 MB limit.

A read waits until the text is stable, no fetch/XHR is in flight (requests older than
5 s count as long polls and are ignored) and, if given, the `wait_for` text is present.
`wait_ms` raises the 8 s default up to 20 s. A page still changing at the deadline is
returned with `settled: false`. Password field values are redacted from every result;
a page with a visible password field, including a screenshot request, is refused as a
login page. Third-party iframes are never read.

There are no agent tools for arbitrary JavaScript, cookie or storage export.
The interaction tools can submit forms and publish with the shared account.
Sharing/pause/revoke rules and exact-origin restrictions apply to every action.
`canInteract` indicates whether the shared session is ready for these tools.
An action's `actionPerformed` flag confirms a browser operation, not publication.
After upload, inspect processing; after Publish, verify the site's confirmation
and published link. If `outcome: "unknown"` or `pageAvailable: false` is returned,
inspect the page before any retry. No action is automatically retried.
Websites still execute their own JavaScript, and
navigation or a GET request can have side effects on a poorly designed website.
This is not a universal read-only guarantee. Page content remains untrusted and
may contain prompt injection.

Public HTTPS subresources such as scripts, images, CDNs and frames are allowed.
The origin restriction applies to top-level navigation. Website scripts may send
data to their own external services. WebSockets, service workers, downloads,
camera and microphone access are disabled, so some sites will not work.

MFA and passkeys can be used for local login, but their keys are never exported.
Device-bound cookies, partitioned cookies, local IndexedDB transfer and
sessionStorage are not supported (server-created IndexedDB is checkpointed).
A website may reject a session copied to a different browser or IP,
or request a fresh challenge. Local login does not remove these restrictions.
API OAuth tokens do not create browser sessions. A real LinkedIn connection is
not certified by the synthetic integration tests.

The worker uses Playwright's full Chromium channel (new headless mode), and
YouTube Studio gets a fifteen-second initial render window. An empty page does
not prove browser incompatibility or publication failure. Explicit
`login_required` errors in visible dialogs or small first-party JSON responses
mark the session `reauth_required`, even if its editor still looks signed in.
After a dispatched action, this is reported without replaying the action or
claiming publication succeeded. Reconnect locally, share again, then check the
platform's published items before retrying a publication.

## Transfer protection

- A one-use request is bound to the website, controller and agent/board scope.
  Requests expire after ten minutes; replay and user/scope substitution are refused.
- The extension verifies the exact source tab and cookie store, the original
  PulsarTeam document, its HTTPS origin and the current request before transfer.
  Reloading or navigating the PulsarTeam tab requires a new pairing.
- Only cookies applicable to the website's home or current page are collected.
  Parent-domain cookies are narrowed to exact hosts and `Secure` is enforced.
  The sole publishing exception is `.instagram.com` cookies explicitly transferred
  from `www.instagram.com`: the worker makes host-only copies for that site and
  `i.instagram.com`, never a wildcard domain. Top-level navigation remains on the
  shared website. Third-party SSO cookies, saved passwords, history and full browser
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
contract, then reload extension 1.0.5 and transfer a fresh session. The worker
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

Live browser profiles remain temporary. Explicitly shared sessions (cookies,
localStorage and IndexedDB, site/scope, controller, session ID, pause state and
timestamps) are checkpointed in PostgreSQL through the private service-key
endpoint `/api/internal/auth-browser-sessions`. The API encrypts each snapshot
with AES-256-GCM using `ENCRYPTION_KEY`; the worker has no database credentials.
`APP_ENVIRONMENT` must explicitly name the deployment: QA and production never
load one another's snapshots. Preserve the database and encryption key when
moving servers. `AUTH_BROWSER_STATE_API_URL` enables persistence in the worker;
without it, local development retains the previous in-memory behaviour.

Snapshots are saved on sharing, after commands, every thirty seconds, and on
graceful shutdown. Startup retries while the API is unavailable and blocks
commands until restoration completes. Websites reopen lazily on first use;
pending local transfers and unshared login screens are never saved. Paused
sessions stay paused, disconnect removes the database entry before confirming,
and restoration never replays clicks, uploads or publication actions. Temporary
upload files and unfinished page forms are not restored. Abrupt machine failure
can lose changes since the last checkpoint.

Limits: six sessions; by default eight hours absolute lifetime and thirty
minutes idle. Redeployment and status polling do not reset these timers.
Sessions lost before this upgrade cannot be recovered and must be shared once
again.

### Lifetime, keepalive and automatic sign-in

The user who shared a website (and only that user) can change, per session:

- **Lifetime**: 8 hours (default), 24 hours, 7 days or 30 days, counted from
  the transfer. A session cannot be shortened below its age. Beyond 8 hours
  the 30-minute idle limit no longer applies.
- **Keepalive** (automatic for lifetimes beyond 8 hours): when no agent used
  the session for about four hours (plus up to 30 minutes of random jitter),
  the worker reopens the shared page so the website can renew its sliding
  cookies, then saves the snapshot. It never counts as use and never extends
  the lifetime. A restored session's browser is closed again afterwards.
- **Automatic sign-in** (opt-in): username, password, optional TOTP secret
  (base32) and optional sign-in page on the same origin. The API stores them
  encrypted in `auth_browser_credentials` and only returns them to the worker
  (`POST /api/internal/auth-browser-sessions/credentials`, worker key). They
  are never sent back to the UI, to agents, or in a worker command. When the
  website rejects the session (`reauth_required`), the worker signs in again
  on the next agent command or within a minute, in the main frame of the
  session's own origin only (navigation guards are unchanged), then checks
  the shared page like an agent read. Attempts are spaced 30 minutes apart
  and stop after three consecutive failures (persisted across restarts) until
  the user clicks "Sign in again now" or saves new credentials. Disconnect and
  expiry delete the credentials together with the snapshot. Captchas, SMS
  codes, device approval and cross-origin identity providers cannot be
  completed automatically; such sites still need a new transfer.

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
python -m pip install -r mcp-auth-browser/requirements-test.txt
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
