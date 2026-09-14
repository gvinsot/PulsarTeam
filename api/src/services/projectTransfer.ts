// ── Project configuration export / import ────────────────────────────────────
//
// One project's WHOLE configuration as a single portable document: the project
// itself, every board attached to it (workflow, filters, plugin wiring), every
// agent standing on those boards, and the plugin / MCP-server definitions those
// two reference. The same bundle is produced by `GET /api/projects/:id/export`
// and by the `export_project` admin MCP tool, and consumed by
// `POST /api/projects/import` / `import_project`.
//
// TWO RULES GOVERN EVERYTHING HERE.
//
//  1. NO SECRETS EVER LEAVE. A bundle is meant to be mailed, committed and
//     replayed on another instance, so it carries configuration and nothing
//     that authenticates anybody: agent `apiKey` / `credentials` / `mcpAuth`,
//     plugin and MCP-server `apiKey`, board `mcp_auth`, OAuth tokens and LLM
//     config keys are all dropped. `hasApiKey`-style booleans are kept so an
//     importer can see WHICH pieces still need credentials, and every one of
//     them is echoed back as an import warning.
//
//  2. NOTHING IS OVERWRITTEN ON IMPORT. An import only ever CREATES: a new
//     project (renamed when the name is taken), new boards, new agents. The
//     only things it reuses are plugins and MCP servers that already exist
//     under the same id — which is what makes a same-instance export/import a
//     clone rather than a duplicate of the whole plugin catalogue.
//
// Ids are the join keys inside the bundle: `boards[].plugins` holds SOURCE
// plugin ids, `agents[].skills` / `agents[].mcpServers` hold SOURCE ids, and
// the import builds source→target maps before creating anything that
// references them.

import { z } from 'zod';
import {
  createProject,
  getAgentsByBoard,
  getAllLlmConfigs,
  getBoardsForProject,
  getProjectByName,
  getReposForBoard,
  getStoragesForBoard,
  setBoardProject,
  createBoard,
  updateBoard,
} from './database.js';
import { createAgentSchema } from '../schemas/agents.js';
import { normalizeWorkflowColumnIds } from './workflow/columnIds.js';
import { DEFAULT_BOARD_WORKFLOW } from './boardDefaults.js';
import { errorMessage } from '../lib/errors.js';
import type { AgentManager } from './agentManager/index.js';
import type { MCPManager } from './mcpManager.js';
import type { SkillManager } from './skillManager.js';

/** Document type marker — refuse anything that is not one of ours. */
export const PROJECT_EXPORT_FORMAT = 'pulsarteam.project-config';
/** Bumped whenever the shape changes incompatibly. */
export const PROJECT_EXPORT_VERSION = 1;

/** Who is exporting/importing — the same pair every access helper takes. */
export interface TransferActor {
  userId: string;
  role: string;
}

/** Managers an import needs to create plugins, MCP servers and agents. */
export interface TransferDeps {
  agentManager: AgentManager;
  skillManager: SkillManager;
  mcpManager: MCPManager;
}

type Record_ = Record<string, unknown>;

// ── What of an agent travels ────────────────────────────────────────────────
//
// Derived from `createAgentSchema` rather than listed by hand, so a field added
// to the agent contract travels automatically. Secrets and the two fields the
// import supplies itself (board, batch size) are subtracted.

const AGENT_SECRET_FIELDS = new Set([
  'apiKey',
  'credentials',
  'mcpAuth',
  'copyApiKeyFromAgent',
  'todoList',
]);
const AGENT_IMPORT_MANAGED_FIELDS = new Set(['boardId', 'batchSize']);

const AGENT_EXPORT_FIELDS = Object.keys(createAgentSchema.shape).filter(
  field => !AGENT_SECRET_FIELDS.has(field) && !AGENT_IMPORT_MANAGED_FIELDS.has(field)
);

// ── Bundle shape ────────────────────────────────────────────────────────────

const mcpServerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().default(''),
  description: z.string().default(''),
  icon: z.string().default('🔌'),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
  /** True when the source server had a key — the import cannot carry it over. */
  requiresApiKey: z.boolean().default(false),
});

const pluginEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  category: z.string().default('general'),
  icon: z.string().default('🔧'),
  instructions: z.string().default(''),
  userConfig: z.record(z.string(), z.any()).default({}),
  builtin: z.boolean().default(false),
  shared: z.boolean().default(false),
  /** Source MCP-server ids this plugin wires in. */
  mcpServerIds: z.array(z.string()).default([]),
});

const agentEntrySchema = z
  .object({
    id: z.string().optional(),
    name: z.string().default('Unnamed Agent'),
    skills: z.array(z.string()).default([]),
    mcpServers: z.array(z.string()).default([]),
  })
  .catchall(z.any());

const boardEntrySchema = z
  .object({
    id: z.string().optional(),
    name: z.string().default('Imported board'),
    position: z.number().optional(),
    workflow: z.record(z.string(), z.any()).default({}),
    filters: z.record(z.string(), z.any()).default({}),
    /** Source plugin ids attached to the board. */
    plugins: z.array(z.string()).default([]),
    agents: z.array(agentEntrySchema).default([]),
    /** Derived from tasks — informational, never replayed. */
    repos: z.array(z.any()).default([]),
    storages: z.array(z.any()).default([]),
  })
  .catchall(z.any());

const llmConfigRefSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
});

export const projectBundleSchema = z.object({
  format: z.literal(PROJECT_EXPORT_FORMAT),
  version: z.number().int().min(1).max(PROJECT_EXPORT_VERSION),
  exportedAt: z.string().optional(),
  exportedBy: z.string().optional(),
  project: z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(200),
    description: z.string().default(''),
    rules: z.string().default(''),
  }),
  boards: z.array(boardEntrySchema).max(200).default([]),
  plugins: z.array(pluginEntrySchema).max(500).default([]),
  mcpServers: z.array(mcpServerEntrySchema).max(500).default([]),
  /** Reference only: LLM configs are instance-level and carry credentials. */
  llmConfigs: z.array(llmConfigRefSchema).max(200).default([]),
});

export type ProjectBundle = z.infer<typeof projectBundleSchema>;

/**
 * Body of `POST /api/projects/import`. The bundle itself stays `any` here and
 * is validated by `importProjectConfig`, so the caller gets one error message
 * describing what is wrong with the DOCUMENT rather than a generic 400.
 */
export const importRequestSchema = z.object({
  bundle: z.any(),
  name: z.string().min(1).max(200).optional(),
  includeAgents: z.boolean().optional(),
});

// ── Export ──────────────────────────────────────────────────────────────────

/** Strip an agent record down to the exportable configuration fields. */
function agentExportView(agent: Record_): z.infer<typeof agentEntrySchema> {
  const out: Record_ = { id: agent.id };
  for (const field of AGENT_EXPORT_FIELDS) {
    if (agent[field] !== undefined) out[field] = agent[field];
  }
  out.skills = Array.isArray(agent.skills) ? agent.skills : [];
  out.mcpServers = Array.isArray(agent.mcpServers) ? agent.mcpServers : [];
  // Presence markers so an importer knows what still needs wiring up, without
  // any of the values themselves.
  out.configuredSecrets = {
    apiKey: !!agent.apiKey,
    credentials: Object.keys((agent.credentials as Record_) || {}),
    mcpAuth: Object.keys((agent.mcpAuth as Record_) || {}),
  };
  // The fields the entry schema names are all written above; the catchall
  // carries the rest of AGENT_EXPORT_FIELDS.
  return out as z.infer<typeof agentEntrySchema>;
}

function mcpServerExportView(server: Record_): z.infer<typeof mcpServerEntrySchema> {
  return {
    id: String(server.id),
    name: String(server.name || 'Unnamed Server'),
    url: String(server.url || ''),
    description: String(server.description || ''),
    icon: String(server.icon || '🔌'),
    enabled: server.enabled !== false,
    builtin: server.builtin === true,
    requiresApiKey: !!server.apiKey,
  };
}

/**
 * Export the complete configuration of one project.
 *
 * Only the boards the caller can READ are included — the export is not a way to
 * read a co-owner's board. Callers must have already resolved read access on
 * the project itself (`checkProjectAccess` / `scopedProject`).
 */
export async function exportProjectConfig(
  project: { id: string; name: string; description?: string; rules?: string },
  actor: TransferActor,
  deps: Pick<TransferDeps, 'skillManager' | 'mcpManager'>
): Promise<ProjectBundle> {
  const { skillManager, mcpManager } = deps;
  const isAdmin = actor.role === 'admin';

  const boards = await getBoardsForProject(project.id, actor.userId, actor.role);

  const pluginIds = new Set<string>();
  const mcpServerIds = new Set<string>();
  const llmConfigIds = new Set<string>();

  const boardEntries = await Promise.all(
    boards.map(async (board: Record_) => {
      const boardPlugins: string[] = Array.isArray(board.plugins)
        ? (board.plugins as string[])
        : [];
      boardPlugins.forEach(id => pluginIds.add(id));

      const agents = (await getAgentsByBoard(String(board.id))) as unknown as Record_[];
      for (const agent of agents) {
        (Array.isArray(agent.skills) ? (agent.skills as string[]) : []).forEach(id =>
          pluginIds.add(id)
        );
        (Array.isArray(agent.mcpServers) ? (agent.mcpServers as string[]) : []).forEach(id =>
          mcpServerIds.add(id)
        );
        if (agent.llmConfigId) llmConfigIds.add(String(agent.llmConfigId));
      }

      return {
        id: String(board.id),
        name: String(board.name || 'Board'),
        position: typeof board.position === 'number' ? board.position : 0,
        workflow: (board.workflow as Record_) || {},
        filters: (board.filters as Record_) || {},
        plugins: boardPlugins,
        agents: agents.map(agentExportView),
        // Derived from tasks, so they are informational only: an import creates
        // no tasks and therefore cannot recreate them.
        repos: await getReposForBoard(String(board.id)),
        storages: await getStoragesForBoard(String(board.id)),
      };
    })
  );

  // Plugins referenced by boards or agents, with their MCP wiring. Unknown ids
  // are dropped rather than exported as dangling references.
  const plugins: z.infer<typeof pluginEntrySchema>[] = [];
  for (const id of pluginIds) {
    const plugin = skillManager.getById(id) as Record_ | null;
    if (!plugin) continue;
    if (!skillManager.canView(plugin as never, actor.userId, isAdmin)) continue;
    const embedded = Array.isArray(plugin.mcps) ? (plugin.mcps as Record_[]) : [];
    for (const mcp of embedded) {
      if (mcp?.id) mcpServerIds.add(String(mcp.id));
    }
    plugins.push({
      id: String(plugin.id),
      name: String(plugin.name || 'Unnamed plugin'),
      description: String(plugin.description || ''),
      category: String(plugin.category || 'general'),
      icon: String(plugin.icon || '🔧'),
      instructions: String(plugin.instructions || ''),
      userConfig: (plugin.userConfig as Record<string, unknown>) || {},
      builtin: plugin.builtin === true,
      shared: plugin.shared === true,
      mcpServerIds: embedded.map(m => String(m.id)).filter(Boolean),
    });
  }

  // MCP servers referenced by agents or by the plugins above. Resolved through
  // the manager so a plugin's embedded copy never leaks a stale apiKey.
  const mcpServers: z.infer<typeof mcpServerEntrySchema>[] = [];
  for (const id of mcpServerIds) {
    const server = mcpManager.getById(id) as Record_ | null;
    if (!server) continue;
    mcpServers.push(mcpServerExportView(server));
  }

  // LLM configs travel as references only — they are instance-level and hold
  // provider credentials. The import re-points agents by id, then by name.
  const allLlmConfigs = (await getAllLlmConfigs()) as unknown as Record_[];
  const llmConfigs = allLlmConfigs
    .filter(cfg => llmConfigIds.has(String(cfg.id)))
    .map(cfg => ({
      id: String(cfg.id),
      name: String(cfg.name || ''),
      provider: String(cfg.provider || ''),
      model: String(cfg.model || ''),
    }));

  return {
    format: PROJECT_EXPORT_FORMAT,
    version: PROJECT_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: actor.userId,
    project: {
      id: project.id,
      name: project.name,
      description: project.description || '',
      rules: project.rules || '',
    },
    boards: boardEntries,
    plugins,
    mcpServers,
    llmConfigs,
  };
}

// ── Import ──────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Override the project name. Defaults to the bundle's own name. */
  name?: string;
  /** Recreate the agents standing on each board. Default true. */
  includeAgents?: boolean;
}

/** A denied import must be reported as forbidden by HTTP callers. */
export class ProjectImportAuthorizationError extends Error {}

export interface ImportResult {
  project: { id: string; name: string };
  boards: Array<{ id: string; name: string; sourceId: string | null }>;
  createdAgents: number;
  createdPlugins: number;
  reusedPlugins: number;
  createdMcpServers: number;
  reusedMcpServers: number;
  warnings: string[];
}

/** `name`, `name (2)`, `name (3)`, … — the first one no project holds. */
async function resolveAvailableProjectName(name: string): Promise<string> {
  const base = name.trim().slice(0, 200) || 'Imported project';
  if (!(await getProjectByName(base))) return base;
  for (let n = 2; n <= 100; n++) {
    const candidate = `${base} (${n})`.slice(0, 200);
    if (!(await getProjectByName(candidate))) return candidate;
  }
  throw new Error(`Could not find a free name for project "${base}"`);
}

/**
 * Replay a bundle as a NEW project owned by `actor`.
 *
 * Enforces the advanced/admin project-creation gate and the admin-only global
 * MCP-creation policy before any writes or connections. Every created board and
 * agent is owned by the actor, whatever the bundle says: an import is never a
 * way to plant resources under someone else's account.
 */
export async function importProjectConfig(
  input: unknown,
  actor: TransferActor,
  deps: TransferDeps,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && actor.role !== 'advanced') {
    throw new ProjectImportAuthorizationError(
      'Importing a project requires the advanced or admin role.'
    );
  }
  const parsed = projectBundleSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `Invalid project bundle: ${first ? `${first.path.join('.') || '<root>'} — ${first.message}` : 'unrecognized shape'}`
    );
  }
  const bundle = parsed.data;
  const { agentManager, skillManager, mcpManager } = deps;
  const warnings: string[] = [];

  // The MCP catalogue is readable by every authenticated user. Resolve it once
  // before any side effects: advanced users may reuse these ids, but must never
  // create a global server (which also connects to its URL when enabled).
  const existingMcpIds = new Set(
    bundle.mcpServers.filter(server => mcpManager.getById(server.id)).map(server => server.id)
  );
  if (!isAdmin) {
    const missing = bundle.mcpServers.filter(server => !existingMcpIds.has(server.id));
    if (missing.length) {
      throw new ProjectImportAuthorizationError(
        `Import requires the admin role to create missing global MCP servers: ${missing.map(server => server.id).join(', ')}. Ask an administrator to configure them before importing.`
      );
    }
  }

  // 1. MCP servers ─ reuse by id, otherwise recreate (never with credentials).
  const mcpIdMap = new Map<string, string>();
  let createdMcpServers = 0;
  let reusedMcpServers = 0;
  for (const server of bundle.mcpServers) {
    if (existingMcpIds.has(server.id)) {
      mcpIdMap.set(server.id, server.id);
      reusedMcpServers++;
      continue;
    }
    if (server.builtin) {
      warnings.push(
        `Built-in MCP server "${server.name}" is not available on this instance — references to it were dropped.`
      );
      continue;
    }
    if (!server.url) {
      warnings.push(`MCP server "${server.name}" has no URL — skipped.`);
      continue;
    }
    try {
      const created = await mcpManager.create({
        name: server.name,
        url: server.url,
        description: server.description,
        icon: server.icon,
        enabled: server.enabled,
      });
      mcpIdMap.set(server.id, created.id);
      createdMcpServers++;
      if (server.requiresApiKey) {
        warnings.push(
          `MCP server "${server.name}" needs an API key — imported without one, set it in MCP settings.`
        );
      }
    } catch (err) {
      warnings.push(`MCP server "${server.name}" could not be created: ${errorMessage(err)}`);
    }
  }

  // 2. Plugins ─ reuse by id when the actor can already see one, else create a
  //    copy owned by the actor with its MCP wiring remapped.
  const pluginIdMap = new Map<string, string>();
  let createdPlugins = 0;
  let reusedPlugins = 0;
  for (const plugin of bundle.plugins) {
    const existing = skillManager.getById(plugin.id);
    if (existing && skillManager.canView(existing, actor.userId, isAdmin)) {
      pluginIdMap.set(plugin.id, plugin.id);
      reusedPlugins++;
      continue;
    }
    if (plugin.builtin) {
      warnings.push(
        `Built-in plugin "${plugin.name}" is not available on this instance — references to it were dropped.`
      );
      continue;
    }
    const mcps = plugin.mcpServerIds
      .map(id => mcpIdMap.get(id))
      .filter((id): id is string => !!id)
      .map(id => {
        const server = mcpManager.getById(id) as Record_ | null;
        return {
          id,
          name: String(server?.name || 'Linked MCP'),
          url: String(server?.url || ''),
          description: String(server?.description || ''),
          icon: String(server?.icon || '🔌'),
          enabled: server?.enabled !== false,
          userConfig: {},
        };
      });
    try {
      const created = await skillManager.create(
        {
          name: plugin.name,
          description: plugin.description,
          category: plugin.category,
          icon: plugin.icon,
          instructions: plugin.instructions,
          userConfig: plugin.userConfig,
          mcps,
          shared: false,
        },
        actor.userId
      );
      pluginIdMap.set(plugin.id, created.id);
      createdPlugins++;
    } catch (err) {
      warnings.push(`Plugin "${plugin.name}" could not be created: ${errorMessage(err)}`);
    }
  }

  // 3. LLM configs ─ by id, then by name. Never created: they hold credentials.
  const llmConfigIdMap = new Map<string, string>();
  const existingLlmConfigs = (await getAllLlmConfigs()) as unknown as Record_[];
  const byId = new Map(existingLlmConfigs.map(c => [String(c.id), c]));
  const byName = new Map(
    existingLlmConfigs.filter(c => c.name).map(c => [String(c.name).toLowerCase(), c])
  );
  for (const ref of bundle.llmConfigs) {
    if (byId.has(ref.id)) {
      llmConfigIdMap.set(ref.id, ref.id);
      continue;
    }
    const match = ref.name ? byName.get(ref.name.toLowerCase()) : undefined;
    if (match) {
      llmConfigIdMap.set(ref.id, String(match.id));
      warnings.push(
        `LLM config "${ref.name}" was matched by name — verify the model and credentials.`
      );
      continue;
    }
    warnings.push(
      `LLM config "${ref.name || ref.id}" does not exist here — agents using it fall back to the default.`
    );
  }

  // 4. Project.
  const projectName = await resolveAvailableProjectName(options.name || bundle.project.name);
  if (projectName !== (options.name || bundle.project.name)) {
    warnings.push(
      `A project named "${options.name || bundle.project.name}" already exists — imported as "${projectName}".`
    );
  }
  const project = await createProject(
    projectName,
    bundle.project.description,
    bundle.project.rules,
    actor.userId
  );

  // 5. Boards (+ their agents).
  const includeAgents = options.includeAgents !== false;
  const createdBoards: ImportResult['boards'] = [];
  let createdAgents = 0;

  const orderedBoards = [...bundle.boards].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const boardEntry of orderedBoards) {
    const rawWorkflow =
      boardEntry.workflow && Array.isArray((boardEntry.workflow as Record_).columns)
        ? boardEntry.workflow
        : JSON.parse(JSON.stringify(DEFAULT_BOARD_WORKFLOW));
    // Same normalizer the UI and the REST route use, so an imported board is
    // indistinguishable from a hand-made one.
    const { workflow } = normalizeWorkflowColumnIds(rawWorkflow, null);

    const board = await createBoard(actor.userId, boardEntry.name, workflow, boardEntry.filters);

    const plugins = boardEntry.plugins
      .map(id => pluginIdMap.get(id))
      .filter((id): id is string => !!id);
    if (plugins.length) await updateBoard(board.id, { plugins });
    await setBoardProject(board.id, project.id);

    createdBoards.push({ id: board.id, name: board.name, sourceId: boardEntry.id ?? null });

    if (!includeAgents) continue;
    for (const agentEntry of boardEntry.agents) {
      const { id: _sourceId, configuredSecrets, ...config } = agentEntry as Record_;
      const secrets = (configuredSecrets as Record_) || {};
      const skills = (agentEntry.skills || [])
        .map(id => pluginIdMap.get(id))
        .filter((id): id is string => !!id);
      const mcpServers = (agentEntry.mcpServers || [])
        .map(id => mcpIdMap.get(id))
        .filter((id): id is string => !!id);
      const llmConfigId = agentEntry.llmConfigId
        ? (llmConfigIdMap.get(String(agentEntry.llmConfigId)) ?? null)
        : null;

      try {
        await agentManager.create({
          ...config,
          skills,
          mcpServers,
          llmConfigId,
          boardId: board.id,
          ownerId: actor.userId,
          // Runtime state and credentials are never replayed.
          mcpAuth: {},
          credentials: {},
        });
        createdAgents++;
        if (secrets.apiKey) {
          warnings.push(`Agent "${agentEntry.name}" had its own API key — imported without it.`);
        }
        const missingCreds = Array.isArray(secrets.credentials) ? secrets.credentials : [];
        if (missingCreds.length) {
          warnings.push(
            `Agent "${agentEntry.name}" needs credentials: ${missingCreds.join(', ')} — imported empty.`
          );
        }
      } catch (err) {
        warnings.push(`Agent "${agentEntry.name}" could not be created: ${errorMessage(err)}`);
      }
    }
  }

  return {
    project: { id: project.id, name: project.name },
    boards: createdBoards,
    createdAgents,
    createdPlugins,
    reusedPlugins,
    createdMcpServers,
    reusedMcpServers,
    warnings,
  };
}
