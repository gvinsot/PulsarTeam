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
import { getGitHubCredentialsForAgent } from './github.js';
import { buildRepoCloneUrl } from '../services/repoUrl.js';

// Only these runners get a terminal — the others are LLM-providers or
// non-CLI runtimes for which the chat UI is the correct interface.
const TERMINAL_RUNNERS = new Set(['claudecode', 'codex', 'opencode', 'aider', 'openclaw', 'hermes']);

const RUNNER_URLS: Record<string, string> = {
  claudecode: process.env.CLAUDECODE_SERVICE_URL || 'http://claudecode-service:8000',
  codex: process.env.CODEX_SERVICE_URL || 'http://codex-service:8000',
  opencode: process.env.OPENCODE_SERVICE_URL || 'http://opencode-service:8000',
  aider: process.env.AIDER_SERVICE_URL || 'http://aider-service:8000',
  openclaw: process.env.OPENCLAW_SERVICE_URL || 'http://openclaw-service:8000',
  hermes: process.env.HERMES_SERVICE_URL || 'http://hermes-service:8000',
};

const TERMINAL_PATH_RE = /^\/ws\/agents\/([^\/]+)\/terminal$/;

// ─── Console-activity → agent.status ──────────────────────────────────────
//
// When the wrapped CLI prints anything to the PTY (LLM thinking, tool calls,
// shell commands…) the agent should appear "busy" in the UI even if no task
// was explicitly assigned via the workflow. After CONSOLE_IDLE_TIMEOUT_MS of
// quiet on the PTY, we flip back to "idle" — but only when no `currentTask`
// is set, so the workflow engine remains the authority for task-driven busy.
//
// REPLAY_GRACE_MS skips the scrollback burst the runner sends right after WS
// attach: otherwise every reconnect to a long-idle session would briefly
// show "busy" while the buffered bytes are flushed.
const CONSOLE_IDLE_TIMEOUT_MS = 5000;
const REPLAY_GRACE_MS = 1500;

// Backpressure thresholds for the PTY proxy (see handleBackpressure).
const PROXY_BUFFER_PAUSE_BYTES = 4 * 1024 * 1024;
const PROXY_BUFFER_RESUME_BYTES = 512 * 1024;
const PROXY_STALL_TIMEOUT_MS = 30_000;
const PROXY_DRAIN_POLL_MS = 100;

interface ConsoleActivityState {
  idleTimer: NodeJS.Timeout;
}
const consoleActivity = new Map<string, ConsoleActivityState>();

function noteConsoleOutput(agentId: string, agentManager: any): void {
  if (!agentManager || !agentId) return;
  const prev = consoleActivity.get(agentId);
  if (prev?.idleTimer) clearTimeout(prev.idleTimer);

  const agent = agentManager.agents?.get?.(agentId);
  if (agent && agent.status !== 'busy') {
    try {
      agentManager.setStatus(agentId, 'busy', 'Console activity');
    } catch (err: any) {
      console.warn(`[Terminal] setStatus(busy) failed for ${agentId.slice(0, 8)}: ${err.message}`);
    }
  }

  const idleTimer = setTimeout(() => {
    consoleActivity.delete(agentId);
    const a = agentManager.agents?.get?.(agentId);
    if (!a) return;
    // Workflow-driven busy owns the status: when a task is in progress, leave
    // the agent busy so the task pipeline can clear it the usual way.
    if (a.currentTask) return;
    if (a.status === 'busy') {
      try {
        agentManager.setStatus(agentId, 'idle', 'Console quiet');
      } catch (err: any) {
        console.warn(`[Terminal] setStatus(idle) failed for ${agentId.slice(0, 8)}: ${err.message}`);
      }
    }
  }, CONSOLE_IDLE_TIMEOUT_MS);

  consoleActivity.set(agentId, { idleTimer });
}

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
        apiKey: cfg.apiKey || null,
        endpoint: cfg.endpoint || null,
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
 *
 * `executionManager` is optional but recommended: it's used to push the
 * agent's GitHub plugin credentials to the runner-service BEFORE the runner
 * WS is dialled, so the CLI subprocess sees `GITHUB_TOKEN`/`GH_TOKEN` and the
 * `~/.git-credentials` file from its first byte. Without it, the LLM would
 * have to wait for the first `/projects/ensure` round-trip to authenticate.
 */
export function installTerminalProxy(httpServer: HttpServer, executionManager?: any, agentManager?: any): void {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 512,
      clientNoContextTakeover: false,
      serverNoContextTakeover: false,
      concurrencyLimit: 10,
    },
  });
  const runnerApiKey = readSecret('CODER_API_KEY') || '';

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    // socket.io owns `/socket.io/...` — let it handle those.
    const urlPath = req.url ? req.url.split('?')[0] : '';
    const match = urlPath ? TERMINAL_PATH_RE.exec(urlPath) : null;
    if (!match) return; // not our route, leave for other handlers

    // A browser disconnect during the handshake would otherwise emit an
    // unhandled 'error' on the raw socket and crash to the last-resort
    // uncaughtException handler. ws installs its own listener once
    // handleUpgrade takes over.
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);

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
      if (socket.writable) socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Finalise the upgrade before any async work: socket.io shares this
    // http.Server, and engine.io's default destroyUpgrade behaviour ends any
    // non-socket.io upgrade socket that has had nothing written to it within
    // 1s. Agent lookup + project provisioning can easily exceed that (DB
    // calls, git clone on the runner), so they run after the 101 and close
    // the WS with an application code on failure.
    socket.removeListener('error', onSocketError);
    wss.handleUpgrade(req, socket as any, head, (clientWs) => {
      authorizeAndWire(clientWs, agentId, decoded, runnerApiKey, cols, rows, executionManager, agentManager)
        .catch((err: any) => {
          console.warn(`[Terminal] Setup failed for agent ${agentId.slice(0, 8)}: ${err.message}`);
          try { clientWs.close(1011, 'terminal setup failed'); } catch { /* noop */ }
        });
    });
  });
}

/**
 * Post-upgrade authorization + provisioning, then bridge to the runner.
 * Runs after the 101 is sent, so failures surface as WS close codes
 * (the frontend's reconnect loop handles them like any other drop).
 */
async function authorizeAndWire(
  clientWs: WebSocket,
  agentId: string,
  decoded: DecodedToken,
  runnerApiKey: string,
  cols: string,
  rows: string,
  executionManager?: any,
  agentManager?: any,
): Promise<void> {
  // Authorize: agent must exist, be a CLI runner, and the requesting user
  // must own it (or be an admin).
  let agent: any;
  try {
    agent = await getAgentById(agentId);
  } catch (err: any) {
    clientWs.close(1011, 'agent lookup failed');
    return;
  }
  if (!agent) {
    clientWs.close(4404, 'Agent not found');
    return;
  }
  const runner = String(agent.runner || '');
  if (!TERMINAL_RUNNERS.has(runner)) {
    clientWs.close(4400, 'Agent is not a CLI runner');
    return;
  }
  const isOwner = agent.ownerId && decoded.userId && agent.ownerId === decoded.userId;
  const isAdmin = decoded.role === 'admin';
  if (!isOwner && !isAdmin) {
    // 4401 = "auth failed". Browsers expose the close code to JS.
    clientWs.close(4401, 'Forbidden');
    return;
  }

  let runnerContext: TerminalRunnerContext;
  try {
    runnerContext = await buildRunnerContext(agent);
  } catch (err: any) {
    clientWs.close(1011, 'runner context failed');
    return;
  }

  // Provision the agent's execution environment BEFORE opening the PTY so
  // the runner's prepare_interactive resolves cwd to the selected repo
  // instead of falling back to CLI_CWD=/app. Mirrors the chat path
  // (agentManager/chat.ts). Best-effort: a failure shouldn't block the
  // terminal.
  //
  //  1. Bind the agent to its real runner (claudecode/codex/…). Without
  //     this, _providerFor defaults to 'sandbox' for an agent that hasn't
  //     been bound by a chat/workflow yet, so steps 2-3 would target the
  //     wrong runner.
  //  2. Project pinned → clone/update it on the runner so the interactive
  //     CLI starts inside the working tree (and ~/.git-credentials +
  //     GITHUB_TOKEN/GH_TOKEN are installed along the way).
  //  3. No project → just push git credentials so any repo the LLM clones
  //     itself authenticates.
  if (executionManager) {
    try {
      const gitCreds = await getGitHubCredentialsForAgent(agentId, agent.boardId || null);
      executionManager.bindAgent?.(agentId, runner, {
        ownerId: agent.ownerId || null,
        gitCredentials: gitCreds,
        permissions: agent.permissions || null,
        llmConfig: runnerContext.llmConfig || null,
      });
      const gitUrl = buildRepoCloneUrl(agent.project);
      if (gitUrl && executionManager.ensureProject) {
        await executionManager.ensureProject(agentId, agent.project, gitUrl, gitCreds);
      } else if (gitCreds?.token && executionManager.installGitCredentials) {
        await executionManager.installGitCredentials(agentId, gitCreds);
      }
    } catch (err: any) {
      console.warn(`[Terminal] Project/credential provisioning failed for agent ${agentId.slice(0, 8)}: ${err.message}`);
    }
  }

  // The browser may have given up while we were provisioning.
  if (clientWs.readyState !== WebSocket.OPEN) return;

  wireProxy(clientWs, runner, agentId, agent.ownerId || '', runnerApiKey, cols, rows, runnerContext, agentManager);
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
  agentManager?: any,
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
    perMessageDeflate: {
      threshold: 512,
      clientNoContextTakeover: false,
      serverNoContextTakeover: false,
    },
    headers,
    // Without this, a blackholed runner (task restarting, overlay network
    // dropping SYNs) leaves the dial hanging for the OS TCP timeout and the
    // browser staring at a dead terminal with no close event.
    handshakeTimeout: 10_000,
  });

  const drainTimers = new Set<NodeJS.Timeout>();

  let closed = false;
  const closeBoth = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    for (const t of drainTimers) clearInterval(t);
    drainTimers.clear();
    // A paused socket stops processing incoming frames — including close
    // frames — so resume before closing to let the handshake complete.
    try { if (runnerWs.readyState === WebSocket.OPEN && runnerWs.isPaused) runnerWs.resume(); } catch { /* noop */ }
    try { if (clientWs.readyState === WebSocket.OPEN && clientWs.isPaused) clientWs.resume(); } catch { /* noop */ }
    try { clientWs.close(code, reason); } catch { /* noop */ }
    try { runnerWs.close(code, reason); } catch { /* noop */ }
  };

  // Backpressure: ws buffers unsent frames in process memory without limit,
  // so a fast PTY stream into a slow reader (backgrounded mobile tab) would
  // grow the API heap unboundedly. Pause the source while the sink's send
  // buffer is over the high-water mark; give up on sinks that never drain —
  // the PTY survives the detach, so the client just reattaches.
  const handleBackpressure = (source: WebSocket, sink: WebSocket) => {
    if (sink.bufferedAmount < PROXY_BUFFER_PAUSE_BYTES) return;
    if (source.readyState !== WebSocket.OPEN || source.isPaused) return;
    source.pause();
    const pausedAt = Date.now();
    const timer = setInterval(() => {
      if (sink.bufferedAmount <= PROXY_BUFFER_RESUME_BYTES) {
        clearInterval(timer);
        drainTimers.delete(timer);
        if (source.readyState === WebSocket.OPEN) {
          try { source.resume(); } catch { /* noop */ }
        }
        return;
      }
      if (Date.now() - pausedAt > PROXY_STALL_TIMEOUT_MS) {
        closeBoth(1009, 'receiver too slow');
      }
    }, PROXY_DRAIN_POLL_MS);
    drainTimers.add(timer);
  };

  const connectionOpenedAt = Date.now();

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
      return;
    }
    handleBackpressure(runnerWs, clientWs);
    // Reflect PTY activity as agent.status='busy' so the UI/workflow sees the
    // CLI is currently working. Text frames are control envelopes (exit,
    // resize), not CLI output — skip them. The grace window suppresses the
    // scrollback replay sent right after attach.
    if (isBinary && (Date.now() - connectionOpenedAt) > REPLAY_GRACE_MS) {
      noteConsoleOutput(agentId, agentManager);
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
      return;
    }
    handleBackpressure(clientWs, runnerWs);
  });
  clientWs.on('close', () => closeBoth());
  clientWs.on('error', () => closeBoth(1011, 'client error'));
}
