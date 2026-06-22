# PulsarTeam Desktop (local companion app)

A lightweight **Node + native-webview** app (NOT Electron) that lets you share a
**local folder** with your PulsarTeam agents. The files **never leave your
machine** — server-side agents read/edit/generate them remotely through a reverse
socket bridge, with the same office tools as the cloud `Office Documents`
connector. Cross-platform (Windows / macOS / Linux) via the OS webview
(WebView2 / WKWebView / WebKitGTK), so there is no bundled Chromium.

## How it works
```
 native webview window  ──loads──▶  http://127.0.0.1:<port>/__local/  (control shell + <iframe> app)
                                          │
 local Node host (server.ts) ────────────┤ proxies /api + /socket.io ─▶ remote PulsarTeam platform
                                          │ sniffs the Bearer token off /api calls
                                          ▼
 reverse bridge (bridge.ts) ──socket.io──▶ platform  (room desktop:${userId})
   on 'bridge:tool:call':
     fs_* tools   → fsGuard (allow-listed folder, anti-traversal)
     office tools → office sidecar (bundled office-engine, OFFICE_ROOT = shared folder)
```
The platform's **Local Folder** MCP connector (`mcp-local-folder`) emit-with-acks
`bridge:tool:call` to this app; results return through the ack. See
`api/src/services/localFolderMcp.ts` and `api/src/ws/socketHandler.ts`.

## Files
| File | Role |
|---|---|
| `src/main.ts` | entry: start local host → open window → cleanup on exit |
| `src/server.ts` | local Express host: proxy /api+/socket.io, token capture, control shell, static frontend |
| `src/bridge.ts` | reverse socket bridge; dispatches fs vs office tool calls; activity log |
| `src/fsGuard.ts` | **trust boundary** — confines every path to the shared folder (tested) |
| `src/sidecar.ts` | office-engine lifecycle + MCP client (loopback) |
| `src/folderPicker.ts` | native "choose folder" via OS dialog (no Electron) |
| `src/window.ts` | native webview window, browser fallback |

## Dev
```bash
npm install
# point at your platform + the office-engine source for the sidecar:
PULSAR_SERVER_URL=https://your-platform \
OFFICE_ENGINE_DEV_CMD="python -m office_engine.mcp_server" \
FRONTEND_DIST=../frontend/dist \
npm run dev
```
Log into the webview as usual; the bridge connects once the token is seen, and
starts serving tool calls after you click **Share folder**.

```bash
npm test          # fsGuard confinement tests (pure Node)
npm run build     # tsc → dist/
```

## Packaging (see scripts/package.mjs and ../docs/desktop-packaging.md)
Bundle into a single executable with **Node SEA** (or `pkg`), alongside:
- the office-engine **PyInstaller** binary (set `OFFICE_ENGINE_BIN`),
- a portable **LibreOffice** (set `OFFICE_SOFFICE_BIN`),
- the built `frontend/dist` (set `FRONTEND_DIST` or copy to `frontend-dist/`),
- the `webview-nodejs` native addon.

Then sign: **Authenticode** (Windows) / **codesign + notarize** (macOS, including
the nested LibreOffice). Host the installers and set `DESKTOP_DOWNLOAD_URL` on the
api so the in-app **Local Folder** connector links to the download.

## Security
`fsGuard` is the authoritative boundary: every path is realpath-resolved and
confined to the user-picked folder (symlink/`..`/absolute/UNC escapes refused);
destructive writes default into `pulsar-output/` unless `overwrite:true`. The
bridge socket carries the user's JWT and only ever reaches that user's own
`desktop:${userId}` room. The office sidecar is bound to loopback with
`OFFICE_ROOT` = the shared folder.
