import express from 'express';
import { z } from 'zod';

// Schema for creating a new agent
const createAgentSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  endpoint: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  instructions: z.string().max(50000).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(1000000).optional(),
  contextLength: z.number().int().min(0).optional(),
  todoList: z.array(z.any()).optional(),
  ragDocuments: z.array(z.any()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  handoffTargets: z.array(z.string()).optional(),
  project: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  isLeader: z.boolean().optional(),
  isVoice: z.boolean().optional(),
  isReasoning: z.boolean().optional(),
  voice: z.string().max(100).optional(),
  template: z.string().max(200).nullable().optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(50).optional(),
});

// Schema for updating an agent (all fields optional)
const updateAgentSchema = createAgentSchema.partial();

// Mask sensitive fields before sending agent data to the client
function sanitizeAgent(agent) {
  if (!agent) return agent;
  const { apiKey, ...safe } = agent;
  if (apiKey) {
    safe.apiKey = apiKey.length > 8 ? apiKey.slice(0, 4) + '...' + apiKey.slice(-4) : '••••';
  }
  return safe;
}

export function agentRoutes(agentManager) {
  const router = express.Router();

  // List all agents
  router.get('/', (req, res) => {
    res.json(agentManager.getAll().map(sanitizeAgent));
  });

  // Get lightweight status for ALL enabled agents (includes project + currentTask)
  // Much lighter than GET / which returns full agent data with conversation history
  // Optional query param: ?project=ProjectName to filter by project
  router.get('/statuses', (req, res) => {
    const { project } = req.query;
    let statuses = agentManager.getAllStatuses();
    if (project) {
      const lowerProject = project.toLowerCase();
      statuses = statuses.filter(s =>
        (s.project || '').toLowerCase() === lowerProject
      );
    }
    res.json(statuses);
  });

  // Get agents working on a specific project
  router.get('/by-project/:project', (req, res) => {
    const agents = agentManager.getAgentsByProject(req.params.project);
    res.json(agents);
  });

  // Get project summary: all projects with their agent counts and assignments
  router.get('/project-summary', (req, res) => {
    res.json(agentManager.getProjectSummary());
  });

  // Get comprehensive swarm status with project assignments
  router.get('/swarm-status', (req, res) => {
    res.json(agentManager.getSwarmStatus());
  });

  // Get single agent detailed status (lightweight, includes project + currentTask)
  router.get('/:id/status', (req, res) => {
    const status = agentManager.getAgentStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'Agent not found' });
    res.json(status);
  });

  // Get single agent
  router.get('/:id', (req, res) => {
    const agent = agentManager.getById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(sanitizeAgent(agent));
  });

  // Create agent
  router.post('/', (req, res) => {
    try {
      const parsed = createAgentSchema.parse(req.body);
      const agent = agentManager.create(parsed);
      res.status(201).json(agent);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Update agent
  router.put('/:id', (req, res) => {
    try {
      const parsed = updateAgentSchema.parse(req.body);
      const agent = agentManager.update(req.params.id, parsed);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(agent);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Delete agent
  router.delete('/:id', (req, res) => {
    const success = agentManager.delete(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Send message to agent
  router.post('/:id/chat', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });
      if (typeof message !== 'string' || message.length > 50000) {
        return res.status(400).json({ error: 'Message must be a string under 50KB' });
      }

      const response = await agentManager.sendMessage(req.params.id, message);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get conversation history
  router.get('/:id/history', (req, res) => {
    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent.conversationHistory);
  });

  // Clear conversation history
  router.delete('/:id/history', (req, res) => {
    const success = agentManager.clearHistory(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Truncate conversation history after a specific message index
  router.delete('/:id/history/after/:index', (req, res) => {
    const result = agentManager.truncateHistory(req.params.id, req.params.index);
    if (result === null) return res.status(404).json({ error: 'Agent not found or invalid index' });
    res.json(result);
  });

  // Clear action logs
  router.delete('/:id/action-logs', (req, res) => {
    const success = agentManager.clearActionLogs(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Handoff between agents
  router.post('/:id/handoff', async (req, res) => {
    try {
      const { targetAgentId, context } = req.body;
      if (!targetAgentId || !context) {
        return res.status(400).json({ error: 'targetAgentId and context required' });
      }
      const response = await agentManager.handoff(req.params.id, targetAgentId, context);
      res.json({ response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Broadcast message to all agents
  router.post('/broadcast/all', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      const results = await agentManager.broadcastMessage(message);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update project for all agents
  router.put('/project/all', (req, res) => {
    try {
      const { project } = req.body;
      if (project === undefined) return res.status(400).json({ error: 'Project required' });
      const updated = agentManager.updateAllProjects(project);
      res.json({ success: true, count: updated.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Todo endpoints ──────────────────────────────────────────────────
  router.post('/:id/todos', (req, res) => {
    const { text, project, source } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Auto-assign agent to project if provided and different from current
    if (project && project !== agent.project) {
      agentManager.update(agent.id, { project });
    }
    const resolvedSource = source || { type: 'user' };
    const todo = agentManager.addTodo(req.params.id, text, project, resolvedSource);
    if (!todo) return res.status(404).json({ error: 'Agent not found' });
    res.status(201).json(todo);
  });

  router.patch('/:id/todos/:todoId', (req, res) => {
    const { status } = req.body || {};
    let todo;
    if (status) {
      todo = agentManager.setTodoStatus(req.params.id, req.params.todoId, status);
    } else {
      todo = agentManager.toggleTodo(req.params.id, req.params.todoId);
    }
    if (!todo) return res.status(404).json({ error: 'Not found' });
    res.json(todo);
  });

  router.delete('/:id/todos', (req, res) => {
    const success = agentManager.clearTodos(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  router.delete('/:id/todos/:todoId', (req, res) => {
    const success = agentManager.deleteTodo(req.params.id, req.params.todoId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  // ── RAG Document endpoints ─────────────────────────────────────────
  router.post('/:id/rag', (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'Name and content required' });
    const doc = agentManager.addRagDocument(req.params.id, name, content);
    if (!doc) return res.status(404).json({ error: 'Agent not found' });
    res.status(201).json(doc);
  });

  router.delete('/:id/rag/:docId', (req, res) => {
    const success = agentManager.deleteRagDocument(req.params.id, req.params.docId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  // ── Plugin (skill) assignment endpoints ──────────────────────────
  const pluginAssignHandler = (req, res) => {
    const pluginId = req.body.skillId || req.body.pluginId;
    if (!pluginId) return res.status(400).json({ error: 'pluginId required' });
    const result = agentManager.assignSkill(req.params.id, pluginId);
    if (result === null) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, plugins: result });
  };
  const pluginRemoveHandler = (req, res) => {
    const pluginId = req.params.skillId || req.params.pluginId;
    const success = agentManager.removeSkill(req.params.id, pluginId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  };
  router.post('/:id/plugins', pluginAssignHandler);
  router.delete('/:id/plugins/:pluginId', pluginRemoveHandler);
  // Backward compatibility
  router.post('/:id/skills', pluginAssignHandler);
  router.delete('/:id/skills/:skillId', pluginRemoveHandler);

  // ── MCP server assignment endpoints (backward compat) ───────────
  router.post('/:id/mcp-servers', (req, res) => {
    const { serverId } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId required' });
    const result = agentManager.assignMcpServer(req.params.id, serverId);
    if (result === null) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, mcpServers: result });
  });

  router.delete('/:id/mcp-servers/:serverId', (req, res) => {
    const success = agentManager.removeMcpServer(req.params.id, req.params.serverId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  return router;
}