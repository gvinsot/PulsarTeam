/**
 * The generated API documentation (services/apiDocs.ts) must describe what the
 * server RUNS — not what someone remembered to write down.
 *
 *  1. Every key-guarded route mounted by src/index.ts is documented, and every
 *     documented path is mounted, under the guard the document claims.
 *  2. Each MCP surface's catalogue is the tool set its real server registers.
 *  3. The task-creation body is the zod schema the endpoints validate with, and
 *     the task response covers exactly the keys `taskView` returns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMountedRoutes } from './helpers/expressRouteInventory.js';

const { buildOpenApiDocument, MCP_SURFACES, TASK_VIEW_PROPERTIES } = await import('../apiDocs.js');
const { TASK_VIEW_KEYS } = await import('../mcp/taskOperations.js');
const { createInsertMcpServer } = await import('../mcp/insertMcp.js');
const { createManagementMcpServer } = await import('../mcp/managementMcp.js');
const { createAdminMcpServer } = await import('../mcp/adminMcp.js');

const managers = { agentManager: {}, mcpManager: {}, skillManager: {} } as any;
const ACTOR = { userId: 'u', username: 'u', role: 'basic', csrf: '' } as any;
const doc: any = await buildOpenApiDocument(managers);

/** `/api/swarm/agents/{id}` → `/api/swarm/agents/:id` */
const toExpressPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1');

/** The guard each security scheme stands for, as the route inventory names it. */
const GUARD_OF_SCHEME: Record<string, string> = {
  insertKey: 'requireApiKeyScope(insert)',
  managementKey: 'requireApiKeyScope(management)',
  adminKey: 'requireApiKeyScope(admin)',
  legacyKey: 'authenticateApiKey',
};

test('every documented operation is mounted, behind the guard its security names', async () => {
  const routes = await loadMountedRoutes();
  for (const [path, ops] of Object.entries<any>(doc.paths)) {
    for (const [method, op] of Object.entries<any>(ops)) {
      const scheme = Object.keys(op.security[0])[0];
      const mounted = routes.find(
        r =>
          r.path === toExpressPath(path) &&
          (r.method === method.toUpperCase() || r.method === 'ALL')
      );
      assert.ok(mounted, `${method.toUpperCase()} ${path} is documented but not mounted`);
      assert.ok(
        mounted.chain.includes(GUARD_OF_SCHEME[scheme]),
        `${method.toUpperCase()} ${path} is documented as ${scheme} but carries ${mounted.chain.join(', ')}`
      );
    }
  }
});

test('every key-authenticated route is documented', async () => {
  const guards = Object.values(GUARD_OF_SCHEME);
  const keyRoutes = (await loadMountedRoutes()).filter(r =>
    r.chain.some(name => guards.includes(name))
  );
  assert.ok(keyRoutes.length > 0);
  const documented = new Set(
    Object.entries<any>(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map(method => `${toExpressPath(path)} ${method.toUpperCase()}`)
    )
  );
  const missing = keyRoutes.filter(
    r =>
      !documented.has(`${r.path} ${r.method}`) &&
      // An app.all() MCP mount is documented as its one meaningful verb.
      !(r.method === 'ALL' && documented.has(`${r.path} POST`))
  );
  assert.deepEqual(
    missing.map(r => `${r.method} ${r.path}`),
    [],
    'a key-authenticated route without documentation'
  );
});

test('each MCP catalogue is exactly the tool set its real server registers', () => {
  const servers: Record<string, any> = {
    '/api/mcp/insert': createInsertMcpServer(managers.agentManager, ACTOR, {
      apiKeyId: 'k',
      boardId: 'b',
    }),
    '/api/mcp/management': createManagementMcpServer(managers.agentManager, ACTOR),
    '/api/mcp/admin': createAdminMcpServer(
      managers.agentManager,
      managers.mcpManager,
      managers.skillManager,
      ACTOR
    ),
  };
  for (const surface of MCP_SURFACES) {
    const documented = doc.paths[surface.path].post['x-mcp-tools'].map((t: any) => t.name).sort();
    const registered = Object.keys(servers[surface.path]._registeredTools).sort();
    assert.deepEqual(documented, registered, `${surface.path} catalogue drifted`);
    for (const t of doc.paths[surface.path].post['x-mcp-tools']) {
      assert.equal(t.inputSchema.type, 'object', `${t.name} has an input schema`);
    }
  }
});

test('the insert body is the validated schema: task required, board never accepted', () => {
  const body = doc.components.schemas.CreateTaskInput;
  assert.deepEqual(body.required, ['task']);
  for (const field of ['title', 'description', 'priority', 'due_date', 'status', 'task_type']) {
    assert.ok(body.properties[field], `CreateTaskInput documents ${field}`);
  }
  assert.equal(body.properties.board_id, undefined, 'the board comes from the key');
  assert.deepEqual(body.properties.priority.anyOf?.[0]?.enum ?? body.properties.priority.enum, [
    'low',
    'medium',
    'high',
    'urgent',
  ]);
});

test('the Task response covers exactly the keys taskView returns', () => {
  assert.deepEqual(Object.keys(TASK_VIEW_PROPERTIES).sort(), [...TASK_VIEW_KEYS].sort());
});
