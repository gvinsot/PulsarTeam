/**
 * Swarm API MCP — repo/storage targeting tests.
 *
 * Verifies that the publicly-exposed MCP tools accept and propagate the
 * repo_full_name / storage_path parameters introduced for per-task
 * repo/storage binding, and that the new update_task tool round-trips
 * through the agentManager helpers.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const noop = async () => {};

// The swarm MCP imports both ../database.js (re-exporter) and
// ../database/boardRepos.js. Mock both so the module can load without a
// real Postgres connection.
const BOARD_WORKFLOW = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'done', label: 'Done' },
  ],
};
mock.module('../database.js', {
  namedExports: {
    getAllBoards: async () => [
      { id: 'board-1', name: 'Default', is_default: true, workflow: BOARD_WORKFLOW },
    ],
    getBoardById: async (id: string) => (id === 'board-1' ? { id: 'board-1', name: 'Default', workflow: BOARD_WORKFLOW } : null),
    getBoardWithMostTasksForProject: async () => null,
  },
});

mock.module('../database/boardRepos.js', {
  namedExports: {
    getReposForBoard: async () => [
      { provider: 'github', fullName: 'acme/widgets', htmlUrl: 'https://github.com/acme/widgets' },
    ],
  },
});

const { createSwarmApiMcpServer } = await import('../swarmApiMcp.js');

/** Build a minimal agentManager stub that records calls. */
function makeFakeAgentManager() {
  const agent = { id: 'agent-1', name: 'Builder', project: 'acme/widgets', boardId: 'board-1' };
  const tasks: any[] = [];
  const calls: any = { addTask: [], setTaskStatus: [], updateTaskRepo: [], updateTaskStorage: [] };

  return {
    agents: new Map([[agent.id, agent]]),
    _getAgentTasks: () => tasks,
    addTask(agentId: string, text: string, source: any, status: any, opts: any) {
      const t = {
        id: `task-${tasks.length + 1}`,
        agentId,
        text,
        status: status || 'backlog',
        boardId: opts?.boardId || null,
        repoFullName: opts?.repoFullName || null,
        repoProvider: opts?.repoProvider || null,
        storagePath: opts?.storagePath || null,
        storageProvider: opts?.storageProvider || null,
      };
      tasks.push(t);
      calls.addTask.push({ agentId, text, source, status, opts });
      return t;
    },
    setTaskStatus(agentId: string, taskId: string, status: string) {
      const t = tasks.find(x => x.id === taskId);
      if (t) t.status = status;
      calls.setTaskStatus.push({ agentId, taskId, status });
      return t;
    },
    updateTaskRepo(agentId: string, taskId: string, repo: string | null, provider: string | null) {
      const t = tasks.find(x => x.id === taskId);
      if (t) {
        t.repoFullName = repo;
        t.repoProvider = repo ? (provider || 'github') : null;
      }
      calls.updateTaskRepo.push({ agentId, taskId, repo, provider });
      return t;
    },
    updateTaskStorage(agentId: string, taskId: string, path: string | null, provider: string | null) {
      const t = tasks.find(x => x.id === taskId);
      if (t) {
        t.storagePath = path;
        t.storageProvider = path ? (provider || 'onedrive') : null;
      }
      calls.updateTaskStorage.push({ agentId, taskId, path, provider });
      return t;
    },
    _calls: calls,
    _tasks: tasks,
  };
}

/** Pull a registered tool's handler off an McpServer instance. */
function getToolHandler(server: any, name: string): (args: any) => Promise<any> {
  const reg = server._registeredTools?.[name];
  assert.ok(reg, `tool not registered: ${name}`);
  // Different SDK versions store the function as `handler` or `callback`.
  return reg.handler || reg.callback;
}

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

test('add_task forwards repo_full_name and storage_path to agentManager.addTask', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);

  const handler = getToolHandler(server, 'add_task');
  const result = await handler({
    agent_id: 'agent-1',
    task: 'Implement login flow',
    repo_full_name: 'acme/widgets',
    storage_path: '/onedrive/projects/widgets',
  });

  const body = parseResult(result);
  assert.equal(body.success, true);
  assert.equal(body.task.repoFullName, 'acme/widgets');
  assert.equal(body.task.repoProvider, 'github');
  assert.equal(body.task.storagePath, '/onedrive/projects/widgets');
  assert.equal(body.task.storageProvider, 'onedrive');

  // Verify it really got passed through, not just echoed back
  assert.equal(am._calls.addTask.length, 1);
  const opts = am._calls.addTask[0].opts;
  assert.equal(opts.repoFullName, 'acme/widgets');
  assert.equal(opts.repoProvider, 'github');
  assert.equal(opts.storagePath, '/onedrive/projects/widgets');
  assert.equal(opts.storageProvider, 'onedrive');
});

test('add_task rejects malformed repo_full_name with a clear error', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'add_task');

  const result = await handler({
    agent_id: 'agent-1',
    task: 'Bad repo',
    repo_full_name: 'not-a-valid-repo-name',
  });

  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.match(body.error, /Invalid repo_full_name/);
  // No task should have been created
  assert.equal(am._calls.addTask.length, 0);
});

test('add_task accepts a custom repo_provider override', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'add_task');

  await handler({
    agent_id: 'agent-1',
    task: 'Work on gitlab repo',
    repo_full_name: 'acme/widgets',
    repo_provider: 'gitlab',
  });

  assert.equal(am._calls.addTask[0].opts.repoProvider, 'gitlab');
});

test('add_task without repo / storage leaves both null (no auto-binding)', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'add_task');

  const result = await handler({ agent_id: 'agent-1', task: 'Plain task' });
  const body = parseResult(result);

  assert.equal(body.task.repoFullName, null);
  assert.equal(body.task.storagePath, null);
});

test('update_task changes the task status', async () => {
  const am = makeFakeAgentManager();
  am.addTask('agent-1', 'Existing', { type: 'mcp' }, 'backlog', { boardId: 'board-1' });
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({
    agent_id: 'agent-1',
    task_id: 'task-1',
    status: 'in_progress',
  });

  const body = parseResult(result);
  assert.equal(body.success, true);
  assert.equal(body.task.status, 'in_progress');
  assert.equal(am._calls.setTaskStatus.length, 1);
});

test('update_task changes the repo binding', async () => {
  const am = makeFakeAgentManager();
  am.addTask('agent-1', 'Existing', { type: 'mcp' }, 'backlog', { boardId: 'board-1' });
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({
    agent_id: 'agent-1',
    task_id: 'task-1',
    repo_full_name: 'acme/other-repo',
  });

  const body = parseResult(result);
  assert.equal(body.success, true);
  assert.equal(body.task.repoFullName, 'acme/other-repo');
  assert.equal(body.task.repoProvider, 'github');
  assert.equal(am._calls.updateTaskRepo[0].repo, 'acme/other-repo');
});

test('update_task with empty string clears the repo binding', async () => {
  const am = makeFakeAgentManager();
  am.addTask('agent-1', 'Existing', { type: 'mcp' }, 'backlog', {
    boardId: 'board-1',
    repoFullName: 'acme/widgets',
    repoProvider: 'github',
  });
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({
    agent_id: 'agent-1',
    task_id: 'task-1',
    repo_full_name: '',
  });

  const body = parseResult(result);
  assert.equal(body.success, true);
  assert.equal(body.task.repoFullName, null);
  assert.equal(body.task.repoProvider, null);
});

test('update_task changes the storage binding', async () => {
  const am = makeFakeAgentManager();
  am.addTask('agent-1', 'Existing', { type: 'mcp' }, 'backlog', { boardId: 'board-1' });
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({
    agent_id: 'agent-1',
    task_id: 'task-1',
    storage_path: '/onedrive/folder',
  });

  const body = parseResult(result);
  assert.equal(body.task.storagePath, '/onedrive/folder');
  assert.equal(body.task.storageProvider, 'onedrive');
});

test('update_task rejects when no fields are provided', async () => {
  const am = makeFakeAgentManager();
  am.addTask('agent-1', 'Existing', { type: 'mcp' }, 'backlog', { boardId: 'board-1' });
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({ agent_id: 'agent-1', task_id: 'task-1' });

  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.match(body.error, /At least one of/);
});

test('update_task rejects malformed repo_full_name', async () => {
  const am = makeFakeAgentManager();
  am.addTask('agent-1', 'Existing', { type: 'mcp' }, 'backlog', { boardId: 'board-1' });
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({
    agent_id: 'agent-1',
    task_id: 'task-1',
    repo_full_name: 'not_valid',
  });

  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.match(body.error, /Invalid repo_full_name/);
});

test('update_task returns 404-style error when task is missing', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({
    agent_id: 'agent-1',
    task_id: 'missing-task',
    status: 'done',
  });

  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.match(body.error, /Task not found/);
});

test('add_task rejects unknown status not in the board workflow', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'add_task');

  const result = await handler({
    agent_id: 'agent-1',
    task: 'New task',
    status: 'not_a_column',
  });

  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.match(body.error, /Invalid status "not_a_column"/);
  // No task should have been created
  assert.equal(am._calls.addTask.length, 0);
});

test('add_task rejects unknown board_id', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'add_task');

  const result = await handler({
    agent_id: 'agent-1',
    task: 'New task',
    board_id: 'does-not-exist',
  });

  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.match(body.error, /Board not found/);
  assert.equal(am._calls.addTask.length, 0);
});

test('update_task rejects unknown status not in the board workflow', async () => {
  const am = makeFakeAgentManager();
  am.addTask('agent-1', 'Existing', { type: 'mcp' }, 'backlog', { boardId: 'board-1' });
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'update_task');

  const result = await handler({
    agent_id: 'agent-1',
    task_id: 'task-1',
    status: 'not_a_real_column',
  });

  assert.equal(result.isError, true);
  const body = parseResult(result);
  assert.match(body.error, /Invalid status "not_a_real_column"/);
  // setTaskStatus should not have been called
  assert.equal(am._calls.setTaskStatus.length, 0);
});

test('list_boards exposes repos in use on each board', async () => {
  const am = makeFakeAgentManager();
  const server = createSwarmApiMcpServer(am as any);
  const handler = getToolHandler(server, 'list_boards');

  const result = await handler({});
  const body = parseResult(result);

  assert.equal(body.count, 1);
  assert.equal(body.boards[0].id, 'board-1');
  assert.deepEqual(body.boards[0].repos, [
    { provider: 'github', fullName: 'acme/widgets' },
  ]);
});
