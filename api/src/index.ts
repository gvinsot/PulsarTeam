import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { setCurrentEnvironmentFromHost } from './lib/environment.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { authRouter, authenticateToken, requireRole, getJwtSecret, ensureAdminSeeded } from './middleware/auth.js';
import { agentRoutes } from './routes/agents.js';
import { templateRoutes } from './routes/templates.js';
import { projectRoutes } from './routes/projects.js';
import { codeIndexRoutes } from './routes/codeIndex.js';
import { setupSocketHandlers } from './ws/socketHandler.js';
import { AgentManager } from './services/agentManager.js';
import { SkillManager } from './services/skillManager.js';
import { ExecutionManager } from './services/execution/index.js';
import { MCPManager } from './services/mcpManager.js';
import { CodeIndexService } from './services/codeIndexService.js';
import { createCodeIndexMcpHandler } from './services/codeIndexMcp.js';
import { createGandiDnsMcpHandler } from './services/gandiDnsMcp.js';
import { createBrowserMcpHandler } from './services/browserMcp.js';
import { pluginRoutes } from './routes/plugins.js';
import { agentSkillRoutes } from './routes/agentSkills.js';
import { mcpServerRoutes } from './routes/mcpServers.js';
import { realtimeRoutes } from './routes/realtime.js';
import { externalVoiceRoutes } from './routes/externalVoice.js';
import { leaderToolsRoutes } from './routes/leaderTools.js';
import { BUILTIN_SKILLS } from './data/skills.js';
import { readSecret, validateProductionSecrets } from './secrets.js';
import { buildCorsOptions, getCorsOrigins, isOriginAllowed, logRejectedOrigin, validateCorsConfig } from './middleware/corsConfig.js';
import { BUILTIN_MCP_SERVERS } from './data/mcpServers.js';
import { initDatabase, isDatabaseConnected } from './services/database.js';
import { onedriveRoutes } from './routes/onedrive.js';
import { microsoftOAuthRedirectRouter } from './routes/microsoftOAuth.js';
import { createOneDriveMcpHandler } from './services/onedriveMcp.js';
import { outlookRoutes } from './routes/outlook.js';
import { createOutlookMcpHandler } from './services/outlookMcp.js';
import { gmailRoutes } from './routes/gmail.js';
import { createGmailMcpHandler } from './services/gmailMcp.js';
import { gdriveRoutes } from './routes/gdrive.js';
import { googleOAuthRedirectRouter, handleGoogleOAuthCallback } from './routes/googleOAuth.js';
import { createGdriveMcpHandler } from './services/gdriveMcp.js';
import { slackRoutes, slackOAuthRedirectRouter } from './routes/slack.js';
import { createSlackMcpHandler } from './services/slackMcp.js';
import { createAutoLearnMcpHandler } from './services/autoLearnMcp.js';
import { apiKeyRoutes } from './routes/apiKeys.js';
import { settingsRoutes } from './routes/settings.js';
import { createSwarmApiMcpHandler, createSwarmApiMcpSseHandlers } from './services/swarmApiMcp.js';
import { ensureApiKeysTable } from './services/apiKeyManager.js';
import { authenticateApiKey } from './middleware/apiKeyAuth.js';
import { authenticateCoderApiKey } from './middleware/coderApiKeyAuth.js';
import { internalClaudeTokenRoutes } from './routes/internalClaudeTokens.js';
import { internalCodexTokenRoutes } from './routes/internalCodexTokens.js';
import { internalRunnerLlmRoutes } from './routes/internalRunnerLlm.js';
import { codexAuthRoutes } from './routes/codexAuth.js';
import { swarmApiRoutes } from './routes/swarmApi.js';
import { jiraRoutes } from './routes/jira.js';
import { createJiraMcpHandler } from './services/jiraMcp.js';
import { wordpressRoutes } from './routes/wordpress.js';
import { createWordPressMcpHandler } from './services/wordpressMcp.js';
import { githubRoutes, githubOAuthRedirectRouter } from './routes/github.js';
import { createGitHubMcpHandler } from './services/githubMcp.js';
import { s3Routes } from './routes/s3.js';
import { createS3McpHandler } from './services/s3Mcp.js';
import budgetRoutes from './routes/budget.js';
import { userRoutes } from './routes/users.js';
import { llmConfigRoutes } from './routes/llmConfigs.js';
import { boardRoutes } from './routes/boards.js';
import { contactRoutes } from './routes/contact.js';
import taskRoutes from './routes/tasks.js';
import { setAgentManager } from './services/userProvisioning.js';
import { installTerminalProxy } from './routes/terminal.js';

const app = express();
const httpServer = createServer(app);

// Trust the first proxy hop (Traefik in swarm, nginx in dev) so req.protocol
// and req.get('host') reflect the public URL the user sees rather than the
// internal container hostname. Required for OAuth: we derive the popup
// redirect_uri from the request, which must match the URI Google/Microsoft
// see in the auth URL — both come from the same browser through the proxy.
app.set('trust proxy', 1);

const corsOrigins = getCorsOrigins();

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "connect-src 'self' wss: ws: https://api.openai.com https://accounts.google.com https://oauth2.googleapis.com https://github.com https://api.github.com https://fonts.googleapis.com https://fonts.gstatic.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

const io = new Server(httpServer, {
  cors: buildCorsOptions(corsOrigins)
});

const skillManager = new SkillManager();
const executionManager = new ExecutionManager({
  claudecodeOptions: {
    baseUrl: process.env.CLAUDECODE_SERVICE_URL || process.env.CODER_SERVICE_URL || 'http://claudecode-service:8000',
    apiKey: readSecret('CODER_API_KEY')
  }
});
const mcpManager = new MCPManager();
const codeIndexService = new CodeIndexService();
const agentManager = new AgentManager(io, skillManager, executionManager, mcpManager, codeIndexService);
setAgentManager(agentManager);
app.set('io', io);
app.set('agentManager', agentManager);

// Mount the terminal WebSocket proxy on the same http.Server. Lives at
// /ws/agents/:id/terminal — separate path from socket.io's /socket.io/*,
// so the two upgrade handlers don't collide. Only intercepts paths that
// match the terminal route; everything else flows on to socket.io.
installTerminalProxy(httpServer);

app.use(cors(buildCorsOptions(corsOrigins)));

// Security headers — defense-in-depth when accessed without a reverse proxy
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // OAuth callback pages set their own CSP with a nonce for inline scripts
  const isOAuthCallback =
    req.path.endsWith('/oauth-redirect') ||
    req.path === '/gmail-callback.html' ||
    req.path === '/gdrive-callback.html' ||
    req.path === '/google-callback.html';
  if (!isOAuthCallback) {
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  }
  next();
});

// Lock this replica's environment on the first public hostname we observe,
// so the workflow engine only picks up tasks tagged for our deployment when
// several replicas share the same database. Internal/healthcheck hosts are
// ignored by setCurrentEnvironmentFromHost.
app.use((req, _res, next) => {
  setCurrentEnvironmentFromHost(req.hostname);
  next();
});

app.use(express.json({ limit: '1mb' }));

// Global API rate limiter — 300 requests per minute per IP
// Authenticated users need headroom for rapid UI actions (bulk task deletion, etc.)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

app.use('/api/auth', authRouter);

// User management (admin only)
app.use('/api/users', authenticateToken, requireRole('admin'), userRoutes());

// Public contact form — rate-limited, no auth required
app.use('/api/contact', contactRoutes(agentManager));

// Public OAuth redirect handlers — providers redirect here after consent (no auth needed)
// Gmail and Drive share one OAuth client + one redirect URI; the service is
// encoded in `state` so any of these paths invokes the same dispatcher.
app.use('/api/google', googleOAuthRedirectRouter());
app.get('/api/gmail/oauth-redirect', handleGoogleOAuthCallback);   // backward compat
app.get('/api/gdrive/oauth-redirect', handleGoogleOAuthCallback);  // backward compat
app.use('/api/github', githubOAuthRedirectRouter());
app.use('/api/slack', slackOAuthRedirectRouter());
// Microsoft Graph OAuth shares one client across all Microsoft plugins
// (OneDrive, Outlook; Teams/SharePoint in the future). The originating plugin
// is encoded in `state` so a single redirect URI handles all of them.
app.use('/api/microsoft', microsoftOAuthRedirectRouter());
app.use('/api/onedrive', microsoftOAuthRedirectRouter()); // legacy alias
// Legacy callback paths — Traefik routes these to the API to bypass global@file middleware
app.get('/gmail-callback.html', handleGoogleOAuthCallback);
app.get('/gdrive-callback.html', handleGoogleOAuthCallback);
app.get('/google-callback.html', handleGoogleOAuthCallback);

app.use('/api/agents', authenticateToken, agentRoutes(agentManager));
app.use('/api/templates', authenticateToken, templateRoutes());
app.use('/api/projects', authenticateToken, projectRoutes());
app.use('/api/code-index', authenticateToken, codeIndexRoutes(codeIndexService));
app.use('/api/plugins', authenticateToken, pluginRoutes(skillManager, mcpManager));
// Backward compatibility
app.use('/api/skills', authenticateToken, pluginRoutes(skillManager, mcpManager));
app.use('/api/agent-skills', authenticateToken, agentSkillRoutes());
app.use('/api/mcp-servers', authenticateToken, mcpServerRoutes(mcpManager));
app.use('/api/onedrive', authenticateToken, onedriveRoutes());
app.use('/api/outlook', authenticateToken, outlookRoutes());
app.use('/api/gmail', authenticateToken, gmailRoutes());
app.use('/api/gdrive', authenticateToken, gdriveRoutes());
app.use('/api/slack', authenticateToken, slackRoutes());
app.use('/api/realtime', authenticateToken, realtimeRoutes(agentManager));
app.use('/api/external-voice', authenticateToken, externalVoiceRoutes(agentManager));
app.use('/api/leader-tools', authenticateToken, leaderToolsRoutes(agentManager));
app.use('/api/budget', authenticateToken, budgetRoutes);
app.use('/api/settings/api-key', authenticateToken, apiKeyRoutes);
app.use('/api/llm-configs', authenticateToken, llmConfigRoutes(agentManager));
app.use('/api/settings/general', authenticateToken, settingsRoutes());
app.use('/api/jira', authenticateToken, jiraRoutes());
app.use('/api/wordpress', authenticateToken, wordpressRoutes());
app.use('/api/s3', authenticateToken, s3Routes());
app.use('/api/github', authenticateToken, githubRoutes());
app.use('/api/boards', authenticateToken, boardRoutes(agentManager));
app.use('/api/tasks', authenticateToken, taskRoutes);

// Internal: runners read/write Claude OAuth tokens via shared CODER_API_KEY.
app.use('/api/internal/claude-tokens', authenticateCoderApiKey, internalClaudeTokenRoutes());
app.use('/api/internal/codex-tokens', authenticateCoderApiKey, internalCodexTokenRoutes());
app.use('/api/internal/runner-llm', authenticateCoderApiKey, internalRunnerLlmRoutes());
app.use('/api/codex-auth', authenticateToken, codexAuthRoutes());

// Internal MCP endpoints (used by the MCP client for tool discovery and calls)
const onedriveMcpHandler = createOneDriveMcpHandler();
app.all('/api/onedrive/mcp', authenticateToken, (req, res) => onedriveMcpHandler(req, res));

// Pass the executionManager as the runner bridge so the Gmail and Outlook
// MCPs can read agent-side attachment paths (which live in the runner
// container, not in the API container's filesystem).
const gmailMcpHandler = createGmailMcpHandler({
  exec: (agentId, command, options) => executionManager.exec(agentId, command, options),
});
app.all('/api/gmail/mcp', authenticateToken, (req, res) => gmailMcpHandler(req, res));

const outlookMcpHandler = createOutlookMcpHandler({
  exec: (agentId, command, options) => executionManager.exec(agentId, command, options),
});
app.all('/api/outlook/mcp', authenticateToken, (req, res) => outlookMcpHandler(req, res));

const gdriveMcpHandler = createGdriveMcpHandler();
app.all('/api/gdrive/mcp', authenticateToken, (req, res) => gdriveMcpHandler(req, res));

const slackMcpHandler = createSlackMcpHandler();
app.all('/api/slack/mcp', authenticateToken, (req, res) => slackMcpHandler(req, res));

const jiraMcpHandler = createJiraMcpHandler();
app.all('/api/jira/mcp', authenticateToken, (req, res) => jiraMcpHandler(req, res));

const wordpressMcpHandler = createWordPressMcpHandler();
app.all('/api/wordpress/mcp', authenticateToken, (req, res) => wordpressMcpHandler(req, res));

const githubMcpHandler = createGitHubMcpHandler();
app.all('/api/github/mcp', authenticateToken, (req, res) => githubMcpHandler(req, res));

const s3McpHandler = createS3McpHandler();
app.all('/api/s3/mcp', authenticateToken, (req, res) => s3McpHandler(req, res));

const codeIndexMcpHandler = createCodeIndexMcpHandler(codeIndexService);
app.all('/api/code-index/mcp', authenticateToken, (req, res) => codeIndexMcpHandler(req, res));

const gandiDnsMcpHandler = createGandiDnsMcpHandler(mcpManager);
app.all('/api/gandi-dns/mcp', authenticateToken, (req, res) => gandiDnsMcpHandler(req, res));

const autoLearnMcpHandler = createAutoLearnMcpHandler();
app.all('/api/auto-learn/mcp', authenticateToken, (req, res) => autoLearnMcpHandler(req, res));

const browserMcpHandler = createBrowserMcpHandler();
app.all('/api/browser/mcp', authenticateToken, (req, res) => browserMcpHandler(req, res));

// Internal Swarm API MCP endpoint (JWT auth — used by agents via mcpManager)
const swarmApiMcpInternalHandler = createSwarmApiMcpHandler(agentManager);
app.all('/api/swarm-api/mcp', authenticateToken, (req, res) => swarmApiMcpInternalHandler(req, res));

// External Swarm API — secured via API key (Bearer token)
const swarmApiMcpHandler = createSwarmApiMcpHandler(agentManager);
app.all('/api/swarm/mcp', authenticateApiKey, (req, res) => swarmApiMcpHandler(req, res));
// Legacy SSE transport for older MCP clients (GET /sse → stream, POST /messages → JSON-RPC)
const { sseHandler, messagesHandler } = createSwarmApiMcpSseHandlers(agentManager);
app.get('/api/swarm/mcp/sse', authenticateApiKey, (req, res) => sseHandler(req, res));
app.post('/api/swarm/mcp/messages', authenticateApiKey, (req, res) => messagesHandler(req, res));
app.use('/api/swarm', authenticateApiKey, swarmApiRoutes(agentManager));

// Public liveness probe — returns minimal info for health checks
app.get('/api/health', (req, res) => {
  const dbConnected = isDatabaseConnected();
  res.json({
    status: 'ok',
    database: dbConnected ? 'connected' : 'unavailable',
  });
});

// Detailed status — requires authentication
app.get('/api/health/details', authenticateToken, (req, res) => {
  const allAgents = Array.from(agentManager.agents.values());
  const enabled = allAgents.filter(a => a.enabled !== false);
  const projectCounts = {};
  let unassigned = 0;
  for (const a of enabled) {
    if (a.project) {
      projectCounts[a.project] = (projectCounts[a.project] || 0) + 1;
    } else {
      unassigned++;
    }
  }
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    agents: {
      total: allAgents.length,
      enabled: enabled.length,
      busy: enabled.filter(a => a.status === 'busy').length,
      idle: enabled.filter(a => a.status === 'idle').length,
      error: enabled.filter(a => a.status === 'error').length,
    },
    projects: {
      active: Object.keys(projectCounts).length,
      distribution: projectCounts,
      unassigned,
    }
  });
});

io.use((socket, next) => {
  // Validate Origin header to prevent cross-site WebSocket hijacking
  const origin = socket.handshake.headers.origin;
  if (origin && !isOriginAllowed(origin, corsOrigins)) {
    logRejectedOrigin(origin, 'ws');
    return next(new Error('Origin not allowed'));
  }

  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  import('jsonwebtoken').then(jwt => {
    try {
      const decoded = jwt.default.verify(token, getJwtSecret());
      (socket as any).user = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });
});

setupSocketHandlers(io, agentManager);

const PORT = process.env.PORT || 3001;

async function start() {
  validateProductionSecrets();
  validateCorsConfig();
  await initDatabase();
  await ensureAdminSeeded();
  await ensureApiKeysTable();
  await mcpManager.loadFromDatabase();
  await mcpManager.seedDefaults(BUILTIN_MCP_SERVERS);
  skillManager.setMcpResolver((id) => mcpManager.getById(id));
  await skillManager.loadFromDatabase();
  await skillManager.seedDefaults(BUILTIN_SKILLS);
  await agentManager.loadFromDatabase();
  agentManager.startTaskLoop();

  await executionManager.cleanupOrphans();

  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, () => {
      console.log(`\\n🐝 Agent Swarm Server running on http://localhost:${PORT}`);
      console.log('   WebSocket ready for connections');
      resolve();
    });
  });

  // Connect MCP servers after HTTP is listening, so internal MCPs
  // (code-index, onedrive) can reach their localhost endpoints.
  await mcpManager.connectAll();
}

async function shutdown() {
  console.log('\\n🛑 Shutting down — disconnecting MCP servers, destroying sandbox containers...');
  agentManager.stopTaskLoop();
  await mcpManager.disconnectAll();
  await executionManager.destroyAll();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Prevent uncaught errors from MCP transports or other async sources from crashing the service
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [Process] Unhandled promise rejection (service continues):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('💥 [Process] Uncaught exception (service continues):', err);
});

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});