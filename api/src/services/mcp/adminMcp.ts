// ── POST /api/mcp/admin — the administrative tool set ──────────────────────
//
// Reached with a scoped API key whose scope is `admin`.
//
// "admin" NAMES A TOOL SET, NOT A ROLE. This is the single most important
// property of this file. A key with the admin scope lets its owner reach the
// tools that shape the instance — agents, boards, projects, workflows, shares —
// but every one of them is still bounded by what that owner could already
// administer through the UI. Minting an admin-scoped key never widens anybody's
// reach; it only changes the door they come in through. The tools that are
// genuinely instance-wide (today `list_users`) check `role === 'admin'` on the
// key's OWNER, re-read from the database on every request
// (middleware/apiKeyAuth.ts), so a demotion takes effect on the very next call.
//
// As on the management surface, nothing about access control is reimplemented:
// each tool calls the same schema (`createAgentSchema`), the same normalizer
// (`normalizeWorkflowColumnIds`) and the same authorization helper
// (`checkBoardAccess` / `checkProjectAccess` / `checkAgentAccess`, through
// services/mcp/actorScope.ts) as the REST route that does the same job. The
// tool and its route cannot diverge because they are the same code.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createBoard,
  createBoardShare,
  createProject,
  deleteBoard,
  deleteProject,
  getAllAgentSkills,
  getAllUsers,
  getBoardShares,
  getBoardsByUser,
  getProjectByName,
  getProjectsForUser,
  updateBoard,
  updateProject,
} from '../database.js';
import { DEFAULT_BOARD_WORKFLOW } from '../boardDefaults.js';
import { normalizeWorkflowColumnIds } from '../workflow/columnIds.js';
import { createAgentSchema, updateAgentSchema } from '../../schemas/agents.js';
import {
  agentConfigSchema,
  agentUpdatesSchema,
  workflowColumnSchema,
  workflowTransitionSchema,
} from './schemas.js';
import { applyColumnRenamesToBoardTasks } from '../workflow/renameBoardColumns.js';
import { jsonOk, jsonError } from '../mcpResponses.js';
import { createMcpHttpHandler } from '../mcpHttpHandler.js';
import { errorMessage } from '../../lib/errors.js';
import {
  notFound,
  requireAdminRole,
  scopedAgent,
  scopedBoard,
  scopedProject,
  type McpActor,
  type McpRecord,
} from './actorScope.js';
import type { AgentManager } from '../agentManager/index.js';
import type { MCPManager } from '../mcpManager.js';
import type { SkillManager } from '../skillManager.js';

/** Agent projection — never the API key, never the stored credentials. */
function agentView(agent: McpRecord) {
  // Allowlist configuration fields: runtime sessions, prompts with credentials,
  // histories and future secret fields cannot leak through object spreading.
  const excluded = new Set(['apiKey', 'credentials', 'mcpAuth', 'copyApiKeyFromAgent', 'todoList']);
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(createAgentSchema.shape)) {
    if (!excluded.has(key) && agent[key] !== undefined) config[key] = agent[key];
  }
  return {
    ...config,
    id: agent.id,
    status: agent.status,
    ownerId: agent.ownerId || null,
    boardId: agent.boardId || null,
    enabled: agent.enabled !== false,
    skills: agent.skills || [],
    mcpServers: agent.mcpServers || [],
    batchId: agent.batchId || null,
    batchIndex: agent.batchIndex ?? null,
    configuredSecrets: {
      apiKey: !!agent.apiKey,
      credentials: Object.keys(agent.credentials || {}),
      mcpAuth: Object.keys(agent.mcpAuth || {}),
    },
  };
}

function boardView(board: McpRecord) {
  return {
    id: board.id,
    name: board.name,
    user_id: board.user_id || null,
    project_id: board.project_id || null,
    columns: (board.workflow?.columns || []).map((c: McpRecord) => ({ id: c.id, label: c.label })),
    workflowVersion: board.workflow?.version ?? null,
    workflow: board.workflow || { columns: [], transitions: [] },
    plugins: board.plugins || [],
    filters: board.filters || {},
  };
}

/**
 * Users who may create agents. Mirrors `POST /api/agents`, which refuses the
 * `basic` role before it parses anything.
 */
function refuseBasic(actor: McpActor, verb: string) {
  if (actor.role === 'basic') {
    return jsonError(`Basic users cannot ${verb}.`);
  }
  return null;
}

export function createAdminMcpServer(
  agentManager: AgentManager,
  mcpManager: MCPManager,
  skillManager: SkillManager,
  actor: McpActor
) {
  const server = new McpServer({ name: 'PulsarTeam Admin', version: '1.0.0' });

  // ── Agents ──────────────────────────────────────────────────────────────

  server.tool(
    'get_agent',
    'Fetch one agent you can reach, with its configuration (secrets excluded).',
    { agent_id: z.string().describe('Agent UUID') },
    async ({ agent_id }) => {
      const agent = agentManager.agents.get(agent_id);
      const allowed = await scopedAgent(actor, agent, 'read');
      if (!allowed.ok) return allowed.error!;
      const resolved = agentManager.resolveLlmConfig?.(allowed.value);
      const effectiveLlm = resolved
        ? {
            provider: resolved.provider,
            model: resolved.model,
            endpoint: resolved.endpoint,
            configName: resolved.configName,
            temperature: resolved.temperature,
            maxTokens: resolved.maxTokens,
            contextLength: resolved.contextLength,
            managesContext: resolved.managesContext,
            supportsImages: resolved.supportsImages,
            isReasoning: resolved.isReasoning,
            costPerInputToken: resolved.costPerInputToken,
            costPerOutputToken: resolved.costPerOutputToken,
          }
        : null;
      return jsonOk({ agent: { ...agentView(allowed.value), effectiveLlm } });
    }
  );

  server.tool(
    'create_agent',
    'Create an agent on a board you can edit. board_id is mandatory — a board-less agent is created, started, and then never displayed anywhere.',
    {
      config: agentConfigSchema,
    },
    async ({ config }) => {
      const refused = refuseBasic(actor, 'create agents');
      if (refused) return refused;

      let parsed: McpRecord;
      try {
        // The REST schema, not a copy of it: a field this rejects there is
        // rejected here for the same reason and with the same message.
        parsed = createAgentSchema.parse(config);
      } catch (err) {
        return jsonError(`Invalid agent configuration: ${errorMessage(err)}`);
      }

      // createAgentSchema makes boardId required; the board must additionally
      // be one the caller may put an agent on.
      const board = await scopedBoard(actor, parsed.boardId, 'edit');
      if (!board.ok) return board.error!;

      // The key owner owns what their key creates. An admin-scoped key cannot
      // mint an agent for somebody else.
      parsed.ownerId = actor.userId;
      const agent = await agentManager.create(parsed);
      return jsonOk({ success: true, agent: agentView(agent) });
    }
  );

  server.tool(
    'update_agent',
    'Update an agent you can edit. Fields are validated by the same schema PUT /api/agents/:id uses.',
    {
      agent_id: z.string().describe('Agent UUID'),
      updates: agentUpdatesSchema,
    },
    async ({ agent_id, updates }) => {
      const refused = refuseBasic(actor, 'modify agents');
      if (refused) return refused;

      const existing = agentManager.agents.get(agent_id);
      const allowed = await scopedAgent(actor, existing, 'edit');
      if (!allowed.ok) return allowed.error!;

      let parsed: McpRecord;
      try {
        parsed = updateAgentSchema.parse(updates);
      } catch (err) {
        return jsonError(`Invalid agent update: ${errorMessage(err)}`);
      }

      // Same rule as the REST route: only a real admin reassigns ownership.
      if ('ownerId' in parsed && actor.role !== 'admin') delete parsed.ownerId;
      // Moving an agent to another board requires edit on the DESTINATION too,
      // otherwise an edit right on board A would be a way to plant an agent on
      // board B.
      if (parsed.boardId) {
        const target = await scopedBoard(actor, parsed.boardId, 'edit');
        if (!target.ok) return target.error!;
      }

      const agent = await agentManager.update(agent_id, parsed);
      if (!agent) return notFound('Agent');
      return jsonOk({ success: true, agent: agentView(agent) });
    }
  );

  server.tool(
    'delete_agent',
    'Delete an agent you can edit.',
    { agent_id: z.string().describe('Agent UUID') },
    async ({ agent_id }) => {
      const refused = refuseBasic(actor, 'delete agents');
      if (refused) return refused;

      const existing = agentManager.agents.get(agent_id);
      const allowed = await scopedAgent(actor, existing, 'edit');
      if (!allowed.ok) return allowed.error!;

      const ok = await agentManager.delete(agent_id);
      if (!ok) return notFound('Agent');
      return jsonOk({ success: true, agent_id });
    }
  );

  server.tool(
    'attach_tools_to_agent',
    'Attach skills (plugins) and/or MCP servers to an agent you can edit. Lists REPLACE the current ones; pass the full set. Use list_plugins / list_mcp_servers / list_agent_skills to discover valid ids.',
    {
      agent_id: z.string().describe('Agent UUID'),
      skills: z
        .array(z.string())
        .optional()
        .describe('Plugin/skill ids — replaces the current set'),
      mcp_servers: z
        .array(z.string())
        .optional()
        .describe('MCP server ids — replaces the current set'),
    },
    async ({ agent_id, skills, mcp_servers }) => {
      const refused = refuseBasic(actor, 'modify agents');
      if (refused) return refused;
      if (skills === undefined && mcp_servers === undefined) {
        return jsonError('Provide skills and/or mcp_servers.');
      }

      const existing = agentManager.agents.get(agent_id);
      const allowed = await scopedAgent(actor, existing, 'edit');
      if (!allowed.ok) return allowed.error!;

      // Reject unknown ids rather than storing a dangling reference that only
      // surfaces later as a silently missing tool at runtime.
      if (mcp_servers) {
        const unknown = mcp_servers.filter(id => !mcpManager.getById(id));
        if (unknown.length) return jsonError(`Unknown MCP server id(s): ${unknown.join(', ')}`);
      }
      if (skills) {
        const known = new Set(
          skillManager.getAll(actor.userId, actor.role === 'admin').map((s: McpRecord) => s.id)
        );
        const unknown = skills.filter(id => !known.has(id));
        if (unknown.length) return jsonError(`Unknown plugin/skill id(s): ${unknown.join(', ')}`);
      }

      const updates: Record<string, unknown> = {};
      if (skills !== undefined) updates.skills = skills;
      if (mcp_servers !== undefined) updates.mcpServers = mcp_servers;
      const agent = await agentManager.update(agent_id, updates);
      if (!agent) return notFound('Agent');
      return jsonOk({ success: true, agent: agentView(agent) });
    }
  );

  // ── Catalogues ──────────────────────────────────────────────────────────

  server.tool(
    'list_plugins',
    'List the plugins (skills) available to you, for attach_tools_to_agent.',
    {},
    async () => {
      // Same visibility filter GET /api/plugins applies.
      const plugins = skillManager.getAll(actor.userId, actor.role === 'admin') as McpRecord[];
      return jsonOk({
        count: plugins.length,
        plugins: plugins.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description || null,
          mcpServerId: p.mcpServerId || null,
        })),
      });
    }
  );

  server.tool(
    'list_mcp_servers',
    'List the configured MCP servers, for attach_tools_to_agent. Secrets are never returned.',
    {},
    async () => {
      const servers = mcpManager.getAll() as McpRecord[];
      return jsonOk({
        count: servers.length,
        servers: servers.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || null,
          transport: s.transport || null,
          enabled: s.enabled !== false,
        })),
      });
    }
  );

  server.tool(
    'list_agent_skills',
    'List the reusable agent skill definitions (markdown skills agents can be given).',
    {},
    async () => {
      const skills = (await getAllAgentSkills()) as McpRecord[];
      return jsonOk({
        count: skills.length,
        skills: skills.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || null,
        })),
      });
    }
  );

  // ── Projects ────────────────────────────────────────────────────────────

  server.tool('list_projects', 'List the projects you can reach.', {}, async () => {
    // getProjectsForUser applies the same scoping GET /api/projects does.
    const projects = (await getProjectsForUser(actor.userId, actor.role)) as McpRecord[];
    return jsonOk({
      count: projects.length,
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description || null,
        owner_id: p.owner_id || null,
      })),
    });
  });

  server.tool(
    'create_project',
    'Create a project. Requires the advanced or admin role, mirroring POST /api/projects.',
    {
      name: z.string().min(1).max(200).describe('Project name (must be unique)'),
      description: z.string().max(5000).optional(),
      rules: z.string().max(20000).optional().describe('Project-wide rules given to agents'),
    },
    async ({ name, description, rules }) => {
      // The REST route is requireRole('admin','advanced'); same gate here.
      if (actor.role !== 'admin' && actor.role !== 'advanced') {
        return jsonError('Creating a project requires the advanced or admin role.');
      }
      if (await getProjectByName(name)) {
        return jsonError('A project with this name already exists');
      }
      // createProject's columns are NOT NULL-tolerant only by convention; the
      // REST route relies on its zod schema defaulting them, so default here too.
      const project = await createProject(name, description ?? '', rules ?? '', actor.userId);
      return jsonOk({ success: true, project });
    }
  );

  server.tool(
    'update_project',
    'Update a project you own. Requires the advanced or admin role.',
    {
      project_id: z.string().describe('Project UUID'),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(5000).optional(),
      rules: z.string().max(20000).optional(),
    },
    async ({ project_id, ...fields }) => {
      if (actor.role !== 'admin' && actor.role !== 'advanced') {
        return jsonError('Modifying a project requires the advanced or admin role.');
      }
      const project = await scopedProject(actor, project_id, 'edit');
      if (!project.ok) return project.error!;

      const updates = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(updates).length) return jsonError('Nothing to update.');

      const updated = await updateProject(project_id, updates);
      if (!updated) return notFound('Project');
      return jsonOk({ success: true, project: updated });
    }
  );

  server.tool(
    'delete_project',
    'Delete a project you own. Requires the advanced or admin role.',
    { project_id: z.string().describe('Project UUID') },
    async ({ project_id }) => {
      if (actor.role !== 'admin' && actor.role !== 'advanced') {
        return jsonError('Deleting a project requires the advanced or admin role.');
      }
      // 'admin' on the project, exactly like DELETE /api/projects/:id.
      const project = await scopedProject(actor, project_id, 'admin');
      if (!project.ok) return project.error!;

      const ok = await deleteProject(project_id);
      if (!ok) return notFound('Project');
      return jsonOk({ success: true, project_id });
    }
  );

  server.tool(
    'get_board',
    'Read a board and its complete workflow (columns, conditions, actions and version), plugins and filters. Credentials are excluded.',
    { board_id: z.string().describe('Board UUID') },
    async ({ board_id }) => {
      const board = await scopedBoard(actor, board_id, 'read');
      if (!board.ok) return board.error!;
      return jsonOk({ board: boardView(board.value) });
    }
  );

  // ── Boards ──────────────────────────────────────────────────────────────

  server.tool(
    'list_boards',
    'List the boards you can reach, with their workflow columns.',
    {},
    async () => {
      const boards = await getBoardsByUser(actor.userId);
      return jsonOk({ count: boards.length, boards: boards.map(boardView) });
    }
  );

  server.tool(
    'create_board',
    'Create a board. You become its owner.',
    {
      name: z.string().min(1).max(200).describe('Board name'),
      columns: z
        .array(workflowColumnSchema)
        .max(50)
        .optional()
        .describe('Workflow columns. Omit for the default workflow.'),
    },
    async ({ name, columns }) => {
      const workflow =
        columns && columns.length
          ? { columns, transitions: [], version: 1 }
          : JSON.parse(JSON.stringify(DEFAULT_BOARD_WORKFLOW));
      // Ids are derived from labels by the same normalizer the REST route uses,
      // so a board created here and one created in the UI are indistinguishable.
      const normalized = normalizeWorkflowColumnIds(workflow, null);
      const board = await createBoard(actor.userId, name.trim(), normalized.workflow, {});
      return jsonOk({ success: true, board: boardView(board) });
    }
  );

  server.tool(
    'update_board',
    'Rename a board you can edit, or attach it to a project. Use set_board_workflow to change columns.',
    {
      board_id: z.string().describe('Board UUID'),
      name: z.string().min(1).max(200).optional(),
      project_id: z.string().nullable().optional().describe('Project to attach to, or null'),
    },
    async ({ board_id, name, project_id }) => {
      const board = await scopedBoard(actor, board_id, 'edit');
      if (!board.ok) return board.error!;

      const fields: Record<string, unknown> = {};
      if (name !== undefined) fields.name = name.trim();
      if (project_id !== undefined) {
        if (project_id) {
          // Linking needs edit on the project as well — the same pair of checks
          // POST /api/projects/:id/boards/:boardId performs.
          const project = await scopedProject(actor, project_id, 'edit');
          if (!project.ok) return project.error!;
        }
        fields.project_id = project_id;
      }
      if (!Object.keys(fields).length) return jsonError('Nothing to update.');

      const updated = await updateBoard(board_id, fields);
      if (!updated) return notFound('Board');
      return jsonOk({ success: true, board: boardView(updated) });
    }
  );

  server.tool(
    'delete_board',
    'Delete a board. Requires admin permission on it (owner or system admin).',
    { board_id: z.string().describe('Board UUID') },
    async ({ board_id }) => {
      const board = await scopedBoard(actor, board_id, 'admin');
      if (!board.ok) return board.error!;
      const ok = await deleteBoard(board_id);
      if (!ok) return notFound('Board');
      return jsonOk({ success: true, board_id });
    }
  );

  server.tool(
    'set_board_workflow',
    'Replace a board workflow (its columns and transitions). Column ids are derived from labels by the same normalizer the UI uses, and renaming a label migrates the tasks sitting in that column.',
    {
      board_id: z.string().describe('Board UUID'),
      columns: z
        .array(workflowColumnSchema)
        .max(50)
        .min(1)
        .describe('The full ordered column list'),
      transitions: z
        .array(workflowTransitionSchema)
        .max(200)
        .optional()
        .describe('Full transition list. Omit to preserve existing transitions; [] removes them.'),
    },
    async ({ board_id, columns, transitions }) => {
      const board = await scopedBoard(actor, board_id, 'edit');
      if (!board.ok) return board.error!;

      // Same call as PUT /api/boards/:id/workflow, so ids, renames and the
      // version bump behave identically.
      const { workflow, renames } = normalizeWorkflowColumnIds(
        {
          ...board.value.workflow,
          columns,
          transitions: transitions ?? board.value.workflow?.transitions ?? [],
        },
        board.value.workflow
      );
      const newWorkflow = { ...workflow, version: (board.value.workflow?.version || 0) + 1 };
      const updated = await updateBoard(board_id, { workflow: newWorkflow });
      await applyColumnRenamesToBoardTasks(agentManager, board_id, renames, actor.username);
      agentManager._refreshWorkflowManagedStatuses?.();

      return jsonOk({
        success: true,
        board: boardView(updated),
        renamed_columns: renames.map((r: McpRecord) => ({ from: r.from, to: r.to })),
      });
    }
  );

  // ── Board shares ────────────────────────────────────────────────────────

  server.tool(
    'list_board_shares',
    'List who a board is shared with. Requires admin permission on the board.',
    { board_id: z.string().describe('Board UUID') },
    async ({ board_id }) => {
      const board = await scopedBoard(actor, board_id, 'admin');
      if (!board.ok) return board.error!;
      const shares = (await getBoardShares(board_id)) as McpRecord[];
      return jsonOk({
        count: shares.length,
        shares: shares.map(s => ({
          user_id: s.user_id,
          username: s.username || null,
          permission: s.permission,
        })),
      });
    }
  );

  server.tool(
    'share_board',
    'Share a board with another user. Requires admin permission on the board.',
    {
      board_id: z.string().describe('Board UUID'),
      username: z.string().describe('Username to share with'),
      permission: z.enum(['read', 'edit', 'admin']).describe('Permission to grant'),
    },
    async ({ board_id, username, permission }) => {
      const board = await scopedBoard(actor, board_id, 'admin');
      if (!board.ok) return board.error!;

      const users = (await getAllUsers()) as McpRecord[];
      const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
      if (!target) return jsonError(`User "${username}" not found`);
      // Same two refusals as POST /api/boards/:id/shares.
      if (target.id === actor.userId) return jsonError('Cannot share a board with yourself');
      if (target.id === board.value.user_id) {
        return jsonError('Cannot share with the board owner');
      }

      const share = await createBoardShare(board_id, target.id, permission, actor.userId);
      return jsonOk({ success: true, share });
    }
  );

  // ── Users ───────────────────────────────────────────────────────────────

  server.tool(
    'list_users',
    'List the instance users. Requires the admin ROLE on the key owner — the admin key SCOPE is not enough.',
    {},
    async () => {
      // The one genuinely instance-wide tool on this surface. See the module
      // header: scope selects tools, role decides reach.
      const admin = requireAdminRole(actor, 'list_users');
      if (!admin.ok) return admin.error!;

      const users = (await getAllUsers()) as McpRecord[];
      return jsonOk({
        count: users.length,
        users: users.map(u => ({
          id: u.id,
          username: u.username,
          display_name: u.display_name || null,
          role: u.role,
        })),
      });
    }
  );

  return server;
}

/** Express handler for POST /api/mcp/admin. */
export function createAdminMcpHandler(
  agentManager: AgentManager,
  mcpManager: MCPManager,
  skillManager: SkillManager
) {
  return createMcpHttpHandler('Admin', ctx => {
    if (!ctx.user) {
      throw new Error('Admin MCP requires an authenticated API key');
    }
    return createAdminMcpServer(agentManager, mcpManager, skillManager, ctx.user);
  });
}
