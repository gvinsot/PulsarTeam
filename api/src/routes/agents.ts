import express from 'express';
import { errorMessage } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getWorkflowForBoard, isAgentTypeEnabled } from '../services/configManager.js';
import { AGENT_TYPE_LABELS, normalizeAgentType } from '../services/runners.js';
import {
  getAllAgents,
  getAllBoards,
  getAllUsers,
  getBoardsByUser,
  getUserById,
  saveTaskToDb,
  updateTaskFields,
  getAgentById,
} from '../services/database.js';
import { isValidRepoFullName } from '../services/taskRepos.js';
import { stripToolCalls } from '../services/workflow/index.js';
import { setTaskSignal } from '../services/agentManager/tasks.js';
import { requireRole, sessionUser } from '../middleware/auth.js';
import { agentAccessMiddleware, type AgentAccessLevel } from '../lib/agentAccess.js';
import { detectEnvironment } from '../lib/environment.js';
import { getUserBoardIdSet as getUserBoardIds } from '../lib/boardAccess.js';
import { getMemTask } from './tasks.js';
import {
  createAgentSchema,
  updateAgentSchema,
  convertAgentToBatchSchema,
} from '../schemas/agents.js';
import {
  statusesHandler,
  swarmStatusHandler,
  byProjectHandler,
  projectSummaryHandler,
} from './lib/agentStatusHandlers.js';
import { parseAgentProjection } from '../services/agentManager/projection.js';
import type { AgentManager } from '../services/agentManager/index.js';

// Mask sensitive fields before sending agent data to the client
/**
 * Agent records reach this as the untyped rows `agentManager` keeps; only
 * `apiKey` is read by name, so that is the only field the parameter names.
 */
function sanitizeAgent(
  agent: ({ apiKey?: string | null } & Record<string, unknown>) | null | undefined
) {
  if (!agent) return agent;
  const { apiKey, ...safe } = agent;
  if (apiKey) {
    safe.apiKey = apiKey.length > 8 ? apiKey.slice(0, 4) + '...' + apiKey.slice(-4) : '••••';
  }
  return safe;
}

/**
 * Reject a runner an admin has switched off in Admin Settings → Agent Types.
 * Returns the error message, or null when the runner is allowed. An absent
 * runner is the "Auto" choice and is never blocked here.
 */
async function disabledAgentTypeError(runner: unknown): Promise<string | null> {
  const id = normalizeAgentType(runner);
  if (!id) return null;
  if (await isAgentTypeEnabled(id)) return null;
  return `Agent type "${AGENT_TYPE_LABELS[id]}" is disabled by the administrator`;
}

export function agentRoutes(agentManager: AgentManager) {
  const router = express.Router();

  // Agent access guard. The rule itself now lives in lib/agentAccess.ts so the
  // MCP handlers, the OAuth plugin routes and the voice routes enforce exactly
  // the same one; this router only supplies the lookup (its in-memory map).
  // 'read' is permissive; 'edit' is the stricter guard for mutating endpoints
  // so that read-only shares cannot modify agents/tasks.
  const agentAccess = (level: AgentAccessLevel) =>
    agentAccessMiddleware(id => agentManager.agents.get(id), level);
  const requireAgentAccess = agentAccess('read');
  const requireAgentEditAccess = agentAccess('edit');

  // List agents (filtered by board access — each user sees agents on their boards + unscoped)
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      const userBoardIds = await getUserBoardIds(user.userId);
      // Refresh cached task counts + token totals so the agents view shows
      // accurate tasks-in-progress and lifetime tokens on the initial HTTP load.
      await agentManager._enrichAllAgentsStats();
      const projection = parseAgentProjection(req.query as Record<string, unknown>, 'list');
      const agents = agentManager.getAllForUser(user.userId, user.role, userBoardIds, projection);
      res.json(agents.map(sanitizeAgent));
    })
  );

  // Status routes mount the SCOPED status handlers (scoped=true): each user
  // sees only agents on their boards (+ unscoped). See leaderTools.ts for the
  // deliberately unscoped swarm-leader variants.

  // Get status-only data for ALL enabled agents (includes project + currentTask)
  // GET / is also lightweight by default; use view=detail/include when full agent blobs are needed.
  // Optional query param: ?project=ProjectName to filter by project
  router.get('/statuses', asyncHandler(statusesHandler(agentManager, true)));

  // Get agents working on a specific project
  router.get('/by-project/:project', asyncHandler(byProjectHandler(agentManager, true)));

  // Get project summary: all projects with their agent counts and assignments
  router.get('/project-summary', asyncHandler(projectSummaryHandler(agentManager, true)));

  // Get comprehensive swarm status with project assignments
  router.get('/swarm-status', asyncHandler(swarmStatusHandler(agentManager, true)));

  // ── Admin: reset instructions for all agents of a role to default template ──
  router.post(
    '/reset-instructions/:role',
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      if (user.role !== 'admin') {
        res.status(403).json({ error: 'Admin only' });
        return;
      }
      const { role } = req.params;
      const result = await agentManager.resetInstructionsByRole(role);
      if (result.error === 'no_template') {
        res.status(404).json({ error: `No default template found for role "${role}"` });
        return;
      }
      res.json({ success: true, role, resetCount: result.reset.length, agentIds: result.reset });
    })
  );

  // ── Admin: orphaned agents ─────────────────────────────────────────────────
  //
  // MOUNTED HERE, ABOVE '/:id', on purpose: Express serves the first route that
  // matches, so declared after it this path would be read as the agent whose id
  // is "orphans". Same reason the literal routes above sit where they do.
  //
  // An agent is ORPHANED when the application cannot resolve its owner to a
  // live user, which covers two populations:
  //   • no ownerId at all — created before the owner column existed, or
  //     deliberately unowned;
  //   • an ownerId pointing at a deleted account — `agents.owner_id` is
  //     ON DELETE SET NULL, but nothing rewrites the copy inside the `data`
  //     JSONB, so the application goes on reading the agent as owned by a user
  //     who is gone (see rowToAgent in services/database/agents.ts).
  // Either way lib/agentAccess.ts case 3 now closes the agent to everyone but
  // an admin — correct, and exactly what this screen exists to undo.
  //
  // Board membership is deliberately NOT part of the test. A board-scoped agent
  // whose owner is gone needs a new one just as much (the owner is what carries
  // the OAuth tokens and the token accounting); it is merely still reachable in
  // the meantime.
  router.get(
    '/orphans',
    requireRole('admin'),
    asyncHandler(async (_req, res) => {
      // Two queries total, never one per agent: the user ids are read once and
      // the ownership test runs against the set.
      const [agents, users] = await Promise.all([getAllAgents(), getAllUsers()]);
      // getAllUsers() is fail-soft: it logs and returns [] on ANY query error
      // (database/users.ts), which is indistinguishable from "no users exist".
      // Without this guard a single failed statement would make EVERY agent
      // look orphaned and invite an admin to mass-reassign a healthy install.
      // Agents cannot exist without a user having created them, so an empty
      // user set alongside a non-empty agent set is a read failure, not a fact.
      if (agents.length > 0 && users.length === 0) {
        res.status(503).json({ error: 'User directory unavailable — try again' });
        return;
      }
      const userIds = new Set(users.map(user => user.id));
      const orphans = agents
        .filter(agent => !agent.ownerId || !userIds.has(agent.ownerId))
        .map(agent => ({
          id: agent.id,
          name: agent.name,
          boardId: agent.boardId ?? null,
          ownerId: agent.ownerId ?? null,
          // Computed rather than hard-coded false: every agent the filter above
          // admits fails this test today, but the flag is what lets the client
          // tell "never had an owner" (ownerId null) from "owner was deleted"
          // (ownerId set, user gone), and it stays true to its name if the
          // filter is ever widened.
          ownerExists: !!agent.ownerId && userIds.has(agent.ownerId),
          createdAt: typeof agent.createdAt === 'string' ? agent.createdAt : undefined,
        }));
      res.json({ agents: orphans });
    })
  );

  // ── Admin: give an orphaned agent an owner ─────────────────────────────────
  //
  // Reassignment goes through agentManager.update — the application path — and
  // never through SQL. `update` mutates the in-memory agent every other surface
  // reads, then saveAgent writes BOTH stores in one statement: the `owner_id`
  // column and the `ownerId` inside the `data` JSONB. An
  // `UPDATE agents SET owner_id = …` would leave the JSONB stale, so the change
  // would be invisible to the running process and, after a restart, would only
  // hold until the next saveAgent overwrote the column from the stale JSONB.
  //
  // Admin-only, like the listing: reassigning ownership hands one tenant's
  // agent — and the credentials it carries — to another account.
  router.put<{ id: string }>(
    '/:id/owner',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const ownerId: unknown = req.body?.ownerId;
      if (typeof ownerId !== 'string' || !ownerId.trim()) {
        res.status(400).json({ error: 'ownerId required' });
        return;
      }
      // The target user is checked BEFORE the write because `owner_id` is a
      // foreign key: an unknown id makes saveAgent's INSERT … ON CONFLICT fail,
      // and saveAgent logs and swallows that error, which would leave the
      // in-memory agent claiming an owner the database never accepted.
      const owner = await getUserById(ownerId);
      if (!owner) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      // `ownerId` is in AGENT_UPDATE_FIELDS, and BATCH_SHARED_FIELDS is built
      // from that list (crud.ts), so updating one member of a batch reassigns
      // EVERY member. That is the right semantics — a batch is one job split
      // across N agents and cannot be half-owned — but it is a surprise if the
      // caller sees a single row move, so the count is reported rather than
      // left silent. Read before the write: `update` returns only the agent
      // that was addressed.
      const before = agentManager.agents.get(req.params.id);
      const batchId: unknown = before?.batchId;
      const affected =
        typeof batchId === 'string' && batchId
          ? Array.from(agentManager.agents.values()).filter(
              candidate => candidate.batchId === batchId
            ).length
          : 1;

      const agent = await agentManager.update(req.params.id, { ownerId });
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json({ success: true, agent: sanitizeAgent(agent), affected });
    })
  );

  // Get single agent detailed status (lightweight, includes project + currentTask)
  router.get(
    '/:id/status',
    requireAgentAccess,
    asyncHandler(async (req: express.Request<{ id: string }>, res: express.Response) => {
      const status = await agentManager.getAgentStatus(req.params.id);
      if (!status) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(status);
    })
  );

  // Get single agent
  router.get<{ id: string }>('/:id', requireAgentAccess, (req, res) => {
    const projection = parseAgentProjection(req.query as Record<string, unknown>, 'detail');
    const agent = agentManager.getById(req.params.id, projection);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(sanitizeAgent(agent));
  });

  // Create agent (basic users cannot create)
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      if (req.user.role === 'basic') {
        return res.status(403).json({ error: 'Basic users cannot create agents' });
      }
      const parsed: any = createAgentSchema.parse(req.body);
      const createBlocked = await disabledAgentTypeError(parsed.runner);
      if (createBlocked) return res.status(400).json({ error: createBlocked });
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
    })
  );

  // Update agent (basic users cannot edit settings, ownership enforced by middleware)
  router.put(
    '/:id',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      if (req.user.role === 'basic') {
        return res.status(403).json({ error: 'Basic users cannot modify agents' });
      }
      const parsed = updateAgentSchema.parse(req.body);
      // A disabled type only blocks a change TO it: agents already running on a
      // type an admin has since switched off keep working and stay editable.
      if (
        parsed.runner &&
        normalizeAgentType(parsed.runner) !==
          normalizeAgentType(agentManager.getById(req.params.id)?.runner)
      ) {
        const updateBlocked = await disabledAgentTypeError(parsed.runner);
        if (updateBlocked) return res.status(400).json({ error: updateBlocked });
      }
      // Only admins can change ownership
      if ('ownerId' in parsed && req.user.role !== 'admin') {
        delete parsed.ownerId;
      }
      const agent = await agentManager.update(req.params.id, parsed);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(agent);
    })
  );

  // Convert an existing agent into a batch. The original agent becomes member #1.
  router.post(
    '/:id/batch',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      if (req.user.role === 'basic') {
        return res.status(403).json({ error: 'Basic users cannot modify agents' });
      }
      const parsed = convertAgentToBatchSchema.parse(req.body);
      const agents = await agentManager.convertToBatch(req.params.id, parsed.batchSize);
      if (!agents) return res.status(404).json({ error: 'Agent not found' });
      res.status(201).json({ batch: true, agents });
    })
  );

  // Delete agent (basic users cannot delete, ownership enforced by middleware)
  router.delete<{ id: string }>(
    '/:id',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      if (user.role === 'basic') {
        res.status(403).json({ error: 'Basic users cannot delete agents' });
        return;
      }
      const success = await agentManager.delete(req.params.id);
      if (!success) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json({ success: true });
    })
  );

  // Send message to agent
  router.post(
    '/:id/chat',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });
      if (typeof message !== 'string' || message.length > 50000) {
        return res.status(400).json({ error: 'Message must be a string under 50KB' });
      }

      const response = await agentManager.sendMessage(req.params.id, message);
      res.json({ response });
    })
  );

  // Get conversation history
  router.get<{ id: string }>('/:id/history', requireAgentAccess, (req, res) => {
    const agent = agentManager.agents.get(req.params.id);
    // Unreachable: requireAgentAccess has already 404'd on a missing agent.
    // Spelled out because that guard lives in a separate middleware the
    // compiler cannot follow, and the sibling routes answer the same way.
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(agent.conversationHistory);
  });

  // Reload conversation history from the database. Useful in multi-replica
  // deployments where another replica may have advanced the conversation
  // beyond what this replica has in memory.
  // Params type passed explicitly so `req.params.id` stays a `string`: the
  // typed `requireAgentAccess` otherwise pins `P` to express's loose
  // `ParamsDictionary`, whose values are `string | string[]`.
  router.post<{ id: string }>(
    '/:id/history/reload',
    requireAgentAccess,
    asyncHandler(async (req, res) => {
      const agent = agentManager.agents.get(req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const fresh = await getAgentById(req.params.id);
      if (!fresh) {
        res.status(404).json({ error: 'Agent not found in database' });
        return;
      }
      agent.conversationHistory = Array.isArray(fresh.conversationHistory)
        ? fresh.conversationHistory
        : [];
      // History diverged from whatever the runner's JSONL holds — force a fresh
      // CLI session on next call so the model sees the reloaded history.
      agent.runnerSessions = {};
      agent.currentThinking = '';
      delete agent._compactionArmed;
      agentManager._emit?.(
        'agent:updated',
        agentManager._sanitize ? agentManager._sanitize(agent) : agent
      );
      res.json(agent.conversationHistory);
    })
  );

  // Stop agent
  router.post<{ id: string }>('/:id/stop', requireAgentEditAccess, (req, res) => {
    const stopped = agentManager.stopAgent(req.params.id);
    if (stopped === false) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ ok: true, stopped });
  });

  // Clear conversation history
  router.delete<{ id: string }>(
    '/:id/history',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const success = await agentManager.clearHistory(req.params.id);
      if (!success) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json({ success: true });
    })
  );

  // Reload context — stronger than clearHistory: stops the agent and
  // invalidates every per-agent cache (stream buffer, chat lock, retry
  // counters, runner sessions, MCP connections, file tree) plus the global
  // LLM config cache, so any pending config change is picked up on the
  // next message.
  router.post<{ id: string }>(
    '/:id/reload-context',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const success = await agentManager.reloadContext(req.params.id);
      if (!success) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json({ success: true });
    })
  );

  // Restart runtime — resets the live process/connections (CLI session, MCP
  // clients, file tree) and refreshes config caches WITHOUT erasing the
  // conversation or the runner session UUIDs, so the agent resumes exactly
  // where it left off with any pending config change applied.
  router.post<{ id: string }>(
    '/:id/restart',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const success = await agentManager.restartRuntime(req.params.id);
      if (!success) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json({ success: true });
    })
  );

  // Truncate conversation history after a specific message index
  router.delete<{ id: string; index: string }>(
    '/:id/history/after/:index',
    requireAgentEditAccess,
    (req, res) => {
      const result = agentManager.truncateHistory(req.params.id, req.params.index);
      if (result === null) {
        res.status(404).json({ error: 'Agent not found or invalid index' });
        return;
      }
      res.json(result);
    }
  );

  // Clear action logs
  router.delete<{ id: string }>('/:id/action-logs', requireAgentEditAccess, (req, res) => {
    const success = agentManager.clearActionLogs(req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ success: true });
  });

  // Handoff between agents
  router.post(
    '/:id/handoff',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const { targetAgentId, context } = req.body;
      if (!targetAgentId || !context) {
        res.status(400).json({ error: 'targetAgentId and context required' });
        return;
      }
      const response = await agentManager.handoff(req.params.id, targetAgentId, context);
      res.json({ response });
    })
  );

  // Broadcast message to all agents
  router.post(
    '/broadcast/all',
    asyncHandler(async (req, res) => {
      const { message } = req.body;
      if (!message) {
        res.status(400).json({ error: 'Message required' });
        return;
      }

      const userBoardIds = await getUserBoardIds(req.user.userId);
      const visibleIds = new Set(
        agentManager
          .getAllForUser(req.user.userId, req.user.role, userBoardIds)
          .map((a: { id: string }) => a.id)
      );
      const results = await agentManager.broadcastMessage(message, null, visibleIds);
      res.json({ results });
    })
  );

  // Update project for all user's agents
  router.put(
    '/project/all',
    asyncHandler(async (req, res) => {
      const { project } = req.body;
      if (project === undefined) {
        res.status(400).json({ error: 'Project required' });
        return;
      }
      const userBoardIds = await getUserBoardIds(req.user.userId);
      const visibleIds = new Set(
        agentManager
          .getAllForUser(req.user.userId, req.user.role, userBoardIds)
          .map((a: { id: string }) => a.id)
      );
      const updated = await agentManager.updateAllProjects(project, visibleIds);
      res.json({ success: true, count: updated.length });
    })
  );

  // ── Task endpoints ──────────────────────────────────────────────────────
  router.post(
    '/:id/tasks',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const {
        text,
        source,
        status,
        boardId,
        repoFullName,
        repoProvider,
        secondaryRepos,
        storageProvider,
        storagePath,
        recurrence,
        taskType,
        isManual,
      } = req.body;
      if (!text) {
        res.status(400).json({ error: 'Text required' });
        return;
      }
      const agent = agentManager.agents.get(req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const resolvedSource = source || { type: 'user', name: req.user?.username || undefined };
      let resolvedStatus = status && typeof status === 'string' ? status : undefined;
      let resolvedBoardId = boardId || undefined;

      // When no boardId is provided, auto-assign the first available board
      // so the task is visible and gets the correct default status
      if (!resolvedBoardId) {
        try {
          const boards =
            req.user.role === 'admin'
              ? await getAllBoards()
              : await getBoardsByUser(req.user.userId);
          if (boards.length > 0) {
            resolvedBoardId = boards[0].id;
          }
        } catch {
          /* no board available */
        }
      }

      // When no status is provided, resolve default from the board's first column
      // so the task lands in the correct column
      if (!resolvedStatus && resolvedBoardId) {
        try {
          const wf = await getWorkflowForBoard(resolvedBoardId);
          if (wf?.columns && wf.columns.length > 0) {
            resolvedStatus = wf.columns[0].id;
          }
        } catch {
          /* fall through to addTask default */
        }
      }

      // Repo is the canonical "owner/repo" the picker captured from the
      // board's GitHub plugin — validate format only (full validation against
      // the OAuth scope happens at clone time).
      const resolvedRepoFullName: string | null = isValidRepoFullName(repoFullName)
        ? repoFullName
        : null;
      const resolvedRepoProvider = resolvedRepoFullName ? repoProvider || 'github' : null;

      // Storage path comes from the board's OneDrive plugin picker.
      const resolvedStoragePath: string | null =
        typeof storagePath === 'string' && storagePath.trim().length > 0
          ? storagePath.trim().slice(0, 500)
          : null;
      const resolvedStorageProvider = resolvedStoragePath ? storageProvider || 'onedrive' : null;

      const environment = detectEnvironment(req.hostname);
      console.log(
        `[CreateTask] POST /:id/tasks — status="${status}", boardId="${boardId}", repo="${resolvedRepoFullName || ''}", storage="${resolvedStoragePath || ''}" env="${environment}" text="${(text || '').slice(0, 60)}"`
      );
      const task = await agentManager.addTask(req.params.id, text, resolvedSource, resolvedStatus, {
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
      if (!task) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      console.log(
        `[CreateTask] Task created: id=${task.id} status="${task.status}" boardId="${task.boardId}"`
      );
      res.status(201).json(task);
    })
  );

  router.patch(
    '/:id/tasks/:taskId',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      try {
        const {
          status,
          text,
          title,
          repoFullName,
          repoProvider,
          secondaryRepos,
          storageProvider,
          storagePath,
          source,
          recurrence,
          taskType,
          isManual,
        } = req.body || {};
        // Source is immutable once set at creation — reject any attempt to change it
        if (source !== undefined) {
          res.status(400).json({ error: 'Source cannot be modified after creation' });
          return;
        }
        // Capture old status before any update
        const agent = agentManager.agents.get(req.params.id);
        const oldTask = await getMemTask(agentManager, req.params.id, req.params.taskId);

        // When a user changes the task status while it's being executed, stop the agent
        // so it no longer works on this task or receives reminders.
        if (
          status &&
          status !== oldTask?.status &&
          oldTask?.startedAt &&
          agentManager._isActiveTaskStatus(oldTask.status) &&
          agent?.status === 'busy'
        ) {
          agentManager.stopAgent(req.params.id);
          // Signal the reminder loop to exit for this task
          setTaskSignal(req.params.taskId, 'stopped', true);
        }

        // ── Independent side-effect updates ──────────────────────────────────
        // Handle recurrence update
        if (recurrence !== undefined && oldTask) {
          await agentManager.updateTaskRecurrence(req.params.id, req.params.taskId, recurrence);
        }

        // Handle taskType update
        if (taskType !== undefined && oldTask) {
          await agentManager.updateTaskType(req.params.id, req.params.taskId, taskType || null);
        }

        // Handle isManual update
        if (isManual !== undefined && oldTask) {
          oldTask.isManual = !!isManual;
          await saveTaskToDb({ ...oldTask, agentId: oldTask.agentId });
          agentManager._emit('task:updated', {
            agentId: oldTask.agentId,
            task: { ...oldTask, agentId: oldTask.agentId },
          });
        }

        if (title !== undefined) {
          await agentManager.updateTaskTitle(
            req.params.id,
            req.params.taskId,
            title.trim() || null
          );
        }
        // text/repo/storage/status remain mutually exclusive (first match wins) —
        // preserving today's behavior where e.g. {text,status} applies text and
        // silently ignores status.
        if (text !== undefined) {
          if (!text.trim()) {
            res.status(400).json({ error: 'Text cannot be empty' });
            return;
          }
          await agentManager.updateTaskText(req.params.id, req.params.taskId, text.trim());
        } else if (repoFullName !== undefined) {
          // Format check only — the picker is sourced from the board's GitHub plugin.
          const value = isValidRepoFullName(repoFullName) ? repoFullName : null;
          await agentManager.updateTaskRepo(
            req.params.id,
            req.params.taskId,
            value,
            repoProvider || (value ? 'github' : null)
          );
        } else if (secondaryRepos !== undefined) {
          // Array of {provider, fullName} (or bare "owner/repo" strings) — normalized
          // (deduped, primary-excluded, capped) inside updateTaskSecondaryRepos.
          await agentManager.updateTaskSecondaryRepos(
            req.params.id,
            req.params.taskId,
            secondaryRepos
          );
        } else if (storagePath !== undefined) {
          // Picker sourced from the board's OneDrive plugin; just length-check.
          const value =
            typeof storagePath === 'string' && storagePath.trim().length > 0
              ? storagePath.trim().slice(0, 500)
              : null;
          await agentManager.updateTaskStorage(
            req.params.id,
            req.params.taskId,
            value,
            storageProvider || (value ? 'onedrive' : null)
          );
        } else if (status) {
          await agentManager.setTaskStatus(req.params.id, req.params.taskId, status);
        }

        // A request carrying none of the recognized fields is the legacy toggle
        // (frontend api.ts depends on the empty-body → toggle behavior). NOTE:
        // `title` is intentionally NOT counted here — a {title}-only body still
        // falls through to toggleTask today (likely a latent bug), preserved as-is.
        const touched =
          text !== undefined ||
          repoFullName !== undefined ||
          secondaryRepos !== undefined ||
          storagePath !== undefined ||
          !!status ||
          recurrence !== undefined ||
          taskType !== undefined ||
          isManual !== undefined;
        const task = touched
          ? await getMemTask(agentManager, req.params.id, req.params.taskId)
          : await agentManager.toggleTask(req.params.id, req.params.taskId);

        if (!task) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(task);
      } catch (err) {
        console.error(`[Route] Error updating task ${req.params.taskId}:`, errorMessage(err));
        try {
          await agentManager.setTaskStatus(req.params.id, req.params.taskId, 'error', {
            skipAutoRefine: true,
            by: 'system',
          });
          await updateTaskFields(req.params.taskId, { error: errorMessage(err) });
        } catch (_) {
          /* best effort */
        }
        throw err;
      }
    })
  );

  router.delete<{ id: string }>('/:id/tasks', requireAgentEditAccess, (req, res) => {
    const success = agentManager.clearTasks(req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ success: true });
  });

  // Params type passed explicitly — see the note on /:id/history/reload above.
  router.delete<{ id: string; taskId: string }>(
    '/:id/tasks/:taskId',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const agent = agentManager.agents.get(req.params.id);
      const taskToDelete = await getMemTask(agentManager, req.params.id, req.params.taskId);
      // Block deletion of tasks being executed — user must stop the agent first
      if (
        taskToDelete?.startedAt &&
        agentManager._isActiveTaskStatus(taskToDelete.status) &&
        agent?.status === 'busy'
      ) {
        res.status(409).json({ error: 'Task is being executed. Stop the agent first.' });
        return;
      }
      const success = await agentManager.deleteTask(req.params.id, req.params.taskId);
      if (!success) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ success: true });
    })
  );

  router.post<{ id: string; taskId: string }>(
    '/:id/tasks/:taskId/transfer',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      const { targetAgentId } = req.body;
      if (!targetAgentId) {
        res.status(400).json({ error: 'targetAgentId required' });
        return;
      }
      // Verify the requesting user also has access to the target agent — otherwise a user
      // could push tasks into agents on boards they don't own.
      if (user.role !== 'admin') {
        const target = agentManager.agents.get(targetAgentId);
        if (!target) {
          res.status(404).json({ error: 'Target agent not found' });
          return;
        }
        if (target.boardId) {
          const userBoardIds = await getUserBoardIds(user.userId);
          if (!userBoardIds.has(target.boardId)) {
            res.status(403).json({ error: 'Access denied to target agent' });
            return;
          }
        }
      }
      const task = await agentManager.transferTask(req.params.id, req.params.taskId, targetAgentId);
      if (!task) {
        res.status(404).json({ error: 'Agent or task not found' });
        return;
      }
      res.status(201).json(task);
    })
  );

  router.patch<{ id: string; taskId: string }>(
    '/:id/tasks/:taskId/assignee',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const { assigneeId } = req.body;
      // assigneeId can be null to unassign
      if (assigneeId && !agentManager.agents.get(assigneeId)) {
        res.status(404).json({ error: 'Assignee agent not found' });
        return;
      }
      const task = await agentManager.setTaskAssignee(
        req.params.id,
        req.params.taskId,
        assigneeId || null
      );
      if (!task) {
        res.status(404).json({ error: 'Agent or task not found' });
        return;
      }
      res.json(task);
    })
  );

  // ── Task commit association ────────────────────────────────────────
  router.post<{ id: string; taskId: string }>(
    '/:id/tasks/:taskId/commits',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const { hash, message } = req.body;
      if (!hash) {
        res.status(400).json({ error: 'Commit hash required' });
        return;
      }
      const task = await agentManager.addTaskCommit(
        req.params.id,
        req.params.taskId,
        hash,
        message || ''
      );
      if (!task) {
        res.status(404).json({ error: 'Agent or task not found' });
        return;
      }
      res.status(201).json(task);
    })
  );

  router.delete<{ id: string; taskId: string; hash: string }>(
    '/:id/tasks/:taskId/commits/:hash',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const task = await agentManager.removeTaskCommit(
        req.params.id,
        req.params.taskId,
        req.params.hash
      );
      if (!task) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(task);
    })
  );

  // ── On-demand AI refinement (synchronous — waits for result) ────────
  router.post(
    '/:id/tasks/:taskId/refine',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      const { refineAgentId } = req.body;
      if (!refineAgentId) {
        res.status(400).json({ error: 'refineAgentId required' });
        return;
      }

      const agent = agentManager.agents.get(req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const task = await getMemTask(agentManager, req.params.id, req.params.taskId);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const refineAgent = agentManager.agents.get(refineAgentId);
      if (!refineAgent) {
        res.status(404).json({ error: 'Refine agent not found' });
        return;
      }
      if (refineAgent.status !== 'idle') {
        res.status(409).json({ error: 'Agent is busy' });
        return;
      }

      const prompt = `Refine the following task description. Make it clearer, more actionable, and add acceptance criteria if missing.\n\nTask: ${task.text}\n\nReply ONLY with the improved description (no preamble, no explanation).`;
      const result = await agentManager.sendMessage(refineAgentId, prompt, () => {});
      const refined = stripToolCalls((result?.content || result || '').trim());
      if (refined) {
        await agentManager.updateTaskText(req.params.id, req.params.taskId, refined);
      }
      res.json({ success: true, text: refined });
    })
  );

  // ── RAG Document endpoints ─────────────────────────────────────────
  router.post<{ id: string }>('/:id/rag', requireAgentEditAccess, (req, res) => {
    const { name, content } = req.body;
    if (!name || !content) {
      res.status(400).json({ error: 'Name and content required' });
      return;
    }
    const doc = agentManager.addRagDocument(req.params.id, name, content);
    if (!doc) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.status(201).json(doc);
  });

  router.post<{ id: string }>(
    '/:id/rag/url',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      try {
        const { name, url } = req.body;
        if (!name || !url) {
          res.status(400).json({ error: 'Name and url required' });
          return;
        }
        try {
          new URL(url);
        } catch {
          {
            res.status(400).json({ error: 'Invalid URL' });
            return;
          }
        }
        const doc = await agentManager.addRagUrlDocument(req.params.id, name, url);
        if (!doc) {
          res.status(404).json({ error: 'Agent not found' });
          return;
        }
        res.status(201).json(doc);
      } catch (err: any) {
        res.status(502).json({ error: `Failed to fetch URL: ${err.message}` });
      }
    })
  );

  router.post<{ id: string; docId: string }>(
    '/:id/rag/:docId/refresh',
    requireAgentEditAccess,
    asyncHandler(async (req, res) => {
      try {
        const doc = await agentManager.refreshRagUrlDocument(req.params.id, req.params.docId);
        if (!doc) {
          res.status(404).json({ error: 'URL document not found' });
          return;
        }
        res.json(doc);
      } catch (err: any) {
        res.status(502).json({ error: `Failed to refresh: ${err.message}` });
      }
    })
  );

  router.delete<{ id: string; docId: string }>(
    '/:id/rag/:docId',
    requireAgentEditAccess,
    (req, res) => {
      const success = agentManager.deleteRagDocument(req.params.id, req.params.docId);
      if (!success) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ success: true });
    }
  );

  // ── Plugin (skill) assignment endpoints ──────────────────────────
  const pluginAssignHandler = (req: express.Request<{ id: string }>, res: express.Response) => {
    const pluginId = req.body.skillId || req.body.pluginId;
    if (!pluginId) {
      res.status(400).json({ error: 'pluginId required' });
      return;
    }
    const result = agentManager.assignSkill(req.params.id, pluginId);
    if (result === null) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ success: true, plugins: result });
  };
  // Mounted on both '/:id/plugins/:pluginId' and '/:id/skills/:skillId', hence
  // the two optional params — the body reads whichever one the route supplied.
  const pluginRemoveHandler = (
    req: express.Request<{ id: string; skillId?: string; pluginId?: string }>,
    res: express.Response
  ) => {
    const pluginId = req.params.skillId || req.params.pluginId;
    // Unreachable: each mount supplies one of the two params. Answering 404 is
    // what the missing-plugin path below already does, so the response for this
    // branch is the same one it produced when the value was implicitly `any`.
    if (!pluginId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const success = agentManager.removeSkill(req.params.id, pluginId);
    if (!success) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ success: true });
  };
  router.post('/:id/plugins', requireAgentEditAccess, pluginAssignHandler);
  router.delete('/:id/plugins/:pluginId', requireAgentEditAccess, pluginRemoveHandler);
  // Backward compatibility
  router.post('/:id/skills', requireAgentEditAccess, pluginAssignHandler);

  // ── Task History & Stats ──────────────────────────────────────────────────────

  router.get(
    '/tasks/stats',
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      const { project } = req.query as { project?: string };
      const userBoardIds = user.role === 'admin' ? null : await getUserBoardIds(user.userId);
      const stats = await agentManager.getTaskStats(project || null, userBoardIds);
      res.json(stats);
    })
  );

  router.get(
    '/tasks/stats/timeseries',
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      const { project, days } = req.query as { project?: string; days?: string };
      const d = Math.min(Math.max(parseInt(days ?? '') || 30, 1), 365);
      const userBoardIds = user.role === 'admin' ? null : await getUserBoardIds(user.userId);
      const timeseries = await agentManager.getTaskTimeSeries(project || null, d, userBoardIds);
      res.json(timeseries);
    })
  );

  router.get(
    '/tasks/stats/agent-time',
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      const { project, days } = req.query as { project?: string; days?: string };
      const d = Math.min(Math.max(parseInt(days ?? '') || 30, 1), 365);
      const userBoardIds = user.role === 'admin' ? null : await getUserBoardIds(user.userId);
      const agentTime = await agentManager.getAgentTimeSeries(project || null, d, userBoardIds);
      res.json(agentTime);
    })
  );

  router.get(
    '/tasks/:id/history',
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user) return;
      const task = await agentManager.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (user.role !== 'admin') {
        const userBoardIds = await getUserBoardIds(user.userId);
        if (task.boardId && !userBoardIds.has(task.boardId)) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      }
      res.json(task.history || []);
    })
  );

  router.delete('/:id/skills/:skillId', requireAgentEditAccess, pluginRemoveHandler);

  return router;
}
