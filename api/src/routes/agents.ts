import express from 'express';
import { z } from 'zod';
import { getWorkflowForBoard } from '../services/configManager.js';
import { getAllBoards, saveTaskToDb, getAgentById } from '../services/database.js';
import { stripToolCalls } from '../services/workflow/index.js';
import { setTaskSignal } from '../services/agentManager/tasks.js';
import { checkBoardAccess } from '../middleware/authz.js';
import { detectEnvironment } from '../lib/environment.js';
import { getUserBoardIdSet as getUserBoardIds } from '../lib/boardAccess.js';
import { getMemTask } from './tasks.js';
import { createAgentSchema, updateAgentSchema } from '../schemas/agents.js';
import {
  statusesHandler,
  swarmStatusHandler,
  byProjectHandler,
  projectSummaryHandler,
} from './lib/agentStatusHandlers.js';

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

  // Board-based access guard: users can access agents on their boards or
  // unscoped agents. 'read' is permissive; 'edit' is the stricter guard for
  // mutating endpoints so that read-only shares cannot modify agents/tasks.
  const agentAccess = (level: 'read' | 'edit') => async (req, res, next) => {
    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (req.user.role === 'admin') return next();
    // Agents without a board are accessible to everyone (legacy)
    if (!agent.boardId) return next();
    const access = await checkBoardAccess(agent.boardId, req.user.userId, req.user.role, level);
    if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
    next();
  };
  const requireAgentAccess = agentAccess('read');
  const requireAgentEditAccess = agentAccess('edit');

  // List agents (filtered by board access — each user sees agents on their boards + unscoped)
  router.get('/', async (req, res) => {
    const userBoardIds = await getUserBoardIds(req.user.userId);
    const agents = agentManager.getAllForUser(req.user.userId, req.user.role, userBoardIds);
    res.json(agents.map(sanitizeAgent));
  });

  // Status routes mount the SCOPED status handlers (scoped=true): each user
  // sees only agents on their boards (+ unscoped). See leaderTools.ts for the
  // deliberately unscoped swarm-leader variants.

  // Get lightweight status for ALL enabled agents (includes project + currentTask)
  // Much lighter than GET / which returns full agent data with conversation history
  // Optional query param: ?project=ProjectName to filter by project
  router.get('/statuses', statusesHandler(agentManager, true));

  // Get agents working on a specific project
  router.get('/by-project/:project', byProjectHandler(agentManager, true));

  // Get project summary: all projects with their agent counts and assignments
  router.get('/project-summary', projectSummaryHandler(agentManager, true));

  // Get comprehensive swarm status with project assignments
  router.get('/swarm-status', swarmStatusHandler(agentManager, true));

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
      const batchSize = Math.max(1, Math.min(50, parsed.batchSize || 1));
      if (batchSize > 1) {
        const agents = await agentManager.createBatch(parsed, batchSize);
        return res.status(201).json({ batch: true, agents });
      }
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
  router.put('/:id', requireAgentEditAccess, async (req, res) => {
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
  router.delete('/:id', requireAgentEditAccess, async (req, res) => {
    if (req.user.role === 'basic') {
      return res.status(403).json({ error: 'Basic users cannot delete agents' });
    }
    const success = await agentManager.delete(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Send message to agent
  router.post('/:id/chat', requireAgentEditAccess, async (req, res) => {
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

  // Reload conversation history from the database. Useful in multi-replica
  // deployments where another replica may have advanced the conversation
  // beyond what this replica has in memory.
  router.post('/:id/history/reload', requireAgentAccess, async (req, res) => {
    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const fresh = await getAgentById(req.params.id);
    if (!fresh) return res.status(404).json({ error: 'Agent not found in database' });
    agent.conversationHistory = Array.isArray(fresh.conversationHistory) ? fresh.conversationHistory : [];
    // History diverged from whatever the runner's JSONL holds — force a fresh
    // CLI session on next call so the model sees the reloaded history.
    agent.runnerSessions = {};
    agent.currentThinking = '';
    delete agent._compactionArmed;
    agentManager._emit?.('agent:updated', agentManager._sanitize ? agentManager._sanitize(agent) : agent);
    res.json(agent.conversationHistory);
  });

  // Stop agent
  router.post('/:id/stop', requireAgentEditAccess, (req, res) => {
    const stopped = agentManager.stopAgent(req.params.id);
    if (stopped === false) return res.status(404).json({ error: 'Agent not found' });
    res.json({ ok: true, stopped });
  });

  // Clear conversation history
  router.delete('/:id/history', requireAgentEditAccess, async (req, res) => {
    const success = await agentManager.clearHistory(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Reload context — stronger than clearHistory: stops the agent and
  // invalidates every per-agent cache (stream buffer, chat lock, retry
  // counters, runner sessions, MCP connections, file tree) plus the global
  // LLM config cache, so any pending config change is picked up on the
  // next message.
  router.post('/:id/reload-context', requireAgentEditAccess, async (req, res) => {
    const success = await agentManager.reloadContext(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Restart runtime — resets the live process/connections (CLI session, MCP
  // clients, file tree) and refreshes config caches WITHOUT erasing the
  // conversation or the runner session UUIDs, so the agent resumes exactly
  // where it left off with any pending config change applied.
  router.post('/:id/restart', requireAgentEditAccess, async (req, res) => {
    const success = await agentManager.restartRuntime(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Truncate conversation history after a specific message index
  router.delete('/:id/history/after/:index', requireAgentEditAccess, (req, res) => {
    const result = agentManager.truncateHistory(req.params.id, req.params.index);
    if (result === null) return res.status(404).json({ error: 'Agent not found or invalid index' });
    res.json(result);
  });

  // Clear action logs
  router.delete('/:id/action-logs', requireAgentEditAccess, (req, res) => {
    const success = agentManager.clearActionLogs(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  // Handoff between agents
  router.post('/:id/handoff', requireAgentEditAccess, async (req, res) => {
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
  router.post('/:id/tasks', requireAgentEditAccess, async (req, res) => {
    try {
      const { text, source, status, boardId, repoFullName, repoProvider, secondaryRepos, storageProvider, storagePath, recurrence, taskType, isManual } = req.body;
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

      // Repo is the canonical "owner/repo" the picker captured from the
      // board's GitHub plugin — validate format only (full validation against
      // the OAuth scope happens at clone time).
      const resolvedRepoFullName: string | null = (repoFullName && /^[\w.-]+\/[\w.-]+$/.test(repoFullName))
        ? repoFullName
        : null;
      const resolvedRepoProvider = resolvedRepoFullName ? (repoProvider || 'github') : null;

      // Storage path comes from the board's OneDrive plugin picker.
      const resolvedStoragePath: string | null = (typeof storagePath === 'string' && storagePath.trim().length > 0)
        ? storagePath.trim().slice(0, 500)
        : null;
      const resolvedStorageProvider = resolvedStoragePath ? (storageProvider || 'onedrive') : null;

      const environment = detectEnvironment(req.hostname);
      console.log(`[CreateTask] POST /:id/tasks — status="${status}", boardId="${boardId}", repo="${resolvedRepoFullName || ''}", storage="${resolvedStoragePath || ''}" env="${environment}" text="${(text || '').slice(0, 60)}"`);
      const task = agentManager.addTask(req.params.id, text, resolvedSource, resolvedStatus, {
        boardId: resolvedBoardId,
        repoFullName: resolvedRepoFullName,
        repoProvider: resolvedRepoProvider,
        // Validated + deduped + primary-excluded inside addTask (normalizeSecondaryRepos)
        secondaryRepos: secondaryRepos,
        storagePath: resolvedStoragePath,
        storageProvider: resolvedStorageProvider,
        recurrence: recurrence || undefined,
        taskType: taskType || undefined,
        isManual: isManual || false,
        environment,
      });
      if (!task) return res.status(404).json({ error: 'Agent not found' });
      console.log(`[CreateTask] Task created: id=${task.id} status="${task.status}" boardId="${task.boardId}"`);
      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id/tasks/:taskId', requireAgentEditAccess, async (req, res) => {
    try {
      const { status, text, title, repoFullName, repoProvider, secondaryRepos, storageProvider, storagePath, source, recurrence, taskType, isManual } = req.body || {};
      // Source is immutable once set at creation — reject any attempt to change it
      if (source !== undefined) {
        return res.status(400).json({ error: 'Source cannot be modified after creation' });
      }
      // Recover from any in-memory drift before reading the task
      await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
      // Capture old status before any update
      const agent = agentManager.agents.get(req.params.id);
      const oldTask = getMemTask(agentManager, req.params.id, req.params.taskId);

      // When a user changes the task status while it's being executed, stop the agent
      // so it no longer works on this task or receives reminders.
      if (status && status !== oldTask?.status && oldTask?.startedAt && agentManager._isActiveTaskStatus(oldTask.status) && agent?.status === 'busy') {
        agentManager.stopAgent(req.params.id);
        // Signal the reminder loop to exit for this task
        setTaskSignal(req.params.taskId, 'stopped', true);
      }

      // ── Independent side-effect updates ──────────────────────────────────
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

      if (title !== undefined) {
        agentManager.updateTaskTitle(req.params.id, req.params.taskId, title.trim() || null);
      }
      // text/repo/storage/status remain mutually exclusive (first match wins) —
      // preserving today's behavior where e.g. {text,status} applies text and
      // silently ignores status.
      if (text !== undefined) {
        if (!text.trim()) return res.status(400).json({ error: 'Text cannot be empty' });
        agentManager.updateTaskText(req.params.id, req.params.taskId, text.trim());
      } else if (repoFullName !== undefined) {
        // Format check only — the picker is sourced from the board's GitHub plugin.
        const value = repoFullName && /^[\w.-]+\/[\w.-]+$/.test(repoFullName) ? repoFullName : null;
        agentManager.updateTaskRepo(req.params.id, req.params.taskId, value, repoProvider || (value ? 'github' : null));
      } else if (secondaryRepos !== undefined) {
        // Array of {provider, fullName} (or bare "owner/repo" strings) — normalized
        // (deduped, primary-excluded, capped) inside updateTaskSecondaryRepos.
        agentManager.updateTaskSecondaryRepos(req.params.id, req.params.taskId, secondaryRepos);
      } else if (storagePath !== undefined) {
        // Picker sourced from the board's OneDrive plugin; just length-check.
        const value = (typeof storagePath === 'string' && storagePath.trim().length > 0)
          ? storagePath.trim().slice(0, 500)
          : null;
        agentManager.updateTaskStorage(req.params.id, req.params.taskId, value, storageProvider || (value ? 'onedrive' : null));
      } else if (status) {
        agentManager.setTaskStatus(req.params.id, req.params.taskId, status);
      }

      // A request carrying none of the recognized fields is the legacy toggle
      // (frontend api.ts depends on the empty-body → toggle behavior). NOTE:
      // `title` is intentionally NOT counted here — a {title}-only body still
      // falls through to toggleTask today (likely a latent bug), preserved as-is.
      const touched = text !== undefined || repoFullName !== undefined || secondaryRepos !== undefined || storagePath !== undefined
        || !!status || recurrence !== undefined || taskType !== undefined || isManual !== undefined;
      const task = touched
        ? getMemTask(agentManager, req.params.id, req.params.taskId)
        : agentManager.toggleTask(req.params.id, req.params.taskId);

      if (!task) return res.status(404).json({ error: 'Not found' });
      res.json(task);
    } catch (err) {
      console.error(`[Route] Error updating task ${req.params.taskId}:`, err.message);
      try {
        agentManager.setTaskStatus(req.params.id, req.params.taskId, 'error', { skipAutoRefine: true, by: 'system' });
        const errorAgent = agentManager.agents.get(req.params.id);
        const errorTask = getMemTask(agentManager, req.params.id, req.params.taskId);
        if (errorTask) errorTask.error = err.message;
      } catch (_) { /* best effort */ }
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id/tasks', requireAgentEditAccess, (req, res) => {
    const success = agentManager.clearTasks(req.params.id);
    if (!success) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true });
  });

  router.delete('/:id/tasks/:taskId', requireAgentEditAccess, async (req, res) => {
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const agent = agentManager.agents.get(req.params.id);
    const taskToDelete = getMemTask(agentManager, req.params.id, req.params.taskId);
    // Block deletion of tasks being executed — user must stop the agent first
    if (taskToDelete?.startedAt && agentManager._isActiveTaskStatus(taskToDelete.status) && agent?.status === 'busy') {
      return res.status(409).json({ error: 'Task is being executed. Stop the agent first.' });
    }
    const success = await agentManager.deleteTask(req.params.id, req.params.taskId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  router.post('/:id/tasks/:taskId/transfer', requireAgentEditAccess, async (req, res) => {
    const { targetAgentId } = req.body;
    if (!targetAgentId) return res.status(400).json({ error: 'targetAgentId required' });
    // Verify the requesting user also has access to the target agent — otherwise a user
    // could push tasks into agents on boards they don't own.
    if (req.user.role !== 'admin') {
      const target = agentManager.agents.get(targetAgentId);
      if (!target) return res.status(404).json({ error: 'Target agent not found' });
      if (target.boardId) {
        const userBoardIds = await getUserBoardIds(req.user.userId);
        if (!userBoardIds.has(target.boardId)) {
          return res.status(403).json({ error: 'Access denied to target agent' });
        }
      }
    }
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const task = agentManager.transferTask(req.params.id, req.params.taskId, targetAgentId);
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.status(201).json(task);
  });

  router.patch('/:id/tasks/:taskId/assignee', requireAgentEditAccess, async (req, res) => {
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
  router.post('/:id/tasks/:taskId/commits', requireAgentEditAccess, async (req, res) => {
    const { hash, message } = req.body;
    if (!hash) return res.status(400).json({ error: 'Commit hash required' });
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const task = agentManager.addTaskCommit(req.params.id, req.params.taskId, hash, message || '');
    if (!task) return res.status(404).json({ error: 'Agent or task not found' });
    res.status(201).json(task);
  });

  router.delete('/:id/tasks/:taskId/commits/:hash', requireAgentEditAccess, async (req, res) => {
    await agentManager._ensureTaskInMemory(req.params.id, req.params.taskId);
    const task = agentManager.removeTaskCommit(req.params.id, req.params.taskId, req.params.hash);
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json(task);
  });

  // ── On-demand AI refinement (synchronous — waits for result) ────────
  router.post('/:id/tasks/:taskId/refine', requireAgentEditAccess, async (req, res) => {
    const { refineAgentId } = req.body;
    if (!refineAgentId) return res.status(400).json({ error: 'refineAgentId required' });

    const agent = agentManager.agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const task = getMemTask(agentManager, req.params.id, req.params.taskId);
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
  router.post('/:id/rag', requireAgentEditAccess, (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'Name and content required' });
    const doc = agentManager.addRagDocument(req.params.id, name, content);
    if (!doc) return res.status(404).json({ error: 'Agent not found' });
    res.status(201).json(doc);
  });

  router.post('/:id/rag/url', requireAgentEditAccess, async (req, res) => {
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

  router.post('/:id/rag/:docId/refresh', requireAgentEditAccess, async (req, res) => {
    try {
      const doc = await agentManager.refreshRagUrlDocument(req.params.id, req.params.docId);
      if (!doc) return res.status(404).json({ error: 'URL document not found' });
      res.json(doc);
    } catch (err: any) {
      res.status(502).json({ error: `Failed to refresh: ${err.message}` });
    }
  });

  router.delete('/:id/rag/:docId', requireAgentEditAccess, (req, res) => {
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
  router.post('/:id/plugins', requireAgentEditAccess, pluginAssignHandler);
  router.delete('/:id/plugins/:pluginId', requireAgentEditAccess, pluginRemoveHandler);
  // Backward compatibility
  router.post('/:id/skills', requireAgentEditAccess, pluginAssignHandler);

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

  router.delete('/:id/skills/:skillId', requireAgentEditAccess, pluginRemoveHandler);

  // ── MCP server assignment endpoints (backward compat) ───────────
  router.post('/:id/mcp-servers', requireAgentEditAccess, (req, res) => {
    const { serverId } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId required' });
    const result = agentManager.assignMcpServer(req.params.id, serverId);
    if (result === null) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, mcpServers: result });
  });

  router.delete('/:id/mcp-servers/:serverId', requireAgentEditAccess, (req, res) => {
    const success = agentManager.removeMcpServer(req.params.id, req.params.serverId);
    if (!success) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  return router;
}