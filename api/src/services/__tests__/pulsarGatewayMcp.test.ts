/**
 * Pulsar Gateway MCP — task control + dynamic MCP discovery/proxy.
 *
 * Verifies the single always-on gateway: the unified update_task auto-resolves
 * the agent's active task, moves its column and/or marks it finished (routing
 * completion to recordTaskCompletion), list_mcps groups tools (with
 * schemas) by server, and call_mcp_tool gates on the agent's available server
 * set before proxying through mcpManager.callToolByNameForAgent.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const BOARD_WORKFLOW = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'done', label: 'Done' },
  ],
};

// swarmApiMcp.js (imported transitively for applyTaskUpdate) and mcpManager.js
// both import ../database.js; provide just the lookups the gateway exercises.
const BOARDS: Record<string, any> = {
  'board-1': { id: 'board-1', name: 'Default', workflow: BOARD_WORKFLOW, plugins: [] },
};

mock.module('../database.js', {
  namedExports: {
    getBoardById: async (id: string) => BOARDS[id] || null,
    getAllBoards: async () => Object.values(BOARDS),
    searchTasks: async () => ({ total: 0, returned: 0, tasks: [] }),
  },
});
mock.module('../database/boardRepos.js', {
  namedExports: { getReposForBoard: async () => [] },
});
mock.module('../database/tasks.js', {
  namedExports: { getTaskById: async () => null, getTaskByIdPrefix: async () => null },
});

const { createPulsarGatewayMcpServer } = await import('../pulsarGatewayMcp.js');

function getToolHandler(server: any, name: string): (args: any) => Promise<any> {
  const reg = server._registeredTools?.[name];
  assert.ok(reg, `tool not registered: ${name}`);
  return reg.handler || reg.callback;
}
const parseResult = (result: any): any => JSON.parse(result.content[0].text);

function makeFakeAgentManager() {
  const agent = { id: 'agent-1', name: 'Builder', boardId: 'board-1', skills: [], mcpServers: [], mcpAuth: {} };
  const tasks: any[] = [
    { id: 'task-1', agentId: 'agent-1', text: 'Active task', status: 'in_progress', boardId: 'board-1' },
  ];
  const calls: any = { setTaskStatus: [], recordTaskCompletion: [] };

  return {
    agents: new Map([[agent.id, agent]]),
    _getAgentTasks: () => tasks,
    _isActiveTaskStatus: (s: string) => s === 'in_progress',
    _findTaskAcross: () => null,
    setTaskStatus(agentId: string, taskId: string, status: string) {
      const t = tasks.find(x => x.id === taskId);
      if (t) t.status = status;
      calls.setTaskStatus.push({ agentId, taskId, status });
      return t;
    },
    updateTaskRepo: () => null,
    updateTaskStorage: () => null,
    async recordTaskCompletion(agentId: string, args: any) {
      calls.recordTaskCompletion.push({ agentId, args });
      return { success: true, result: 'done', isTerminal: true, taskId: 'task-1' };
    },
    _calls: calls,
  };
}

function makeFakeMcpManager() {
  const calls: any = { callToolByNameForAgent: [] };
  return {
    servers: new Map<string, any>([
      ['mcp-swarm-api', { id: 'mcp-swarm-api', name: 'Swarm API' }],
      ['mcp-github', { id: 'mcp-github', name: 'GitHub' }],
    ]),
    async getToolsForAgent(_ids: string[], _agentId: string, _auth: any) {
      return {
        tools: [{
          serverName: 'Swarm API', serverId: 'mcp-swarm-api',
          name: 'list_boards', description: 'List boards', inputSchema: { type: 'object', properties: {} },
        }],
        unavailable: [],
      };
    },
    async callToolByNameForAgent(serverName: string, toolName: string, args: any, agentId: string, auth: any, boardId: string) {
      calls.callToolByNameForAgent.push({ serverName, toolName, args, agentId, boardId });
      return { success: true, result: `ok:${serverName}:${toolName}`, images: undefined, raw: [] };
    },
    _calls: calls,
  };
}

const fakeSkillManager = { getById: () => null };

test('update_task auto-resolves the active task and moves its column', async () => {
  const am = makeFakeAgentManager();
  const server = createPulsarGatewayMcpServer(am as any, makeFakeMcpManager() as any, fakeSkillManager as any, 'agent-1', 'board-1');
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({ status: 'in_progress' });
  const body = parseResult(result);

  assert.notEqual(result.isError, true);
  assert.equal(body.success, true);
  assert.equal(am._calls.setTaskStatus.length, 1);
  assert.equal(am._calls.setTaskStatus[0].taskId, 'task-1');
  assert.equal(am._calls.setTaskStatus[0].status, 'in_progress');
  // No completion intent -> no completion bookkeeping.
  assert.equal(am._calls.recordTaskCompletion.length, 0);
});

test('update_task errors with no agent context', async () => {
  const am = makeFakeAgentManager();
  const server = createPulsarGatewayMcpServer(am as any, makeFakeMcpManager() as any, fakeSkillManager as any, null, null);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({ status: 'done' });
  assert.equal(result.isError, true);
  assert.match(parseResult(result).error, /No agent context/);
});

test('update_task with a comment marks the task finished', async () => {
  const am = makeFakeAgentManager();
  const server = createPulsarGatewayMcpServer(am as any, makeFakeMcpManager() as any, fakeSkillManager as any, 'agent-1', 'board-1');
  const handler = getToolHandler(server, 'update_task');

  // No status: pure completion in place (the workflow chain advances the column).
  const result = await handler({ comment: 'shipped', commits: 'a1b2c3d:feat ship it' });
  const body = parseResult(result);

  assert.notEqual(result.isError, true);
  assert.equal(body.success, true);
  assert.equal(body.completed, true);
  assert.equal(am._calls.recordTaskCompletion.length, 1);
  assert.equal(am._calls.recordTaskCompletion[0].agentId, 'agent-1');
  assert.equal(am._calls.recordTaskCompletion[0].args.comment, 'shipped');
  assert.equal(am._calls.recordTaskCompletion[0].args.explicitTaskId, 'task-1');
  assert.equal(am._calls.recordTaskCompletion[0].args.commitsArg, 'a1b2c3d:feat ship it');
  // No status move when only completing.
  assert.equal(am._calls.setTaskStatus.length, 0);
});

test('update_task moves the column AND finishes when given status + comment', async () => {
  const am = makeFakeAgentManager();
  const server = createPulsarGatewayMcpServer(am as any, makeFakeMcpManager() as any, fakeSkillManager as any, 'agent-1', 'board-1');
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({ status: 'done', comment: 'all done' });
  const body = parseResult(result);

  assert.equal(body.success, true);
  assert.equal(body.completed, true);
  // Completion runs before the move so the task is still active for commit linking.
  assert.equal(am._calls.recordTaskCompletion.length, 1);
  assert.equal(am._calls.setTaskStatus.length, 1);
  assert.equal(am._calls.setTaskStatus[0].status, 'done');
});

test('list_mcps groups tools by server and includes input schemas', async () => {
  const am = makeFakeAgentManager();
  const server = createPulsarGatewayMcpServer(am as any, makeFakeMcpManager() as any, fakeSkillManager as any, 'agent-1', 'board-1');
  const handler = getToolHandler(server, 'list_mcps');

  const body = parseResult(await handler({}));
  assert.equal(body.count, 1);
  assert.equal(body.mcps[0].server, 'Swarm API');
  assert.equal(body.mcps[0].tools[0].name, 'list_boards');
  assert.ok(body.mcps[0].tools[0].input_schema, 'schema must be surfaced for correct argument construction');
});

test('call_mcp_tool proxies an available server', async () => {
  const am = makeFakeAgentManager();
  const mm = makeFakeMcpManager();
  const server = createPulsarGatewayMcpServer(am as any, mm as any, fakeSkillManager as any, 'agent-1', 'board-1');
  const handler = getToolHandler(server, 'call_mcp_tool');

  const result = await handler({ server: 'Swarm API', tool: 'list_boards', args: {} });
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].text, 'ok:Swarm API:list_boards');
  assert.equal(mm._calls.callToolByNameForAgent.length, 1);
  assert.equal(mm._calls.callToolByNameForAgent[0].boardId, 'board-1');
});

test('call_mcp_tool blocks a server not in the agent available set', async () => {
  const am = makeFakeAgentManager();
  const mm = makeFakeMcpManager();
  const server = createPulsarGatewayMcpServer(am as any, mm as any, fakeSkillManager as any, 'agent-1', 'board-1');
  const handler = getToolHandler(server, 'call_mcp_tool');

  // GitHub is a known server but not attached to this agent or its board.
  const result = await handler({ server: 'GitHub', tool: 'create_issue', args: {} });
  assert.equal(result.isError, true);
  assert.match(parseResult(result).error, /not available to you/);
  assert.equal(mm._calls.callToolByNameForAgent.length, 0);
});
