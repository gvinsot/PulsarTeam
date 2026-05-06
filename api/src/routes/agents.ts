import express from 'express';
import { z } from 'zod';
import { globalTaskStore } from '../services/globalTaskStore.js';
import { getWorkflowForBoard } from '../services/configManager.js';
import { getAllBoards, getBoardsByUser, saveTaskToDb, getReposForBoard } from '../services/database.js';
import { stripToolCalls } from '../services/workflow/index.js';
import { setTaskSignal } from '../services/agentManager/tasks.js';

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
  mcpAuth: z.record(z.string(), z.object({
    apiKey: z.string().max(500).optional(),
  })).optional(),
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
  boardId: z.string().uuid().nullable().optional(),
  permissions: z.object({
    linuxUser: z.object({
      runAsRoot: z.boolean().optional(),
    }).optional(),
    network: z.object({
      internetAccess: z.boolean().optional(),
      allowedDomains: z.array(z.string().max(200)).optional(),
    }).optional(),
    filesystem: z.object({
      readAccess: z.boolean().optional(),
      writeAccess: z.boolean().optional(),
      restrictedPaths: z.array(z.string().max(500)).optional(),
    }).optional(),
    execution: z.object({
      shellAccess: z.boolean().optional(),
      dangerousSkipPermissions: z.boolean().optional(),
    }).optional(),
  }).optional(),
  credentials: z.record(z.string().max(100), z.string().max(2000)).optional(),
  toolHooks: z.object({
    enabled: z.boolean().optional(),
    rules: z.array(z.object({
      id: z.string().max(100),
      name: z.string().max(200),
      enabled: z.boolean(),
      pattern: z.string().max(2000),
      action: z.enum(['block', 'warn']),
      tools: z.array(z.string().max(50)),
      description: z.string().max(500).optional(),
    })).optional(),
  }).optional(),
  // 'coder' is a deprecated alias for 'claudecode' (kept for backward compat with stored agents)
  runner: z.enum(['sandbox', 'claudecode', 'coder', 'openclaw', 'hermes', 'opencode']).optional(),
});

// Schema for updating an agent (all fields optional)
const updateAgentSchema = createAgentSchema.partial().extend({
  ownerId: z.string().uuid().nullable().optional(),
  boardId: z.string().uuid().nullable().optional(),
});

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

  // ── Resolve user's accessible board IDs (own boards + shared boards + default) ──
  async function getUserBoardIds(userId: string): Promise<Set<string>> {
    try {
      const boards = await getBoardsByUser(userId);
      return new Set(boards.map(b => b.id));
    } catch {
      return new Set();
    }
  }

  // ── Board-based access guard: users can access agents on their boards or unscoped agents ──
  async function requireAgentAccess(req, res, next) {
    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (req.user.role === 'admin') return next();
    // Agents without a board are accessible to everyone
    if (!agent.boardId) return next();
    // Check if user has access to the agent's board
    const userBoardIds = await getUserBoardIds(req.user.userId);
    if (!userBoardIds.has(agent.boardId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  }

  // List agents (filtered by board access — each user sees agents on their boards + unscoped)
  router.get('/', async (req, res) => {
    const userBoardIds = await getUserBoardIds(req.user.userId);
    const agents = agentManager.getAllForUser(req.user.userId, req.user.role, userBoardIds);
    res.json(agents.map(sanitizeAgent));
  });

  // Get lightweight status for ALL enabled agents (includes project + currentTask)
  // Much lighter than GET / which returns full agent data with conversation history
  // Optional query param: ?project=ProjectName to filter by project
  router.get('/statuses', async (req, res) => {
    const { project } = req.query;
    const userBoardIds = await getUserBoardIds(req.user.userId);
    let statuses = agentManager.getAllStatuses(req.user.userId, req.user.role, userBoardIds);
    if (project) {
      const lowerProject = (project as string).toLowerCase();
      statuses = statuses.filter(s =>
        (s.project || '').toLowerCase() === lowerProject
      );
    }
    res.json(statuses);
  });

  // Get agents working on a specific project
  router.get('/by-project/:project', async (req, res) => {
    const userBoardIds = await getUserBoardIds(req.user.userId);
    const agents = agentManager.getAgentsByProject(req.params.project, req.user.userId, req.user.role, userBoardIds);
    res.json(agents);
  });

  // Get project summary: all projects with their agent counts and assignments
  router.get('/project-summary', async (req, res) => {
    const userBoardIds = await getUserBoardIds(req.user.userId);
    res.json(agentManager.getProjectSummary(req.user.userId, req.user.role, userBoardIds));
  });

  // Get comprehensive swarm status with project assignments
  router.get('/swarm-status', async (req, res) => {
    const userBoardIds = await getUserBoardIds(req.user.userId);
    res.json(agentManager.getSwarmStatus(req.user.userId, req.user.role, userBoardIds));
  });

  // ── Admin: reset instructions for all agents of a role to default template ──
  router.post('/reset-instructions/:role', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { role } = req.params;
    const result = await agentManager.resetInstructionsByRole(role);
    if (result.error === 'no_template') {
      return res.status(404).json({ error: `No default template found for role "${role}"` });
    }
    res.json({ success: true, role, resetCount: result.reset.length, agentIds: result.reset });
  });

  // Get single agent detailed status (lightweight, includes project + currentTask)
  router.get('/:id/status', requireAgentAccess, (req, res) => {
    const status = agentManager.getAgentStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'Agent not found' });
    res.json(status);
  });

  // Get single agent
  router.get('/:id', requireAgentAccess, (req, res) => {
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
      const parsed: any = createAgentSchema.parse(req.body);
      // Agents are scoped to a board (not a user). The boardId comes from the request body.
      // We still set ownerId for backward compat / token tracking.
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

  // Update agent (basic users cannot edit settings, ownership enforced by middleware)
  router.put('/:id', requireAgentAccess, async (req, res) => {
    if (req.user.role === 'basic') {
      return res.status(403).json({ error: 'Basic users cannot modify agents' });
    }
    try {
      const parsed = updateAgentSchema.parse(req.body);
      // Only admins can change ownership
      if ('ownerId' in parsed && req.user.role !== 'admin') {
        delete parsed.ownerId;
      }
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

  // Delete agent (basic users cannot delete, ownership enforced by middleware)
  router.delete('/:id', requireAgentAccess, async (req, res) => {
    if (req.user.role === 'basic') {
      return res.status(403).json({ error: 'Basic users cannot delete agents' });
    }
    const success = await agentManager.delete(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Send message to agent
  router.post('/:id/chat', requireAgentAccess, async (req, res) => {
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
  router.get('/:id/history', requireAgentAccess, (req, res) => {
    const agent = agentManager.agents.get(req.params.id);
    res.json(agent.conversationHistory);
  });

  // Stop agent
  router.post('/:id/stop', requireAgentAccess, (req, res) => {
    const stopped = agentManager.stopAgent(req.params.id);
    if (stopped === false) return res.status(404).json({ error: 'Agent not found' });
    res.json({ ok: true, stopped });
  });

  // Clear conversation history
  router.delete('/:id/history', requireAgentAccess, (req, res) => {
    const success = agentManager.clearHistory(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Truncate conversation history after a specific message index
  router.delete('/:id/history/after/:index', requireAgentAccess, (req, res) => {
    const result = agentManager.truncateHistory(req.params.id, req.params.index);
    if (result === null) return res.status(404).json({ error: 'Agent not found or invalid index' });
    res.json(result);
  });

  // Clear action logs
  router.delete('/:id/action-logs', requireAgentAccess, (req, res) => {
    const success = agentManager.clearActionLogs(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Handoff between agents
  router.post('/:id/handoff', requireAgentAccess, async (req, res) => {
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

      const userBoardIds = await getUserBoardIds(req.user.userId);
      const visibleIds = new Set(agentManager.getAllForUser(req.user.userId, req.user.role, userBoardIds).map(a => a.id));
      const results = await agentManager.broadcastMessage(message, null, visibleIds);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update project for all user's agents
  router.put('/project/all', async (req, res) => {
    try {
      const { project } = req.body;
      if (project === undefined) return res.status(400).json({ error: 'Project required' });
      const userBoardIds = await getUserBoardIds(req.user.userId);
      const visibleIds = new Set(agentManager.getAllForUser(req.user.userId, req.user.role, userBoardIds).map(a => a.id));
      const updated = await agentManager.updateAllProjects(project, visibleIds);
      res.json({ success: true, count: updated.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Task endpoints ──────────────────────────────────────────────────────
  router.post('/:id/tasks', requireAgentAccess, async (req, res) => {
    try {
      const { text, source, status, boardId, repoId, recurrence, taskType, isManual } = req.body;
      if (!text) return res.status(400).json({ error: 'Text required' });
      const agent = agentManager.agents.get(req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const resolvedSource = source || { type: 'user', name: req.user?.username || undefined };
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
      // so the task lands in the correct column
      if (!resolvedStatus && resolvedBoardId) {
        try {
          const wf = await getWorkflowForBoard(resolvedBoardId);
          if (wf?.columns?.length > 0) {
            resolvedStatus = wf.columns[0].id;
          }
        } catch { /* fall through to addTask default */ }
      }

      // Validate that the chosen repo (if any) belongs to the resolved board
      let resolvedRepoId: string | null = null;
      if (repoId && resolvedBoardId) {
        const boardRepos = await getReposForBoard(resolvedBoardId);
        const match = boardRepos.find(r => r.id === repoId);
        if (!match) return res.status(400).json({ error: 'Repo does not belong to the selected board' });
        resolvedRepoId = match.id;
      }

      console.log(`[CreateTask] POST /:id/tasks — input: status="${status}", boardId="${boardId}", repoId="${repoId}" → resolved: status="${resolvedStatus}", boardId="${resolvedBoardId}", repoId="${resolvedRepoId}" text="${(text || '').slice(0, 60)}"`);
      const task = agentManager.addTask(req.params.id, text, resolvedSource, resolvedStatus, { boardId: resolvedBoardId, repoId: resolvedRepoId, recurrence: recurrence || undefined, taskType: taskType || undefined, isManual: isManual || false });
      if (!task) return res.status(404).json({ error: 'Agent not found' });
      console.log(`[CreateTask] Task created: id=${task.id} status="${task.status}" boardId="${task.boardId}"`);
      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id/tasks/:taskId', requireAgentAccess, async (req, res) => {
    try {
    const { status, text, title, repoId, source, recurrence, taskType, isManual } = req.body || {};
    // Source is immutable once set at creation — reject any attempt to change it
    if (source !== undefined) {
      return res.status(400).json({ error: 'Source cannot be modified after creation' });
    }
    // Recover from any in-memory drift before reading the task
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    // Capture old status before any update
    const agent = agentManager.agents.get(req.params.id);
    const oldTask = agentManager._getAgentTasks(req.params.id).find(t => t.id === req.params.taskId);

    // When a user changes the task status while it's being executed, stop the agent
    // so it no longer works on this task or receives reminders.
    if (status && status !== oldTask?.status && oldTask?.startedAt && agentManager._isActiveTaskStatus(oldTask.status) && agent?.status === 'busy') {
      agentManager.stopAgent(req.params.id);
      // Signal the reminder loop to exit for this task
      setTaskSignal(req.params.taskId, 'stopped', true);
    }

    // Handle recurrence update
    if (recurrence !== undefined && oldTask) {
      agentManager.updateTaskRecurrence(req.params.id, req.params.taskId, recurrence);
    }

    // Handle taskType update
    if (taskType !== undefined && oldTask) {
      agentManager.updateTaskType(req.params.id, req.params.taskId, taskType || null);
    }

    // Handle isManual update
    if (isManual !== undefined && oldTask) {
      oldTask.isManual = !!isManual;
      saveTaskToDb({ ...oldTask, agentId: req.params.id });
      agentManager._emit('task:updated', { agentId: req.params.id, task: { ...oldTask, agentId: req.params.id } });
    }

    let task;
    if (title !== undefined) {
      task = agentManager.updateTaskTitle(req.params.id, req.params.taskId, title.trim() || null);
    }
    if (text !== undefined) {
      if (!text.trim()) return res.status(400).json({ error: 'Text cannot be empty' });
      task = agentManager.updateTaskText(req.params.id, req.params.taskId, text.trim());
    } else if (repoId !== undefined) {
      // Validate repo belongs to the task's board
      if (repoId) {
        const targetBoardId = oldTask?.boardId;
        if (!targetBoardId) return res.status(400).json({ error: 'Task has no board — cannot assign a repo' });
        const boardRepos = await getReposForBoard(targetBoardId);
        if (!boardRepos.some(r => r.id === repoId)) {
          return res.status(400).json({ error: 'Repo does not belong to the task\'s board' });
        }
      }
      task = agentManager.updateTaskRepo(req.params.id, req.params.taskId, repoId || null);
    } else if (status) {
      task = agentManager.setTaskStatus(req.params.id, req.params.taskId, status);
    } else if (recurrence !== undefined) {
      // If only recurrence was sent, return the updated task
      task = agentManager._getAgentTasks(req.params.id).find(t => t.id === req.params.taskId);
    } else if (taskType !== undefined) {
      // If only taskType was sent, return the updated task
      task = agentManager._getAgentTasks(req.params.id).find(t => t.id === req.params.taskId);
    } else if (isManual !== undefined) {
      task = agentManager._getAgentTasks(req.params.id).find(t => t.id === req.params.taskId);
    } else {
      task = agentManager.toggleTask(req.params.id, req.params.taskId);
    }
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json(task);
    } catch (err) {
      console.error(`[Route] Error updating task ${req.params.taskId}:`, err.message);
      try {
        agentManager.setTaskStatus(req.params.id, req.params.taskId, 'error', { skipAutoRefine: true, by: 'system' });
        const errorAgent = agentManager.agents.get(req.params.id);
        const errorTask = agentManager._getAgentTasks(req.params.id).find(t => t.id === req.params.taskId);
        if (errorTask) errorTask.error = err.message;
      } catch (_) { /* best effort */ }
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id/tasks', requireAgentAccess, (req, res) => {
    const success = agentManager.clearTasks(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  router.delete('/:id/tasks/:taskId', requireAgentAccess, async (req, res) => {
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const agent = agentManager.agents.get(req.params.id);
    const taskToDelete = agentManager._getAgentTasks(req.params.id).find(t => t.id === req.params.taskId);
    // Block deletion of tasks being executed — user must stop the agent first
    if (taskToDelete?.startedAt && agentManager._isActiveTaskStatus(taskToDelete.status) && agent?.status === 'busy') {
      return res.status(409).json({ error: 'Task is being executed. Stop the agent first.' });
    }
    const success = agentManager.deleteTask(req.params.id, req.params.taskId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  router.post('/:id/tasks/:taskId/transfer', requireAgentAccess, async (req, res) => {
    const { targetAgentId } = req.body;
    if (!targetAgentId) return res.status(400).json({ error: 'targetAgentId required' });
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const task = agentManager.transferTask(req.params.id, req.params.taskId, targetAgentId);
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.status(201).json(task);
  });

  router.patch('/:id/tasks/:taskId/assignee', requireAgentAccess, async (req, res) => {
    const { assigneeId } = req.body;
    // assigneeId can be null to unassign
    if (assigneeId && !agentManager.agents.get(assigneeId)) {
      return res.status(404).json({ error: 'Assignee agent not found' });
    }
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const task = agentManager.setTaskAssignee(req.params.id, req.params.taskId, assigneeId || null);
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.json(task);
  });

  // ── Task commit association ────────────────────────────────────────
  router.post('/:id/tasks/:taskId/commits', requireAgentAccess, async (req, res) => {
    const { hash, message } = req.body;
    if (!hash) return res.status(400).json({ error: 'Commit hash required' });
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const task = agentManager.addTaskCommit(req.params.id, req.params.taskId, hash, message || '');
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.status(201).json(task);
  });

  router.delete('/:id/tasks/:taskId/commits/:hash', requireAgentAccess, async (req, res) => {
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const task = agentManager.removeTaskCommit(req.params.id, req.params.taskId, req.params.hash);
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json(task);
  });

  // ── On-demand AI refinement (synchronous — waits for result) ────────
  router.post('/:id/tasks/:taskId/refine', requireAgentAccess, async (req, res) => {
    const { refineAgentId } = req.body;
    if (!refineAgentId) return res.status(400).json({ error: 'refineAgentId required' });

    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const task = agentManager._getAgentTasks(req.params.id).find(t => t.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const refineAgent = agentManager.agents.get(refineAgentId);
    if (!refineAgent) return res.status(404).json({ error: 'Refine agent not found' });
    if (refineAgent.status !== 'idle') return res.status(409).json({ error: 'Agent is busy' });

    try {
      const prompt = `Refine the following task description. Make it clearer, more actionable, and add acceptance criteria if missing.\n\nTask: ${task.text}\n\nReply ONLY with the improved description (no preamble, no explanation).`;
      const result = await agentManager.sendMessage(refineAgentId, prompt, () => {});
      const refined = stripToolCalls((result?.content || result || '').trim());
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
  router.post('/:id/rag', requireAgentAccess, (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'Name and content required' });
    const doc = agentManager.addRagDocument(req.params.id, name, content);
    if (!doc) return res.status(404).json({ error: 'Agent not found' });
    res.status(201).json(doc);
  });

  router.post('/:id/rag/url', requireAgentAccess, async (req, res) => {
    try {
      const { name, url } = req.body;
      if (!name || !url) return res.status(400).json({ error: 'Name and url required' });
      try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
      const doc = await agentManager.addRagUrlDocument(req.params.id, name, url);
      if (!doc) return res.status(404).json({ error: 'Agent not found' });
      res.status(201).json(doc);
    } catch (err: any) {
      res.status(502).json({ error: `Failed to fetch URL: ${err.message}` });
    }
  });

  router.post('/:id/rag/:docId/refresh', requireAgentAccess, async (req, res) => {
    try {
      const doc = await agentManager.refreshRagUrlDocument(req.params.id, req.params.docId);
      if (!doc) return res.status(404).json({ error: 'URL document not found' });
      res.json(doc);
    } catch (err: any) {
      res.status(502).json({ error: `Failed to refresh: ${err.message}` });
    }
  });

  router.delete('/:id/rag/:docId', requireAgentAccess, (req, res) => {
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
  router.post('/:id/plugins', requireAgentAccess, pluginAssignHandler);
  router.delete('/:id/plugins/:pluginId', requireAgentAccess, pluginRemoveHandler);
  // Backward compatibility
  router.post('/:id/skills', requireAgentAccess, pluginAssignHandler);

// ── Task History & Stats ──────────────────────────────────────────────────────

router.get("/tasks/stats", async (req, res) => {
  const { project } = req.query;
  const userBoardIds = req.user.role === 'admin' ? null : await getUserBoardIds(req.user.userId);
  const stats = agentManager.getTaskStats(project || null, userBoardIds);
  res.json(stats);
});

router.get("/tasks/stats/timeseries", async (req, res) => {
  const { project, days } = req.query;
  const d = Math.min(Math.max(parseInt(days as string) || 30, 1), 365);
  const userBoardIds = req.user.role === 'admin' ? null : await getUserBoardIds(req.user.userId);
  const timeseries = agentManager.getTaskTimeSeries(project || null, d, userBoardIds);
  res.json(timeseries);
});

router.get("/tasks/stats/agent-time", async (req, res) => {
  const { project, days } = req.query;
  const d = Math.min(Math.max(parseInt(days as string) || 30, 1), 365);
  const userBoardIds = req.user.role === 'admin' ? null : await getUserBoardIds(req.user.userId);
  const agentTime = agentManager.getAgentTimeSeries(project || null, d, userBoardIds);
  res.json(agentTime);
});

router.get("/tasks/:id/history", async (req, res) => {
  const task = agentManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  if (req.user.role !== 'admin') {
    const userBoardIds = await getUserBoardIds(req.user.userId);
    if (task.boardId && !userBoardIds.has(task.boardId)) {
      return res.status(403).json({ error: "Access denied" });
    }
  }
  res.json(task.history || []);
});
  router.delete('/:id/skills/:skillId', requireAgentAccess, pluginRemoveHandler);

  // ── MCP server assignment endpoints (backward compat) ───────────
  router.post('/:id/mcp-servers', requireAgentAccess, (req, res) => {
    const { serverId } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId required' });
    const result = agentManager.assignMcpServer(req.params.id, serverId);
    if (result === null) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, mcpServers: result });
  });

  router.delete('/:id/mcp-servers/:serverId', requireAgentAccess, (req, res) => {
    const success = agentManager.removeMcpServer(req.params.id, req.params.serverId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  return router;
}