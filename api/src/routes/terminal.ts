/**
 * Terminal WebSocket proxy.
 *
 * Bridges the browser's WebSocket (`/ws/agents/:id/terminal`) to the
 * runner-service's shared-PTY endpoint (`/ws/terminal/{agent_id}`). This
 * is the ONLY user-facing interface for CLI runners in interactive mode —
 * the chat tab is hidden for `agent.runner ∈ {claudecode, codex, opencode,
 * openclaw, hermes}` so the user drives the real TUI here.
 *
 * Auth + authorization:
 *   • The browser passes the user's JWT via `?token=…` on the WS handshake
 *     (header-based auth is awkward over `new WebSocket()`).
 *   • We verify the JWT, look up the agent by id, and check the user owns
 *     it (or is an admin). Failing → close with 4401.
 *   • Server → runner-service uses the shared CODER_API_KEY as before.
 *
 * Lifecycle:
 *   • Connecting to a runner that already has a session for this agent
 *     attaches as a second client (the runner replays scrollback).
 *   • Disconnecting just detaches — the PTY survives so a reload reattaches
 *     without losing context. The runner reaps idle sessions on its end.
 */
import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { URL } from 'url';

import { readSecret } from '../secrets.js';
import { getAgentById } from '../services/database.js';
import { getLlmConfig } from '../services/database/llmConfigs.js';

// Only these runners get a terminal — the others are LLM-providers or
// non-CLI runtimes for which the chat UI is the correct interface.
const TERMINAL_RUNNERS = new Set(['claudecode', 'codex', 'opencode', 'openclaw', 'hermes']);

const RUNNER_URLS: Record<string, string> = {
  claudecode: process.env.CLAUDECODE_SERVICE_URL || 'http://claudecode-service:8000',
  codex: process.env.CODEX_SERVICE_URL || 'http://codex-service:8000',
  opencode: process.env.OPENCODE_SERVICE_URL || 'http://opencode-service:8000',
  openclaw: process.env.OPENCLAW_SERVICE_URL || 'http://openclaw-service:8000',
  hermes: process.env.HERMES_SERVICE_URL || 'http://hermes-service:8000',
};

const TERMINAL_PATH_RE = /^\/ws\/agents\/([^\/]+)\/terminal$/;

function getJwtSecret(): string {
  const s = readSecret('JWT_SECRET');
  if (!s) throw new Error('JWT_SECRET is not configured');
  return s;
}

interface DecodedToken {
  userId?: string;
  username?: string;
  role?: string;
}

interface TerminalRunnerContext {
  permissions?: any | null;
  llmConfig?: any | null;
}

async function buildRunnerContext(agent: any): Promise<TerminalRunnerContext> {
  let llmConfig: any = null;
  if (agent.llmConfigId) {
    const cfg = await getLlmConfig(agent.llmConfigId);
    if (cfg) {
      llmConfig = {
        provider: cfg.provider || null,
        model: cfg.model || null,
        apiKey: cfg.apiKey || agent.apiKey || null,
        endpoint: cfg.endpoint || agent.endpoint || null,
      };
    }
  }
  return {
    permissions: agent.permissions || null,
    llmConfig,
  };
}

/**
 * Install the terminal WS proxy on the given http.Server. Sits alongside
 * socket.io (different path), so the existing chat WS stays untouched.
 */
export function installTerminalProxy(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const runnerApiKey = readSecret('CODER_API_KEY') || '';

  httpServer.on('upgrade', async (req: IncomingMessage, socket, head) => {
    // socket.io owns `/socket.io/...` — let it handle those.
    const urlPath = req.url ? req.url.split('?')[0] : '';
    const match = urlPath ? TERMINAL_PATH_RE.exec(urlPath) : null;
    if (!match) return; // not our route, leave for other handlers

    const agentId = match[1];
    const parsedUrl = new URL(req.url!, 'http://localhost');
    const token = parsedUrl.searchParams.get('token') || '';
    const cols = parsedUrl.searchParams.get('cols') || '120';
    const rows = parsedUrl.searchParams.get('rows') || '40';

    // Verify the user's JWT before consuming the upgrade.
    let decoded: DecodedToken;
    try {
      decoded = jwt.verify(token, getJwtSecret()) as DecodedToken;
    } catch {
      // 4401 = "auth failed". Browsers expose the close code to JS.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Authorize: agent must exist, be a CLI runner, and the requesting user
    // must own it (or be an admin).
    let agent: any;
    try {
      agent = await getAgentById(agentId);
    } catch (err: any) {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!agent) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const runner = String(agent.runner || '');
    if (!TERMINAL_RUNNERS.has(runner)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nAgent is not a CLI runner');
      socket.destroy();
      return;
    }
    const isOwner = agent.ownerId && decoded.userId && agent.ownerId === decoded.userId;
    const isAdmin = decoded.role === 'admin';
    if (!isOwner && !isAdmin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let runnerContext: TerminalRunnerContext;
    try {
      runnerContext = await buildRunnerContext(agent);
    } catch (err: any) {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }

    // Finalise the upgrade now that auth + authz passed.
    wss.handleUpgrade(req, socket as any, head, (clientWs) => {
      wireProxy(clientWs, runner, agentId, agent.ownerId || '', runnerApiKey, cols, rows, runnerContext);
    });
  });
}

/**
 * Once we've accepted the browser's WS upgrade, dial out to the appropriate
 * runner-service and shovel bytes in both directions until either side closes.
 */
function wireProxy(
  clientWs: WebSocket,
  runner: string,
  agentId: string,
  ownerId: string,
  apiKey: string,
  cols: string,
  rows: string,
  context: TerminalRunnerContext = {},
): void {
  const baseUrl = RUNNER_URLS[runner];
  if (!baseUrl) {
    clientWs.close(1011, 'No runner URL configured');
    return;
  }
  const wsUrl = baseUrl.replace(/^http/, 'ws')
    + `/ws/terminal/${encodeURIComponent(agentId)}`
    + `?api_key=${encodeURIComponent(apiKey)}`
    + (ownerId ? `&owner_id=${encodeURIComponent(ownerId)}` : '')
    + `&cols=${encodeURIComponent(cols)}&rows=${encodeURIComponent(rows)}`;

  const headers: Record<string, string> = {};
  if (context.permissions) headers['X-Agent-Permissions'] = JSON.stringify(context.permissions);
  if (context.llmConfig !== undefined) headers['X-LLM-Config'] = JSON.stringify(context.llmConfig);

  const runnerWs = new WebSocket(wsUrl, {
    perMessageDeflate: false,
    headers,
  });

  let closed = false;
  const closeBoth = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    try { clientWs.close(code, reason); } catch { /* noop */ }
    try { runnerWs.close(code, reason); } catch { /* noop */ }
  };

  runnerWs.on('open', () => {
    // No-op — we just start forwarding messages once both ends are alive.
  });

  // runner → client (binary bytes from PTY, occasional text JSON like {type:"exit"})
  runnerWs.on('message', (data, isBinary) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    try {
      clientWs.send(data, { binary: isBinary });
    } catch (err) {
      // Client probably gone — schedule a clean close.
      closeBoth(1011, 'client send failed');
    }
  });
  runnerWs.on('close', (code, reason) => closeBoth(code, reason?.toString() || ''));
  runnerWs.on('error', (err) => {
    // We can't surface the underlying error to a browser WS, so just close.
    // (The runner logs the real reason on its side.)
    closeBoth(1011, 'runner error');
  });

  // client → runner (keystrokes as binary, resize as text JSON)
  clientWs.on('message', (data, isBinary) => {
    if (runnerWs.readyState !== WebSocket.OPEN) return;
    try {
      runnerWs.send(data, { binary: isBinary });
    } catch {
      closeBoth(1011, 'runner send failed');
    }
  });
  clientWs.on('close', () => closeBoth());
  clientWs.on('error', () => closeBoth(1011, 'client error'));
}
