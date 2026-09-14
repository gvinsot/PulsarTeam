import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { TransferDeps } from '../projectTransfer.js';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';

// Keep the actual service, role middleware and MCP manager. Stub persistence and
// the network boundary so a forbidden import cannot hide a write or connection.
const realDb = await import('../database.js');
const saveMcpServer = mock.fn(async () => {});
const createProject = mock.fn(async (name: string) => ({ id: 'project-new', name }));
const createBoard = mock.fn(async () => ({ id: 'board-new', name: 'Imported board' }));
const updateBoard = mock.fn(async () => {});
const setBoardProject = mock.fn(async () => {});
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    saveMcpServer,
    createProject,
    createBoard,
    updateBoard,
    setBoardProject,
    getProjectByName: async () => null,
    getAllLlmConfigs: async () => [],
  },
});

const { MCPManager } = await import('../mcpManager.js');
const { projectRoutes } = await import('../../routes/projects.js');
const { createAdminMcpServer } = await import('../mcp/adminMcp.js');
const { importProjectConfig, PROJECT_EXPORT_FORMAT, ProjectImportAuthorizationError } =
  await import('../projectTransfer.js');

function fixture(existing: boolean) {
  for (const fn of [saveMcpServer, createProject, createBoard, updateBoard, setBoardProject]) {
    fn.mock.resetCalls();
  }
  const mcpManager = new MCPManager();
  const connect = mock.method(mcpManager, 'connect', async () => {});
  const create = mock.method(mcpManager, 'create');
  const update = mock.method(mcpManager, 'update');
  const pluginCreate = mock.fn(async (config: Record<string, unknown>) => ({
    id: 'plugin-new',
    ...config,
  }));
  const agentCreate = mock.fn(async (config: Record<string, unknown>) => ({
    id: 'agent-new',
    ...config,
  }));
  const deps: TransferDeps = {
    mcpManager,
    skillManager: {
      getById: () => null,
      create: pluginCreate,
    } as unknown as TransferDeps['skillManager'],
    agentManager: { create: agentCreate } as unknown as TransferDeps['agentManager'],
  };
  const original = {
    id: 'mcp-existing',
    name: 'Existing server',
    url: 'https://approved.example/mcp',
    enabled: false,
    apiKey: 'existing-secret',
  };
  mcpManager.servers.set(original.id, { ...original });
  const serverId = existing ? original.id : 'mcp-missing';
  const bundle = {
    format: PROJECT_EXPORT_FORMAT,
    version: 1,
    project: { name: 'Import' },
    mcpServers: [
      { id: original.id, name: 'Untrusted override', url: 'https://untrusted.example/mcp' },
      ...(existing
        ? []
        : [
            { id: serverId, name: 'Missing server', url: 'https://new.example/mcp', enabled: true },
          ]),
    ],
    plugins: [{ id: 'plugin-source', name: 'Plugin', mcpServerIds: [serverId] }],
    boards: [
      {
        name: 'Board',
        plugins: ['plugin-source'],
        agents: [{ name: 'Agent', mcpServers: [serverId] }],
      },
    ],
  };
  function assertNoSideEffects() {
    for (const fn of [
      saveMcpServer,
      createProject,
      createBoard,
      updateBoard,
      setBoardProject,
      create,
      update,
      connect,
      pluginCreate,
      agentCreate,
    ]) {
      assert.equal(fn.mock.callCount(), 0);
    }
    assert.deepEqual([...mcpManager.servers.values()], [original]);
  }
  return {
    deps,
    bundle,
    original,
    create,
    connect,
    update,
    pluginCreate,
    agentCreate,
    assertNoSideEffects,
  };
}

// Exercise the actual registered MCP tool callback, as in scopedMcpSurfaces.test.ts.
type ImportTool = (args: { bundle: unknown }) => Promise<{
  isError?: boolean;
  content: Array<{ text: string }>;
}>;

for (const surface of ['REST', 'MCP', 'service'] as const) {
  for (const role of ['basic', 'advanced', 'admin']) {
    for (const existing of [false, true]) {
      test(`${surface}: ${role} importing ${existing ? 'existing' : 'missing'} global MCP servers`, async () => {
        const f = fixture(existing);
        const actor = harnessUser({ role });
        const allowed = role === 'admin' || (role === 'advanced' && existing);
        let result: Record<string, unknown>;
        if (surface === 'REST') {
          const { agentManager, skillManager, mcpManager } = f.deps;
          const response = await createRouteHarness(
            projectRoutes(agentManager, skillManager, mcpManager),
            actor
          ).post('/import', { bundle: f.bundle });
          assert.equal(response.status, allowed ? 201 : 403);
          result = (await response.json()) as Record<string, unknown>;
        } else if (surface === 'MCP') {
          const { agentManager, skillManager, mcpManager } = f.deps;
          const server = createAdminMcpServer(agentManager, mcpManager, skillManager, actor);
          try {
            const registered = (
              server as unknown as {
                _registeredTools: Record<string, { handler: ImportTool }>;
              }
            )._registeredTools.import_project;
            assert.ok(registered);
            const response = await registered.handler({ bundle: f.bundle });
            assert.equal(response.isError === true, !allowed);
            result = JSON.parse(response.content[0].text) as Record<string, unknown>;
          } finally {
            await server.close();
          }
        } else {
          if (!allowed) {
            await assert.rejects(
              importProjectConfig(f.bundle, actor, f.deps),
              ProjectImportAuthorizationError
            );
            f.assertNoSideEffects();
            return;
          }
          result = { ...(await importProjectConfig(f.bundle, actor, f.deps)) };
        }
        if (!allowed) {
          assert.equal(typeof result.error, 'string');
          if (role === 'advanced') {
            assert.match(String(result.error), /admin role.*mcp-missing/);
          }
          f.assertNoSideEffects();
          return;
        }
        assert.equal(result.createdMcpServers, existing ? 0 : 1);
        assert.equal(result.reusedMcpServers, 1);
        assert.equal(result.createdPlugins, 1);
        assert.equal(result.createdAgents, 1);
        assert.equal(createProject.mock.callCount(), 1);
        assert.equal(createBoard.mock.callCount(), 1);
        assert.equal(saveMcpServer.mock.callCount(), existing ? 0 : 1);
        assert.equal(f.create.mock.callCount(), existing ? 0 : 1);
        assert.equal(f.connect.mock.callCount(), existing ? 0 : 1);
        assert.equal(f.update.mock.callCount(), 0);
        assert.deepEqual(f.deps.mcpManager.getById(f.original.id), f.original);
        const target = existing ? f.original : await f.create.mock.calls[0].result;
        assert.ok(target);
        const resolvedId = target.id;
        assert.deepEqual(f.agentCreate.mock.calls[0].arguments[0].mcpServers, [resolvedId]);
        const mcps = f.pluginCreate.mock.calls[0].arguments[0].mcps as Array<{
          id: string;
          url: string;
        }>;
        assert.equal(mcps[0].id, resolvedId);
        if (existing) assert.equal(mcps[0].url, f.original.url);
      });
    }
  }
}

for (const overrides of [{ enabled: false }, { builtin: true }, { url: '' }]) {
  test(`advanced missing MCP preflight cannot be bypassed by ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(false);
    Object.assign(f.bundle.mcpServers[1], overrides);
    await assert.rejects(
      importProjectConfig(f.bundle, harnessUser({ role: 'advanced' }), f.deps, {
        includeAgents: false,
      }),
      ProjectImportAuthorizationError
    );
    f.assertNoSideEffects();
  });
}
