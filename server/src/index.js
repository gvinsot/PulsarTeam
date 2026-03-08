import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { authRouter, authenticateToken, getJwtSecret } from './middleware/auth.js';
import { agentRoutes } from './routes/agents.js';
import { templateRoutes } from './routes/templates.js';
import { projectRoutes } from './routes/projects.js';
import { codeIndexRoutes } from './routes/codeIndex.js';
import { setupSocketHandlers } from './ws/socketHandler.js';
import { AgentManager } from './services/agentManager.js';
import { SkillManager } from './services/skillManager.js';
import { SandboxManager } from './services/sandboxManager.js';
import { MCPManager } from './services/mcpManager.js';
import { CodeIndexService } from './services/codeIndexService.js';
import { createCodeIndexMcpHandler } from './services/codeIndexMcp.js';
import { pluginRoutes } from './routes/plugins.js';
import { mcpServerRoutes } from './routes/mcpServers.js';
import { realtimeRoutes } from './routes/realtime.js';
import { leaderToolsRoutes } from './routes/leaderTools.js';
import { BUILTIN_SKILLS } from './data/skills.js';
import { BUILTIN_MCP_SERVERS } from './data/mcpServers.js';
import { initDatabase } from './services/database.js';
import { onedriveRoutes } from './routes/onedrive.js';
import { createOneDriveMcpHandler } from './services/onedriveMcp.js';

const app = express();
const httpServer = createServer(app);

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000'];

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "connect-src 'self' wss: ws: https://api.openai.com https://fonts.googleapis.com https://fonts.gstatic.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true
  }
});

const skillManager = new SkillManager();
const sandboxManager = new SandboxManager();
const mcpManager = new MCPManager();
const codeIndexService = new CodeIndexService();
const agentManager = new AgentManager(io, skillManager, sandboxManager, mcpManager);

app.use(cors({
  origin: corsOrigins,
  credentials: true
}));

// Security headers — defense-in-depth when accessed without a reverse proxy
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '1mb' }));

// Global API rate limiter — 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

app.use('/api/auth', authRouter);

app.use('/api/agents', authenticateToken, agentRoutes(agentManager));
app.use('/api/templates', authenticateToken, templateRoutes());
app.use('/api/projects', authenticateToken, projectRoutes());
app.use('/api/code-index', authenticateToken, codeIndexRoutes(codeIndexService));
app.use('/api/plugins', authenticateToken, pluginRoutes(skillManager, mcpManager));
// Backward compatibility
app.use('/api/skills', authenticateToken, pluginRoutes(skillManager, mcpManager));
app.use('/api/mcp-servers', authenticateToken, mcpServerRoutes(mcpManager));
app.use('/api/onedrive', authenticateToken, onedriveRoutes());
app.use('/api/realtime', authenticateToken, realtimeRoutes(agentManager));
app.use('/api/leader-tools', authenticateToken, leaderToolsRoutes(agentManager));

// Internal MCP endpoints (used by the MCP client for tool discovery and calls)
const onedriveMcpHandler = createOneDriveMcpHandler();
app.all('/api/onedrive/mcp', authenticateToken, (req, res) => onedriveMcpHandler(req, res));

const codeIndexMcpHandler = createCodeIndexMcpHandler(codeIndexService);
app.all('/api/code-index/mcp', authenticateToken, (req, res) => codeIndexMcpHandler(req, res));

// Public liveness probe — returns minimal info for health checks
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
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
  if (origin && !corsOrigins.includes(origin)) {
    console.warn(`WebSocket connection rejected: origin "${origin}" not in allowed list`);
    return next(new Error('Origin not allowed'));
  }

  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  import('jsonwebtoken').then(jwt => {
    try {
      const decoded = jwt.default.verify(token, getJwtSecret());
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });
});

setupSocketHandlers(io, agentManager);

const PORT = process.env.PORT || 3001;

async function start() {
  await initDatabase();
  await skillManager.loadFromDatabase();
  await skillManager.seedDefaults(BUILTIN_SKILLS);
  await mcpManager.loadFromDatabase();
  await mcpManager.seedDefaults(BUILTIN_MCP_SERVERS);
  await mcpManager.connectAll();
  await agentManager.loadFromDatabase();
  agentManager.startTaskLoop();

  await sandboxManager.cleanupOrphans();

  httpServer.listen(PORT, () => {
    console.log(`\\n🐝 Agent Swarm Server running on http://localhost:${PORT}`);
    console.log('   WebSocket ready for connections');
  });
}

async function shutdown() {
  console.log('\\n🛑 Shutting down — disconnecting MCP servers, destroying sandbox containers...');
  agentManager.stopTaskLoop();
  await mcpManager.disconnectAll();
  await sandboxManager.destroyAll();
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