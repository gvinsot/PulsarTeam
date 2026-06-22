/**
 * Local web host. Three jobs:
 *  1. Proxy /api + /socket.io to the REMOTE platform so the UNCHANGED same-origin
 *     React frontend works as-is, and sniff the Bearer token off proxied requests
 *     to (re)authenticate the reverse bridge — no frontend change, no token UI.
 *  2. Serve the built frontend bundle (SPA).
 *  3. Serve a thin native-ish control shell (/__local/) that embeds the app in an
 *     iframe and adds Share-folder / status / activity — the bits a bare webview
 *     lacks — without touching the frontend code.
 */
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from './config.js';
import { bridge } from './bridge.js';
import { pickFolder } from './folderPicker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built frontend bundle location (overridable for dev). Packaged builds copy
// frontend/dist next to the app resources.
const FRONTEND_DIST = process.env.FRONTEND_DIST || path.join(__dirname, '..', 'frontend-dist');

export async function startServer(): Promise<{ url: string; server: http.Server }> {
  const app = express();

  // ── Bridge token capture: every authenticated /api call carries the user's
  // JWT; feed the freshest one to the bridge so it connects as that user.
  const captureToken = (req: any) => {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) bridge.setToken(auth.slice(7));
  };

  const apiProxy = createProxyMiddleware({
    target: config.serverUrl,
    changeOrigin: true,
    on: { proxyReq: (_p, req) => captureToken(req) },
  });
  const socketProxy = createProxyMiddleware({
    target: config.serverUrl,
    changeOrigin: true,
    ws: true,
  });

  app.use('/api', apiProxy);
  app.use('/socket.io', socketProxy);

  // ── Local control endpoints (under /__local to never clash with /api) ──
  app.get('/__local/status', (_req, res) => {
    res.json({ connected: bridge.connected, folders: bridge.folders, activityCount: bridge.activity.length });
  });
  app.get('/__local/activity', (_req, res) => res.json({ activity: bridge.activity.slice(0, 100) }));
  app.post('/__local/pick-folder', async (_req, res) => {
    const folder = await pickFolder();
    if (!folder) { res.json({ folder: null }); return; }
    await bridge.setFolder(folder);
    res.json({ folder });
  });
  app.get('/__local/', (_req, res) => res.type('html').send(CONTROL_SHELL));

  // ── Static frontend + SPA fallback ────────────────────────────────────
  app.use(express.static(FRONTEND_DIST));
  app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));

  const server = http.createServer(app);
  // http-proxy-middleware needs the raw upgrade event for websocket proxying.
  server.on('upgrade', (socketProxy as any).upgrade);

  await new Promise<void>(resolve => server.listen(config.localPort, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}/__local/`;
  console.log(`🖥️  Desktop UI at ${url}`);
  return { url, server };
}

// Minimal control shell: a header (share folder / status / activity) + the real
// app in an iframe. Kept inline so the packaged binary needs no extra asset.
const CONTROL_SHELL = `<!doctype html><html><head><meta charset="utf8"><title>PulsarTeam</title>
<style>
  body{margin:0;font-family:system-ui;background:#0b0f17;color:#e5e7eb}
  header{display:flex;align-items:center;gap:12px;padding:8px 12px;background:#111827;border-bottom:1px solid #1f2937}
  button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:13px}
  button.secondary{background:#374151}
  #status{font-size:13px;color:#9ca3af} #status.on{color:#34d399}
  #folder{font-size:12px;color:#9ca3af;font-family:monospace;max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  iframe{border:0;width:100vw;height:calc(100vh - 49px);background:#0b0f17}
  #log{position:fixed;right:0;top:49px;width:380px;height:calc(100vh - 49px);background:#0f1622;border-left:1px solid #1f2937;overflow:auto;display:none;padding:8px;font-size:12px}
  .row{padding:4px 6px;border-bottom:1px solid #1f2937} .err{color:#f87171} .ok{color:#34d399}
</style></head><body>
<header>
  <strong>PulsarTeam</strong>
  <button onclick="pick()">📁 Share folder</button>
  <span id="folder"></span>
  <span id="status" style="margin-left:auto">● offline</span>
  <button class="secondary" onclick="toggleLog()">Activity</button>
</header>
<iframe src="/"></iframe>
<div id="log"></div>
<script>
  async function refresh(){
    const s = await fetch('/__local/status').then(r=>r.json());
    const st = document.getElementById('status');
    st.textContent = s.connected ? '● connected' : '● offline'; st.className = s.connected?'on':'';
    document.getElementById('folder').textContent = (s.folders&&s.folders[0])||'no folder shared';
  }
  async function pick(){ const r=await fetch('/__local/pick-folder',{method:'POST'}).then(r=>r.json()); if(r.folder) refresh(); }
  async function toggleLog(){
    const el=document.getElementById('log'); const show=el.style.display==='none'||!el.style.display;
    el.style.display=show?'block':'none'; if(!show)return;
    const {activity}=await fetch('/__local/activity').then(r=>r.json());
    el.innerHTML=activity.map(a=>'<div class="row '+(a.ok?'ok':'err')+'">'+new Date(a.at).toLocaleTimeString()+' · '+a.tool+(a.path?' · '+a.path:'')+(a.error?' · '+a.error:'')+'</div>').join('')||'<div class="row">no activity yet</div>';
  }
  setInterval(refresh, 3000); refresh();
</script></body></html>`;
