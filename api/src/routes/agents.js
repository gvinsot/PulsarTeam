import express from 'express';
import { z } from 'zod';
import { globalTaskStore } from '../services/globalTaskStore.js';
import { getWorkflowForBoard } from '../services/configManager.js';
import { getAllBoards } from '../services/database.js';

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
  costPerInputToken: z.number().min(0).nullable().optional(),
  costPerOutputToken: z.number().min(0).nullable().optional(),
  copyApiKeyFromAgent: z.string().uuid().optional(),
  llmConfigId: z.string().max(200).nullable().optional(),
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

  // List agents (filtered by user — admin sees all, others see own + unowned)
  router.get('/', (req, res) => {
    const agents = agentManager.getAllForUser(req.user.userId, req.user.role);
    res.json(agents.map(sanitizeAgent));
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

  // Create agent (basic users cannot create)
  router.post('/', async (req, res) => {
    if (req.user.role === 'basic') {
      return res.status(403).json({ error: 'Basic users cannot create agents' });
    }
    try {
      const parsed = createAgentSchema.parse(req.body);
      parsed.ownerId = req.user.userId;
      const agent = await agentManager.create(parsed);
      res.status(201).json(agent);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Update agent (basic users cannot edit settings, ownership check for non-admin)
  router.put('/:id', async (req, res) => {
    if (req.user.role === 'basic') {
      return res.status(403).json({ error: 'Basic users cannot modify agents' });
    }
    // Non-admin users can only update their own agents
    if (req.user.role !== 'admin') {
      const existing = agentManager.agents.get(req.params.id);
      if (existing && existing.ownerId && existing.ownerId !== req.user.userId) {
        return res.status(403).json({ error: 'You can only modify your own agents' });
      }
    }
    try {
      const parsed = updateAgentSchema.parse(req.body);
      const agent = await agentManager.update(req.params.id, parsed);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(agent);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Delete agent (basic users cannot delete, ownership check for non-admin)
  router.delete('/:id', async (req, res) => {
    if (req.user.role === 'basic') {
      return res.status(403).json({ error: 'Basic users cannot delete agents' });
    }
    if (req.user.role !== 'admin') {
      const existing = agentManager.agents.get(req.params.id);
      if (existing && existing.ownerId && existing.ownerId !== req.user.userId) {
        return res.status(403).json({ error: 'You can only delete your own agents' });
      }
    }
    const success = await agentManager.delete(req.params.id);
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
  router.put('/project/all', async (req, res) => {
    try {
      const { project } = req.body;
      if (project === undefined) return res.status(400).json({ error: 'Project required' });
      const updated = await agentManager.updateAllProjects(project);
      res.json({ success: true, count: updated.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Task endpoints ──────────────────────────────────────────────────────
  router.post('/:id/tasks', async (req, res) => {
    try {
      const { text, project, source, status, boardId, recurrence } = req.body;
      if (!text) return res.status(400).json({ error: 'Text required' });
      const agent = agentManager.agents.get(req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      // Auto-assign agent to project if provided and different from current
      if (project && project !== agent.project) {
        agentManager.update(agent.id, { project });
      }
      const resolvedSource = source || { type: 'user' };
      let resolvedStatus = status && typeof status === 'string' ? status : undefined;
      let resolvedBoardId = boardId || undefined;

      // When no boardId is provided, auto-assign the first available board
      // so the task is visible and gets the correct default status
      if (!resolvedBoardId) {
        try {
          const boards = await getAllBoards();
          if (boards.length > 0) {
            resolvedBoardId = boards[0].id;
          }
        } catch { /* no board available */ }
      }

      // When no status is provided, resolve default from the board's first column
      // so the task lands in the correct column (not hardcoded 'pending')
      if (!resolvedStatus && resolvedBoardId) {
        try {
          const wf = await getWorkflowForBoard(resolvedBoardId);
          if (wf?.columns?.length > 0) {
            resolvedStatus = wf.columns[0].id;
          }
        } catch { /* fall through to addTask default */ }
      }

      console.log(`[CreateTask] POST /:id/tasks — input: status="${status}", boardId="${boardId}" → resolved: status="${resolvedStatus}", boardId="${resolvedBoardId}" text="${(text || '').slice(0, 60)}"`);
      const task = agentManager.addTask(req.params.id, text, project, resolvedSource, resolvedStatus, { boardId: resolvedBoardId, recurrence: recurrence || undefined });
      if (!task) return res.status(404).json({ error: 'Agent not found' });
      console.log(`[CreateTask] Task created: id=${task.id} status="${task.status}" boardId="${task.boardId}"`);
      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id/tasks/:taskId', (req, res) => {
    try {
    const { status, text, project, source, recurrence } = req.body || {};
    // Source is immutable once set at creation — reject any attempt to change it
    if (source !== undefined) {
      return res.status(400).json({ error: 'Source cannot be modified after creation' });
    }
    // Capture old status before any update
    const agent = agentManager.agents.get(req.params.id);
    const oldTask = agent?.todoList?.find(t => t.id === req.params.taskId);
    const oldStatus = oldTask?.status;

    // Handle recurrence update
    if (recurrence !== undefined && oldTask) {
      agentManager.updateTaskRecurrence(req.params.id, req.params.taskId, recurrence);
    }

    let task;
    if (text !== undefined) {
      if (!text.trim()) return res.status(400).json({ error: 'Text cannot be empty' });
      task = agentManager.updateTaskText(req.params.id, req.params.taskId, text.trim());
    } else if (project !== undefined) {
      task = agentManager.updateTaskProject(req.params.id, req.params.taskId, project || null);
    } else if (status) {
      task = agentManager.setTaskStatus(req.params.id, req.params.taskId, status);
    } else if (recurrence !== undefined) {
      // If only recurrence was sent, return the updated task
      task = agent?.todoList?.find(t => t.id === req.params.taskId);
    } else {
      task = agentManager.toggleTask(req.params.id, req.params.taskId);
    }
    if (!task) return res.status(404).json({ error: 'Not found' });
    // If task moved OUT of in_progress, stop the agent
    if (oldStatus === 'in_progress' && status && status !== 'in_progress' && agent?.status === 'busy') {
      console.log(`\u{1F6D1} [Task] Task moved from in_progress to ${status} — stopping agent "${agent.name}"`);
      agentManager.stopAgent(req.params.id);
    }
    res.json(task);
    } catch (err) {
      console.error(`[Route] Error updating task ${req.params.taskId}:`, err.message);
      try {
        agentManager.setTaskStatus(req.params.id, req.params.taskId, 'error', { skipAutoRefine: true, by: 'system' });
        const errorAgent = agentManager.agents.get(req.params.id);
        const errorTask = errorAgent?.todoList?.find(t => t.id === req.params.taskId);
        if (errorTask) errorTask.error = err.message;
      } catch (_) { /* best effort */ }
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id/tasks', (req, res) => {
    const success = agentManager.clearTasks(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  router.delete('/:id/tasks/:taskId', (req, res) => {
    // Check if deleting an in_progress task
    const agent = agentManager.agents.get(req.params.id);
    const taskToDelete = agent?.todoList?.find(t => t.id === req.params.taskId);
    const wasInProgress = taskToDelete?.status === 'in_progress';
    
    const success = agentManager.deleteTask(req.params.id, req.params.taskId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    // If deleted task was in_progress, stop the agent
    if (wasInProgress && agent?.status === 'busy') {
      console.log(`\u{1F6D1} [Task] Task deleted while in_progress \u2014 stopping agent "${agent.name}"`);
      agentManager.stopAgent(req.params.id);
    }
    res.json({ success: true });
  });

  router.post('/:id/tasks/:taskId/transfer', (req, res) => {
    const { targetAgentId } = req.body;
    if (!targetAgentId) return res.status(400).json({ error: 'targetAgentId required' });
    const task = agentManager.transferTask(req.params.id, req.params.taskId, targetAgentId);
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.status(201).json(task);
  });

  router.patch('/:id/tasks/:taskId/assignee', (req, res) => {
    const { assigneeId } = req.body;
    // assigneeId can be null to unassign
    if (assigneeId && !agentManager.agents.get(assigneeId)) {
      return res.status(404).json({ error: 'Assignee agent not found' });
    }
    const task = agentManager.setTaskAssignee(req.params.id, req.params.taskId, assigneeId || null);
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.json(task);
  });

  // ── Task commit association ────────────────────────────────────────
  router.post('/:id/tasks/:taskId/commits', (req, res) => {
    const { hash, message } = req.body;
    if (!hash) return res.status(400).json({ error: 'Commit hash required' });
    const task = agentManager.addTaskCommit(req.params.id, req.params.taskId, hash, message || '');
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.status(201).json(task);
  });

  router.delete('/:id/tasks/:taskId/commits/:hash', (req, res) => {
    const task = agentManager.removeTaskCommit(req.params.id, req.params.taskId, req.params.hash);
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json(task);
  });

  // ── On-demand AI refinement (synchronous — waits for result) ────────
  router.post('/:id/tasks/:taskId/refine', async (req, res) => {
    const { refineAgentId } = req.body;
    if (!refineAgentId) return res.status(400).json({ error: 'refineAgentId required' });

    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const task = agent.todoList.find(t => t.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const refineAgent = agentManager.agents.get(refineAgentId);
    if (!refineAgent) return res.status(404).json({ error: 'Refine agent not found' });
    if (refineAgent.status !== 'idle') return res.status(409).json({ error: 'Agent is busy' });

    try {
      const prompt = `Refine the following task description. Make it clearer, more actionable, and add acceptance criteria if missing.\n\nTask: ${task.text}\n\nReply ONLY with the improved description (no preamble, no explanation).`;
      const result = await agentManager.sendMessage(refineAgentId, prompt, () => {});
      const refined = (result?.content || result || '').trim();
      if (refined) {
        agentManager.updateTaskText(req.params.id, req.params.taskId, refined);
      }
      res.json({ success: true, text: refined });
    } catch (err) {
      console.error(`[Refine] Error:`, err.message);
      res.status(500).json({ error: err.message });
    }
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

// ── Task History & Stats ──────────────────────────────────────────────────────

router.get("/tasks/stats", (req, res) => {
  const { project } = req.query;
  const stats = agentManager.getTaskStats(project || null);
  res.json(stats);
});

router.get("/tasks/stats/timeseries", (req, res) => {
  const { project, days } = req.query;
  const d = Math.min(Math.max(parseInt(days) || 30, 1), 365);
  const timeseries = agentManager.getTaskTimeSeries(project || null, d);
  res.json(timeseries);
});

router.get("/tasks/:id/history", (req, res) => {
  const history = globalTaskStore.getHistory(req.params.id);
  if (!history) return res.status(404).json({ error: "Not found" });
  res.json(history);
});
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