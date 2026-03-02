import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { authRouter, authenticateToken } from './middleware/auth.js';
import { agentRoutes } from './routes/agents.js';
import { templateRoutes } from './routes/templates.js';
import { projectRoutes } from './routes/projects.js';
import { setupSocketHandlers } from './ws/socketHandler.js';
import { AgentManager } from './services/agentManager.js';
import { SkillManager } from './services/skillManager.js';
import { SandboxManager } from './services/sandboxManager.js';
import { MCPManager } from './services/mcpManager.js';
import { pluginRoutes } from './routes/plugins.js';
import { mcpServerRoutes } from './routes/mcpServers.js';
import { realtimeRoutes } from './routes/realtime.js';
import { leaderToolsRoutes } from './routes/leaderTools.js';
import { BUILTIN_SKILLS } from './data/skills.js';
import { BUILTIN_MCP_SERVERS } from './data/mcpServers.js';
import { initDatabase } from './services/database.js';

const app = express();
const httpServer = createServer(app);

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000'];

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
const agentManager = new AgentManager(io, skillManager, sandboxManager, mcpManager);

app.use(cors({
  origin: corsOrigins,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRouter);

app.use('/api/agents', authenticateToken, agentRoutes(agentManager));
app.use('/api/templates', authenticateToken, templateRoutes());
app.use('/api/projects', authenticateToken, projectRoutes());
app.use('/api/plugins', authenticateToken, pluginRoutes(skillManager, mcpManager));
// Backward compatibility
app.use('/api/skills', authenticateToken, pluginRoutes(skillManager, mcpManager));
app.use('/api/mcp-servers', authenticateToken, mcpServerRoutes(mcpManager));
app.use('/api/realtime', authenticateToken, realtimeRoutes(agentManager));
app.use('/api/leader-tools', authenticateToken, leaderToolsRoutes(agentManager));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), agentCount: agentManager.getAll().length });
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  import('jsonwebtoken').then(jwt => {
    try {
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
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
    console.log(`   WebSocket ready for connections`);
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

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});