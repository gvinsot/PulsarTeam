import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let task: any;
mock.module('../database.js', {
  namedExports: {
    saveAgent: async () => {},
    getTasksByAssignee: async () => [],
    getTaskById: async () => structuredClone(task),
    updateTaskFields: async (_id: string, fields: any) => {
      Object.assign(task, structuredClone(fields));
      return structuredClone(task);
    },
  },
});
const { actionLogsMethods } = await import('../agentManager/actionLogs.js');
const startedAt = '2026-09-16T10:00:00.000Z';

function setup(runner = 'codex', messages: any[] = []) {
  task = { id: 'task', agentId: null, status: 'verify', history: [] };
  const output = mock.fn(async () => 'Tests passed\nChanges pushed');
  const emit = mock.fn();
  const manager = {
    agents: new Map([['executor', { name: 'Developer', runner, conversationHistory: messages }]]),
    executionManager: { getTerminalOutput: output },
    _emit: emit,
  };
  return {
    output,
    emit,
    save: (success = true) =>
      actionLogsMethods._saveExecutionLog.call(
        manager,
        null as any,
        task.id,
        'executor',
        0,
        startedAt,
        success,
        'decide'
      ),
  };
}

test('CLI execution on an ownerless task saves terminal output and emits the persisted task', async () => {
  const { save, output, emit } = setup();
  await save();
  assert.equal(output.mock.calls.length, 1);
  assert.equal(task.history[0].terminalOutput, 'Tests passed\nChanges pushed');
  assert.deepEqual(task.history[0].messages, []);
  assert.deepEqual(emit.mock.calls[0].arguments, ['task:updated', { agentId: null, task }]);
});

test('CLI completion notes from this run are preferred over terminal output', async () => {
  const { save, output } = setup();
  const note = {
    type: 'edit',
    field: 'text',
    oldValue: null,
    by: 'Developer',
    newValue: 'Completed',
  };
  task.history = [
    { ...note, at: '2026-09-15T10:00:00.000Z', newValue: 'Previous run' },
    { ...note, at: startedAt, by: 'Another agent', newValue: 'Unrelated' },
    { ...note, at: startedAt },
  ];
  await save();
  assert.deepEqual(task.history.at(-1).messages, [
    { role: 'assistant', content: 'Completed', timestamp: startedAt },
  ]);
  assert.equal(output.mock.calls.length, 0);
});

test('structured conversation and tool results are preserved without terminal fetching', async () => {
  const messages = [
    { role: 'assistant', content: 'Fixed', toolResults: [{ tool: 'test', success: true }] },
  ];
  const { save, output } = setup('sandbox', messages);
  await save();
  assert.equal(task.history[0].messages[0].content, 'Fixed');
  assert.deepEqual(task.history[0].messages[0].toolResults, messages[0].toolResults);
  assert.equal(output.mock.calls.length, 0);
});

test('runner failures still persist unsuccessful execution history', async () => {
  const { save, output } = setup();
  output.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  await save(false);
  assert.equal(task.history[0].success, false);
  assert.equal(task.history[0].terminalOutput, undefined);
});

test('task moves and history added while fetching terminal output are preserved', async () => {
  const { save, output } = setup();
  output.mock.mockImplementation(async () => {
    task.status = 'done';
    task.history.push({ status: 'done', by: 'Developer', at: startedAt });
    return 'Finished';
  });
  await save();
  assert.equal(task.status, 'done');
  assert.equal(task.history.length, 2);
  assert.equal(task.history[0].status, 'done');
  assert.equal(task.history[1].terminalOutput, 'Finished');
});
