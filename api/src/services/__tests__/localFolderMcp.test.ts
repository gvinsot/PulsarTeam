/**
 * Local Folder MCP — proxies file/office tool calls to a user's desktop app.
 *
 * Verifies: agent→owner resolution (agent.ownerId), the friendly "no desktop"
 * error when the user has no bridge connected, and a successful round-trip that
 * emit-with-acks bridge:tool:call on the registered desktop socket and returns
 * its result. The desktop socket registry (ws/socketHandler.js) is mocked so the
 * connector can be exercised without a live socket server.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Controllable desktop registry: tests set what getDesktopSocketsForUser returns.
const registry = new Map<string, Set<any>>();
mock.module('../../ws/socketHandler.js', {
  namedExports: {
    getDesktopSocketsForUser: (userId: string) => registry.get(userId),
    isDesktopConnected: (userId: string) => !!registry.get(userId)?.size,
    getDesktopBridgeInfo: () => null,
  },
});

const { createLocalFolderMcpServer } = await import('../localFolderMcp.js');

function agentManagerWith(agent: any) {
  return { agents: new Map(agent ? [[agent.id, agent]] : []) };
}
function getTool(server: any, name: string) {
  const reg = server._registeredTools?.[name];
  assert.ok(reg, `tool not registered: ${name}`);
  return (args: any) => (reg.handler || reg.callback)(args, {});
}
const text = (r: any) => r.content[0].text;

test('registers the full file + office tool surface', () => {
  const server: any = createLocalFolderMcpServer({ agentId: null, boardId: null }, agentManagerWith(null));
  const names = Object.keys(server._registeredTools);
  for (const expected of ['list_files', 'read_file', 'write_file', 'search_files',
    'read_document', 'convert_document', 'edit_docx', 'generate_xlsx', 'edit_pptx',
    'read_pdf', 'merge_pdfs']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(names.length, 21);
});

test('errors when the agent has no resolvable owner', async () => {
  const agent = { id: 'agent-x' }; // no ownerId
  const server = createLocalFolderMcpServer({ agentId: 'agent-x', boardId: null }, agentManagerWith(agent));
  const res = await getTool(server, 'read_document')({ path: 'a.docx' });
  assert.equal(res.isError, true);
  assert.match(text(res), /ownerId/);
});

test('returns a friendly error when no desktop is connected', async () => {
  registry.clear();
  const agent = { id: 'agent-1', ownerId: 'user-1' };
  const server = createLocalFolderMcpServer({ agentId: 'agent-1', boardId: null }, agentManagerWith(agent));
  const res = await getTool(server, 'list_files')({ path: '.' });
  assert.equal(res.isError, true);
  assert.match(text(res), /No desktop app connected/);
});

test('round-trips a tool call to the connected desktop and returns its result', async () => {
  registry.clear();
  let captured: any = null;
  const fakeSocket = {
    timeout: () => ({
      emitWithAck: async (event: string, payload: any) => {
        captured = { event, payload };
        return { ok: true, result: '{"markdown":"# Hello from disk"}' };
      },
    }),
  };
  registry.set('user-1', new Set([fakeSocket]));

  const agent = { id: 'agent-1', ownerId: 'user-1' };
  const server = createLocalFolderMcpServer({ agentId: 'agent-1', boardId: null }, agentManagerWith(agent));
  const res = await getTool(server, 'read_document')({ path: 'report.docx' });

  assert.equal(res.isError, undefined);
  assert.match(text(res), /Hello from disk/);
  assert.equal(captured.event, 'bridge:tool:call');
  assert.equal(captured.payload.tool, 'read_document');
  assert.deepEqual(captured.payload.args, { path: 'report.docx' });
  assert.ok(captured.payload.requestId, 'a requestId is attached for tracing');
});

test('surfaces a desktop-side error verbatim', async () => {
  registry.clear();
  const fakeSocket = {
    timeout: () => ({ emitWithAck: async () => ({ ok: false, code: 'EACCES', error: 'path escapes the shared folder' }) }),
  };
  registry.set('user-2', new Set([fakeSocket]));
  const agent = { id: 'agent-2', ownerId: 'user-2' };
  const server = createLocalFolderMcpServer({ agentId: 'agent-2', boardId: null }, agentManagerWith(agent));
  const res = await getTool(server, 'read_file')({ path: '../secret' });
  assert.equal(res.isError, true);
  assert.match(text(res), /EACCES: path escapes/);
});
