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
const { actionLogsMethods, TERMINAL_HISTORY_UNVERIFIED_NOTICE } =
  await import('../agentManager/actionLogs.js');
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

test('CLI execution saves a safe diagnostic and emits the persisted task', async () => {
  const { save, output, emit } = setup();
  await save();
  assert.equal(output.mock.calls.length, 1);
  assert.equal(task.history[0].terminalOutput, TERMINAL_HISTORY_UNVERIFIED_NOTICE);
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
  assert.equal(task.history[0].terminalOutput, TERMINAL_HISTORY_UNVERIFIED_NOTICE);
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
  assert.equal(task.history[1].terminalOutput, TERMINAL_HISTORY_UNVERIFIED_NOTICE);
});

// ── The prompt pasted into the CLI ───────────────────────────────────────────
//
// The completion note answers "what did the agent do?" but leaves
// "what was it asked?" blank, because a CLI run writes nothing to
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
  assert.equal(task.history[0].terminalOutput, TERMINAL_HISTORY_UNVERIFIED_NOTICE);
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
// raw output is withheld before task.history and task:updated. Credential
// filtering alone cannot detect ordinary confidential text. Values are synthetic.

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
  assert.equal(saved, TERMINAL_HISTORY_UNVERIFIED_NOTICE);
});

test('large unverified output is replaced by a bounded diagnostic', async () => {
  const { save, output } = setup();
  output.mock.mockImplementation(async () => 'y'.repeat(20000));
  await save();
  assert.equal(task.history[0].terminalOutput, TERMINAL_HISTORY_UNVERIFIED_NOTICE);
});

test('a runner that cannot scope the capture yields a diagnostic, not a transcript', async () => {
  // What the runner returns when no execution boundary was recorded: the raw
  // terminal is withheld rather than copied out of a previous task.
  const notice =
    '[terminal capture omitted: no execution boundary was recorded for this run, so output from earlier tasks could not be excluded]';
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

for (const scenario of [
  'initial capture exception',
  'initial capture nonzero',
  'repaint',
  'reflow',
]) {
  test(`${scenario}: unverified previous-ticket text cannot reach history or task:updated`, async () => {
    const { save, output, emit } = setup();
    const previous = 'PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL';
    // Includes legacy runners that report a recovered shared pane as raw text.
    output.mock.mockImplementation(async () =>
      scenario === 'reflow' ? 'PREVIOUS_TASK_SYNTHETIC_\nCONFIDENTIAL' : previous
    );
    await save(false, { prompt: 'Current task only' });
    assert.equal(task.history[0].terminalOutput, TERMINAL_HISTORY_UNVERIFIED_NOTICE);
    for (const serialized of [JSON.stringify(task.history), JSON.stringify(emit.mock.calls)]) {
      assert.ok(!serialized.includes('PREVIOUS_TASK_SYNTHETIC'));
      assert.ok(!serialized.includes('CONFIDENTIAL'));
      assert.ok(serialized.includes('Current task only'));
      assert.ok(serialized.includes('capture omitted'));
    }
  });
}

test('failed initial capture diagnostic is retained without carrying raw pane text', async () => {
  const { save, output, emit } = setup();
  const diagnostic =
    '[terminal capture omitted: initial pane capture failed; execution isolation could not be established]';
  output.mock.mockImplementation(async () => diagnostic);
  await save();
  assert.equal(task.history[0].terminalOutput, diagnostic);
  assert.deepEqual(emit.mock.calls[0].arguments, ['task:updated', { agentId: null, task }]);
});

test('completion notes survive and bypass unsafe terminal capture', async () => {
  const { save, output, emit } = setup();
  const note = {
    type: 'edit',
    field: 'text',
    oldValue: null,
    by: 'Developer',
    at: startedAt,
    newValue: 'Current task completed and pushed',
  };
  task.history = [note];
  output.mock.mockImplementation(async () => 'PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL');
  await save(true, { prompt: 'Current task only' });
  assert.deepEqual(task.history[0], note);
  assert.equal(task.history[1].messages[1].content, note.newValue);
  assert.equal(output.mock.calls.length, 0);
  assert.equal(task.history[1].terminalOutput, undefined);
  assert.ok(JSON.stringify(emit.mock.calls).includes(note.newValue));
  assert.ok(!JSON.stringify(emit.mock.calls).includes('PREVIOUS_TASK_SYNTHETIC'));
});
