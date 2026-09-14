// ── Project configuration export / import ────────────────────────────────────
//
// Two properties are load-bearing and are what this suite pins:
//
//   1. A bundle carries NO credential. It is meant to be mailed and committed,
//      so an agent API key, an agent credential, a per-agent MCP auth entry, a
//      board's mcp_auth or a plugin/MCP-server apiKey must never appear in it —
//      only the booleans saying one is still needed.
//   2. An import CREATES and never overwrites: a free project name, boards and
//      agents owned by the importer, plugin / MCP ids remapped to whatever the
//      target instance ended up with.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const db = {
  boards: [] as any[],
  agents: {} as Record<string, any[]>,
  llmConfigs: [] as any[],
  existingProjectNames: new Set<string>(),
  createdProjects: [] as any[],
  createdBoards: [] as any[],
  boardUpdates: [] as any[],
  boardProjectLinks: [] as any[],
};

let boardSeq = 0;

mock.module('../database.js', {
  namedExports: {
    getBoardsForProject: async () => db.boards,
    getAgentsByBoard: async (boardId: string) => db.agents[boardId] || [],
    getReposForBoard: async () => [{ provider: 'github', fullName: 'acme/api', htmlUrl: '' }],
    getStoragesForBoard: async () => [],
    getAllLlmConfigs: async () => db.llmConfigs,
    getProjectByName: async (name: string) =>
      db.existingProjectNames.has(name) ? { id: 'existing', name } : null,
    createProject: async (name: string, description: string, rules: string, ownerId: string) => {
      const project = {
        id: `proj-${db.createdProjects.length + 1}`,
        name,
        description,
        rules,
        ownerId,
      };
      db.createdProjects.push(project);
      return project;
    },
    createBoard: async (userId: string, name: unknown, workflow: any, filters: any) => {
      const board = { id: `new-board-${++boardSeq}`, user_id: userId, name, workflow, filters };
      db.createdBoards.push(board);
      return board;
    },
    updateBoard: async (id: string, fields: any) => {
      db.boardUpdates.push({ id, fields });
      return { id, ...fields };
    },
    setBoardProject: async (boardId: string, projectId: string | null) => {
      db.boardProjectLinks.push({ boardId, projectId });
      return true;
    },
  },
});

const { exportProjectConfig, importProjectConfig, PROJECT_EXPORT_FORMAT } =
  await import('../projectTransfer.js');

// ── Fakes for the three managers ────────────────────────────────────────────

function fakeSkillManager(plugins: any[]) {
  const byId = new Map(plugins.map(p => [p.id, p]));
  const created: any[] = [];
  return {
    created,
    getById: (id: string) => byId.get(id) || null,
    canView: () => true,
    create: async (config: any, ownerId: string) => {
      const plugin = { id: `new-plugin-${created.length + 1}`, ...config, ownerId };
      created.push(plugin);
      byId.set(plugin.id, plugin);
      return plugin;
    },
  } as any;
}

function fakeMcpManager(servers: any[]) {
  const byId = new Map(servers.map(s => [s.id, s]));
  const created: any[] = [];
  return {
    created,
    getById: (id: string) => byId.get(id) || null,
    create: async (config: any) => {
      const server = { id: `new-mcp-${created.length + 1}`, ...config };
      created.push(server);
      byId.set(server.id, server);
      return server;
    },
  } as any;
}

function fakeAgentManager() {
  const created: any[] = [];
  return {
    created,
    create: async (config: any) => {
      created.push(config);
      return { id: `new-agent-${created.length}`, ...config };
    },
  } as any;
}

const ACTOR = { userId: 'user-A', role: 'admin' };

function resetDb() {
  db.boards = [];
  db.agents = {};
  db.llmConfigs = [];
  db.existingProjectNames = new Set();
  db.createdProjects = [];
  db.createdBoards = [];
  db.boardUpdates = [];
  db.boardProjectLinks = [];
  boardSeq = 0;
}

function seedSourceInstance() {
  resetDb();
  db.boards = [
    {
      id: 'board-1',
      name: 'Delivery',
      position: 0,
      workflow: { columns: [{ id: 'todo', label: 'To Do' }], transitions: [], version: 3 },
      filters: { hideDone: true },
      plugins: ['plugin-github'],
      // A board credential — must not travel.
      mcp_auth: { 'mcp-github': { apiKey: 'board-secret' } },
    },
  ];
  db.agents['board-1'] = [
    {
      id: 'agent-1',
      name: 'Dev',
      role: 'developer',
      instructions: 'Ship it.',
      skills: ['plugin-github'],
      mcpServers: ['mcp-jira'],
      llmConfigId: 'llm-1',
      boardId: 'board-1',
      ownerId: 'someone-else',
      // Every secret shape an agent can hold.
      apiKey: 'sk-super-secret',
      credentials: { GITHUB_TOKEN: 'ghp_secret' },
      mcpAuth: { 'mcp-jira': { apiKey: 'jira-secret' } },
      conversationHistory: [{ role: 'user', content: 'secret conversation' }],
    },
  ];
  db.llmConfigs = [
    { id: 'llm-1', name: 'GPT', provider: 'openai', model: 'gpt-4', apiKey: 'sk-1' },
  ];
}

const SOURCE_PLUGINS = [
  {
    id: 'plugin-github',
    name: 'GitHub',
    description: 'Git hosting',
    category: 'devops',
    icon: '🐙',
    instructions: 'Use the GitHub MCP.',
    userConfig: { org: 'acme' },
    builtin: false,
    shared: false,
    mcps: [
      { id: 'mcp-github', name: 'GitHub MCP', url: 'https://mcp.example/gh', apiKey: 'gh-key' },
    ],
  },
];

const SOURCE_MCPS = [
  { id: 'mcp-github', name: 'GitHub MCP', url: 'https://mcp.example/gh', apiKey: 'gh-key' },
  { id: 'mcp-jira', name: 'Jira MCP', url: 'https://mcp.example/jira', apiKey: '' },
];

// ── Export ──────────────────────────────────────────────────────────────────

test('export carries the whole configuration and not one credential', async () => {
  seedSourceInstance();
  const bundle = await exportProjectConfig(
    { id: 'proj-src', name: 'Apollo', description: 'desc', rules: 'be nice' },
    ACTOR,
    { skillManager: fakeSkillManager(SOURCE_PLUGINS), mcpManager: fakeMcpManager(SOURCE_MCPS) }
  );

  assert.equal(bundle.format, PROJECT_EXPORT_FORMAT);
  assert.equal(bundle.project.name, 'Apollo');
  assert.equal(bundle.project.rules, 'be nice');

  // Boards travel with their workflow, filters and plugin wiring.
  assert.equal(bundle.boards.length, 1);
  const board = bundle.boards[0];
  assert.equal(board.name, 'Delivery');
  assert.deepEqual(board.plugins, ['plugin-github']);
  assert.deepEqual(board.workflow.columns, [{ id: 'todo', label: 'To Do' }]);
  assert.deepEqual(board.filters, { hideDone: true });

  // Agents travel as configuration, with presence markers instead of secrets.
  assert.equal(board.agents.length, 1);
  const agent = board.agents[0] as any;
  assert.equal(agent.name, 'Dev');
  assert.equal(agent.instructions, 'Ship it.');
  assert.equal(agent.apiKey, undefined);
  assert.equal(agent.credentials, undefined);
  assert.equal(agent.mcpAuth, undefined);
  assert.equal(agent.conversationHistory, undefined);
  assert.deepEqual(agent.configuredSecrets, {
    apiKey: true,
    credentials: ['GITHUB_TOKEN'],
    mcpAuth: ['mcp-jira'],
  });

  // Plugins and MCP servers referenced by boards OR agents are all included.
  assert.deepEqual(
    bundle.plugins.map(p => p.id),
    ['plugin-github']
  );
  assert.deepEqual(bundle.plugins[0].mcpServerIds, ['mcp-github']);
  assert.deepEqual(bundle.mcpServers.map(s => s.id).sort(), ['mcp-github', 'mcp-jira']);
  // The key itself never travels — only the fact that one is needed.
  const gh = bundle.mcpServers.find(s => s.id === 'mcp-github')!;
  assert.equal(gh.requiresApiKey, true);
  assert.equal((gh as any).apiKey, undefined);

  // LLM configs are references only.
  assert.deepEqual(bundle.llmConfigs, [
    { id: 'llm-1', name: 'GPT', provider: 'openai', model: 'gpt-4' },
  ]);

  // Belt and braces: no secret string survives anywhere in the document.
  const serialized = JSON.stringify(bundle);
  for (const secret of [
    'sk-super-secret',
    'ghp_secret',
    'jira-secret',
    'board-secret',
    'gh-key',
    'secret conversation',
  ]) {
    assert.equal(serialized.includes(secret), false, `bundle leaked "${secret}"`);
  }
});

// ── Import ──────────────────────────────────────────────────────────────────

async function exportedBundle() {
  seedSourceInstance();
  return exportProjectConfig({ id: 'proj-src', name: 'Apollo' }, ACTOR, {
    skillManager: fakeSkillManager(SOURCE_PLUGINS),
    mcpManager: fakeMcpManager(SOURCE_MCPS),
  });
}

test('import recreates everything on a bare instance and remaps the ids', async () => {
  const bundle = await exportedBundle();
  resetDb();

  const skillManager = fakeSkillManager([]);
  const mcpManager = fakeMcpManager([]);
  const agentManager = fakeAgentManager();
  const result = await importProjectConfig(bundle, ACTOR, {
    agentManager,
    skillManager,
    mcpManager,
  });

  assert.equal(result.project.name, 'Apollo');
  assert.equal(result.createdPlugins, 1);
  assert.equal(result.createdMcpServers, 2);
  assert.equal(result.createdAgents, 1);
  assert.equal(result.boards.length, 1);
  assert.equal(result.boards[0].sourceId, 'board-1');

  // The board is attached to the NEW project and wired to the NEW plugin id.
  assert.deepEqual(db.boardProjectLinks, [
    { boardId: 'new-board-1', projectId: result.project.id },
  ]);
  const newPluginId = skillManager.created[0].id;
  assert.deepEqual(db.boardUpdates, [{ id: 'new-board-1', fields: { plugins: [newPluginId] } }]);

  // The agent points at the new plugin / MCP ids, is owned by the importer, and
  // comes in without any credential.
  const agent = agentManager.created[0];
  assert.deepEqual(agent.skills, [newPluginId]);
  assert.equal(agent.mcpServers.length, 1);
  assert.notEqual(agent.mcpServers[0], 'mcp-jira');
  assert.equal(agent.ownerId, 'user-A');
  assert.equal(agent.boardId, 'new-board-1');
  assert.deepEqual(agent.credentials, {});
  assert.deepEqual(agent.mcpAuth, {});
  assert.equal(agent.apiKey, undefined);

  // The missing LLM config and the missing MCP key are reported, not hidden.
  assert.ok(result.warnings.some(w => w.includes('GPT')));
  assert.ok(result.warnings.some(w => w.includes('API key')));
});

test('import reuses plugins and MCP servers that already exist under the same id', async () => {
  const bundle = await exportedBundle();
  resetDb();

  const skillManager = fakeSkillManager(SOURCE_PLUGINS);
  const mcpManager = fakeMcpManager(SOURCE_MCPS);
  const result = await importProjectConfig(
    bundle,
    { ...ACTOR, role: 'advanced' },
    {
      agentManager: fakeAgentManager(),
      skillManager,
      mcpManager,
    }
  );

  assert.equal(result.reusedPlugins, 1);
  assert.equal(result.createdPlugins, 0);
  assert.equal(result.reusedMcpServers, 2);
  assert.equal(result.createdMcpServers, 0);
  assert.deepEqual(db.boardUpdates, [
    { id: 'new-board-1', fields: { plugins: ['plugin-github'] } },
  ]);
});

test('import never overwrites: a taken project name is suffixed', async () => {
  const bundle = await exportedBundle();
  resetDb();
  db.existingProjectNames = new Set(['Apollo', 'Apollo (2)']);

  const result = await importProjectConfig(bundle, ACTOR, {
    agentManager: fakeAgentManager(),
    skillManager: fakeSkillManager([]),
    mcpManager: fakeMcpManager([]),
  });

  assert.equal(result.project.name, 'Apollo (3)');
  assert.ok(result.warnings.some(w => w.includes('already exists')));
});

test('import honours the name override and includeAgents:false', async () => {
  const bundle = await exportedBundle();
  resetDb();

  const agentManager = fakeAgentManager();
  const result = await importProjectConfig(
    bundle,
    ACTOR,
    { agentManager, skillManager: fakeSkillManager([]), mcpManager: fakeMcpManager([]) },
    { name: 'Apollo Staging', includeAgents: false }
  );

  assert.equal(result.project.name, 'Apollo Staging');
  assert.equal(result.createdAgents, 0);
  assert.equal(agentManager.created.length, 0);
});

test('import refuses a document that is not a project bundle', async () => {
  resetDb();
  await assert.rejects(
    () =>
      importProjectConfig({ hello: 'world' }, ACTOR, {
        agentManager: fakeAgentManager(),
        skillManager: fakeSkillManager([]),
        mcpManager: fakeMcpManager([]),
      }),
    /Invalid project bundle/
  );
  assert.equal(db.createdProjects.length, 0);
});
