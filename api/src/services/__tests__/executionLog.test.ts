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
    save: (success = true, options: { prompt?: string | null } = {}) =>
      actionLogsMethods._saveExecutionLog.call(
        manager,
        null as any,
        task.id,
        'executor',
        0,
        startedAt,
        success,
        'decide',
        options
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

// ── The prompt pasted into the CLI ───────────────────────────────────────────
//
// The terminal tail (or a completion note) answers "what did the agent do?" but
// leaves "what was it asked?" blank, because a CLI run writes nothing to
// conversationHistory. Callers that inject into a TUI pass that prompt in.

test('the injected CLI prompt is recorded as the run input', async () => {
  const { save, output } = setup();
  await save(true, { prompt: 'Task ID: task\n\nShip the feature' });

  // Leading user turn → the detail modal renders it as "Input sent to agent".
  assert.deepEqual(task.history[0].messages, [
    { role: 'user', content: 'Task ID: task\n\nShip the feature', timestamp: startedAt },
  ]);
  // …and it must NOT suppress the terminal capture, which still ran.
  assert.equal(output.mock.calls.length, 1);
  assert.equal(task.history[0].terminalOutput, 'Tests passed\nChanges pushed');
});

test('the prompt precedes the completion notes of the same run', async () => {
  const { save, output } = setup();
  task.history = [
    {
      type: 'edit',
      field: 'text',
      oldValue: null,
      by: 'Developer',
      at: startedAt,
      newValue: 'Done',
    },
  ];
  await save(true, { prompt: 'Ship it' });

  assert.deepEqual(task.history.at(-1).messages, [
    { role: 'user', content: 'Ship it', timestamp: startedAt },
    { role: 'assistant', content: 'Done', timestamp: startedAt },
  ]);
  assert.equal(output.mock.calls.length, 0);
});

// ── Terminal capture hygiene ─────────────────────────────────────────────────
//
// The terminal is shared across executions and renders login screens, so its
// tail is scrubbed before it lands in task.history (and in the task:updated
// broadcast). Every credential below is synthetic.

test('credentials in the terminal tail never reach history or the broadcast', async () => {
  const { save, output, emit } = setup();
  output.mock.mockImplementation(
    async () =>
      'Login failed\n' +
      'Authorization: Bearer SYNTHETIC0123456789abcdef\n' +
      'Open https://example.invalid/device?user_code=SYNTH-0000 to continue\n' +
      'GITHUB_TOKEN=ghp_SYNTHETIC0000000000000000000000'
  );
  await save(false);

  const saved = task.history[0].terminalOutput as string;
  const broadcast = JSON.stringify(emit.mock.calls[0].arguments);
  for (const leak of ['SYNTHETIC0123456789abcdef', 'SYNTH-0000', 'ghp_SYNTHETIC']) {
    assert.ok(!saved.includes(leak), saved);
    assert.ok(!broadcast.includes(leak), broadcast);
  }
  // The diagnostic value of the tail survives the scrub.
  assert.match(saved, /Login failed/);
});

test('the persisted terminal tail is bounded', async () => {
  const { save, output } = setup();
  output.mock.mockImplementation(async () => 'y'.repeat(20000));
  await save();
  assert.equal(task.history[0].terminalOutput.length, 6000);
});

test('a runner that cannot scope the capture yields a diagnostic, not a transcript', async () => {
  // What the runner returns when no execution boundary was recorded: the raw
  // terminal is withheld rather than copied out of a previous task.
  const notice = '[terminal capture omitted: no execution boundary was recorded for this run]';
  const { save, output } = setup();
  output.mock.mockImplementation(async () => notice);
  await save();
  assert.equal(task.history[0].terminalOutput, notice);
});

test('a real conversation is never prefixed with the injected prompt', async () => {
  // A sandbox run already has the prompt inside conversationHistory; adding it
  // again would duplicate the first turn.
  const { save } = setup('sandbox', [{ role: 'user', content: 'go' }]);
  await save(true, { prompt: 'go' });
  assert.equal(task.history[0].messages.length, 1);
});
