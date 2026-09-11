import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server, Socket } from 'socket.io';
import type { AgentManager } from '../agentManager/index.js';
import type { SessionClaims } from '../../middleware/session.js';
import { makeTaskDbFake } from './helpers/taskDbFake.js';

// Keep the real authorization policy and execution methods; replace only DB
// access and the transport so requests exercise the registered socket handler.
const realDb = await import('../database.js');
const { rows, exports: taskDb } = makeTaskDbFake();
const boards = new Map<string, { id: string; user_id: string }>();
const shares = new Map<string, { permission: string }>();
let failBoardLookup = false;
const writes = mock.fn(taskDb.updateTaskExecutionStatus);
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    ...taskDb,
    updateTaskExecutionStatus: writes,
    getBoardById: async (id: string) => {
      if (failBoardLookup) throw new Error('Database unavailable');
      return boards.get(id) || null;
    },
    getBoardShare: async (id: string, userId: string) => shares.get(`${id}:${userId}`) || null,
    getBoardsByUser: async () => [...boards.values()],
    updateLastSeen: async () => {},
  },
});

const { tasksMethods, setTaskSignal, getTaskSignal, clearTaskSignals } =
  await import('../agentManager/tasks.js');
const { setupSocketHandlers } = await import('../../ws/socketHandler.js');
const { WsEvents } = await import('../../ws/events.js');

const user: SessionClaims = { userId: 'alice', username: 'alice', role: 'advanced', csrf: 'test' };

beforeEach(() => {
  rows.clear();
  boards.clear();
  shares.clear();
  writes.mock.resetCalls();
  failBoardLookup = false;
  clearTaskSignals('task');
  boards.set('alice-board', { id: 'alice-board', user_id: 'alice' });
  boards.set('bob-board', { id: 'bob-board', user_id: 'bob' });
});

function seedTask(boardId: string | null = 'bob-board', agentId: string | null = 'bob-agent') {
  const task = {
    id: 'task',
    text: 'Confidential task content',
    status: 'backlog',
    executionStatus: 'stopped',
    boardId,
    agentId,
  };
  rows.set(task.id, task);
  setTaskSignal(task.id, 'stopped', true);
  setTaskSignal(task.id, 'watching', true);
  return task;
}

async function harness(claims = user) {
  const agents = new Map([
    [
      'alice-agent',
      { id: 'alice-agent', name: 'Alice', ownerId: 'alice', boardId: null as string | null },
    ],
    ['bob-agent', { id: 'bob-agent', name: 'Bob', ownerId: 'bob', boardId: null as string | null }],
  ]);
  const manager = {
    agents,
    executeTask: tasksMethods.executeTask,
    executeAllTasks: tasksMethods.executeAllTasks,
    _isActiveTaskStatus: (status: string) => status === 'execute',
    _checkAutoRefine: mock.fn(),
    _resumeActiveTask: mock.fn(async () => {}),
    _taskResumeFailures: new Map([['task', { count: 2 }]]),
    _emit: mock.fn(),
    _enrichAllAgentsStats: async () => {},
    getAllForUser: () => [],
    wsEmitter: { thinking: mock.fn() },
  };
  const handlers = new Map<string, (data: unknown) => Promise<void>>();
  const emitted: { event: string; data: unknown }[] = [];
  const socket = {
    user: claims,
    join: () => {},
    emit: (event: string, data: unknown) => emitted.push({ event, data }),
    on: (event: string, handler: (data: unknown) => Promise<void>) => handlers.set(event, handler),
  };
  let connect: ((socket: Socket) => Promise<void>) | undefined;
  const io = {
    on: (_event: string, handler: (socket: Socket) => Promise<void>) => {
      connect = handler;
    },
  };
  setupSocketHandlers(io as unknown as Server, manager as unknown as AgentManager);
  assert.ok(connect);
  await connect(socket as unknown as Socket);
  emitted.length = 0;
  return {
    manager,
    emitted,
    async request(event: string, payload: unknown) {
      const handler = handlers.get(event);
      assert.ok(handler);
      await handler(payload);
    },
    async execute(event: string = WsEvents.REQ_TASK_EXECUTE) {
      const handler = handlers.get(event);
      assert.ok(handler);
      // Spoofed identity and board fields must never override socket.user or
      // the task's persisted board.
      await handler({
        agentId: 'alice-agent',
        taskId: 'task',
        boardId: 'alice-board',
        user: { ...user, role: 'admin' },
      });
    },
  };
}

function assertDenied(h: Awaited<ReturnType<typeof harness>>, expectedError = 'Access denied') {
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(rows.get('task').executionStatus, 'stopped');
  assert.equal(rows.get('task').status, 'backlog');
  assert.equal(getTaskSignal('task', 'stopped'), true);
  assert.equal(getTaskSignal('task', 'watching'), true);
  assert.equal(h.manager._taskResumeFailures.get('task')?.count, 2);
  assert.equal(h.manager._emit.mock.callCount(), 0);
  assert.equal(h.manager._checkAutoRefine.mock.callCount(), 0);
  assert.equal(h.manager._resumeActiveTask.mock.callCount(), 0);
  assert.ok(
    h.emitted.some(
      e =>
        e.event === WsEvents.STREAM_ERROR && (e.data as { error: string }).error === expectedError
    )
  );
  assert.ok(!h.emitted.some(e => e.event === WsEvents.STREAM_END));
  assert.ok(!JSON.stringify(h.emitted).includes('Confidential'));
}

test('own agent cannot execute another tenant task, even when it owns the task record', async () => {
  for (const agentId of ['bob-agent', 'alice-agent']) {
    seedTask('bob-board', agentId);
    const h = await harness();
    await h.execute();
    assertDenied(h);
  }
});

test('read-only board share cannot execute a task', async () => {
  shares.set('bob-board:alice', { permission: 'read' });
  seedTask();
  const h = await harness();
  await h.execute();
  assertDenied(h);
});

test('revoked share is checked again after socket connection', async () => {
  shares.set('bob-board:alice', { permission: 'edit' });
  seedTask();
  const h = await harness();
  shares.delete('bob-board:alice');
  await h.execute();
  assertDenied(h);
});

test('board owner, editor and system admin can execute accessible tasks', async () => {
  for (const grant of ['owner', 'editor', 'admin']) {
    writes.mock.resetCalls();
    seedTask(grant === 'owner' ? 'alice-board' : 'bob-board');
    if (grant === 'editor') shares.set('bob-board:alice', { permission: 'edit' });
    else shares.clear();
    const h = await harness(grant === 'admin' ? { ...user, role: 'admin' } : user);
    await h.execute();
    assert.equal(writes.mock.callCount(), 1);
    assert.equal(rows.get('task').executionStatus, null);
    assert.equal(h.manager._checkAutoRefine.mock.callCount(), 1);
    assert.ok(h.emitted.some(e => e.event === WsEvents.STREAM_END));
  }
});

test('board-less tasks use their actual owner; orphaned tasks fail closed', async () => {
  for (const agentId of ['bob-agent', null, 'missing-agent']) {
    seedTask(null, agentId);
    const h = await harness();
    await h.execute();
    assertDenied(h);
  }
  seedTask(null, 'alice-agent');
  const h = await harness();
  await h.execute();
  assert.equal(writes.mock.callCount(), 1);
});

test('missing board and authorization database failure fail closed', async () => {
  seedTask('missing-board');
  const h = await harness();
  await h.execute();
  assertDenied(h);
  seedTask();
  failBoardLookup = true;
  await h.execute();
  assertDenied(h, 'Database unavailable');
});

test('missing task produces a stream error without mutations', async () => {
  const h = await harness();
  await h.execute();
  assert.equal(writes.mock.callCount(), 0);
  assert.ok(h.emitted.some(e => e.event === WsEvents.STREAM_ERROR));
  assert.equal(h.manager._emit.mock.callCount(), 0);
});

test('execute-all preflights task boards before running any task or exposing results', async () => {
  rows.set('allowed', {
    id: 'allowed',
    agentId: 'alice-agent',
    boardId: 'alice-board',
    status: 'backlog',
    text: 'Allowed',
  });
  seedTask('bob-board', 'alice-agent');
  const h = await harness();
  await h.execute(WsEvents.REQ_TASK_EXECUTE_ALL);
  assertDenied(h);
});

test('execute-all forwards caller identity to each execution', async () => {
  seedTask('alice-board', 'alice-agent');
  const h = await harness();
  await h.execute(WsEvents.REQ_TASK_EXECUTE_ALL);
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(h.manager._checkAutoRefine.mock.callCount(), 1);
  assert.ok(h.emitted.some(e => e.event === WsEvents.STREAM_END));
});

test('execution requires current edit access to the selected agent', async () => {
  seedTask('alice-board');
  shares.set('bob-board:alice', { permission: 'read' });
  const h = await harness();
  const agent = h.manager.agents.get('alice-agent');
  assert.ok(agent);
  agent.boardId = 'bob-board';
  await h.execute();
  assertDenied(h);
});

test('service entry points reject absent caller identity', async () => {
  seedTask('alice-board');
  const h = await harness();
  // Simulate an untyped caller bypassing the mandatory TypeScript argument.
  await assert.rejects(
    h.manager.executeTask('alice-agent', 'task', () => {}, undefined as unknown as SessionClaims),
    /Access denied/
  );
  await assert.rejects(
    h.manager.executeAllTasks('alice-agent', () => {}, undefined as unknown as SessionClaims),
    /Access denied/
  );
  assert.equal(writes.mock.callCount(), 0);
});

test('voice tool replies echo each call id, including failed delegate and ask requests', async () => {
  const h = await harness();
  for (const event of [
    WsEvents.REQ_VOICE_DELEGATE,
    WsEvents.REQ_VOICE_ASK,
    WsEvents.REQ_VOICE_MANAGEMENT,
  ]) {
    for (const callId of ['first-call', 'second-call']) {
      await h.request(event, {
        agentId: 'alice-agent',
        callId,
        targetAgentName: 'missing',
        task: 'task',
        question: 'question',
        functionName: 'unknown_tool',
      });
      const reply = h.emitted.at(-1)?.data as { callId: string };
      assert.equal(reply.callId, callId);
    }
  }
});
