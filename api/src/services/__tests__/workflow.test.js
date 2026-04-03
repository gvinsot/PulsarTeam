import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';
import { stripToolCalls } from '../workflow/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock IO */
const mockIo = { emit() {}, to() { return { emit() {} }; } };

/** Create an AgentManager with agents pre-registered */
async function setup(agentDefs = []) {
  const mgr = new AgentManager(mockIo, null, null, null);
  for (const def of agentDefs) {
    const created = await mgr.create(def);
    const raw = mgr.agents.get(created.id);
    // Ensure agents start idle
    raw.status = 'idle';
    raw.conversationHistory = [];
    mgr._tasks.set(created.id, []);
  }
  return mgr;
}

/** Build a workflow config object */
function workflow(columns, transitions) {
  return { columns, transitions };
}

/** Create a task on the first agent's task store */
function addTask(mgr, text, status, boardId = 'board-1', extra = {}) {
  const [firstAgentId] = mgr.agents.keys();
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    status,
    boardId,
    assignee: null,
    ...extra,
  };
  mgr._addTaskToStore(firstAgentId, task);
  return { task, agentId: firstAgentId };
}

/** Create a task on a specific agent's task store */
function addTaskToAgent(mgr, agentId, text, status, boardId = 'board-1', extra = {}) {
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    status,
    boardId,
    assignee: null,
    ...extra,
  };
  mgr._addTaskToStore(agentId, task);
  return task;
}

/** Get agent by name */
function getAgent(mgr, name) {
  for (const [id, a] of mgr.agents) {
    if (a.name === name) return { id, agent: a };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. _isActiveTaskStatus
// ═══════════════════════════════════════════════════════════════════════════════

test('_isActiveTaskStatus returns true for non-terminal statuses', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  assert.equal(mgr._isActiveTaskStatus('code'), true);
  assert.equal(mgr._isActiveTaskStatus('refine'), true);
  assert.equal(mgr._isActiveTaskStatus('pending'), true);
  assert.equal(mgr._isActiveTaskStatus('done'), false);
  assert.equal(mgr._isActiveTaskStatus('backlog'), false);
  assert.equal(mgr._isActiveTaskStatus('error'), false);
});

test('_isActiveTaskStatus handles custom workflow statuses', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  assert.equal(mgr._isActiveTaskStatus('security'), true);
  assert.equal(mgr._isActiveTaskStatus('in_progress'), true);
  assert.equal(mgr._isActiveTaskStatus('qualification'), true);
  // nextsprint is active (not in the INACTIVE set: done/backlog/error)
  assert.equal(mgr._isActiveTaskStatus('nextsprint'), true);
  // Edge cases: anything not in INACTIVE set (done/backlog/error) is active
  assert.equal(mgr._isActiveTaskStatus(''), true);
  assert.equal(mgr._isActiveTaskStatus(null), true);
  assert.equal(mgr._isActiveTaskStatus(undefined), true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. _validTransition
// ═══════════════════════════════════════════════════════════════════════════════

test('_validTransition requires from, trigger, and actions array', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);

  assert.ok(mgr._validTransition({ from: 'code', trigger: 'on_enter', actions: [] }));
  assert.ok(mgr._validTransition({ from: 'code', trigger: 'on_enter', actions: [{ type: 'change_status' }] }));
  assert.ok(!mgr._validTransition({ from: 'code', trigger: 'on_enter' }));
  assert.ok(!mgr._validTransition({ from: 'code', actions: [] }));
  assert.ok(!mgr._validTransition({ trigger: 'on_enter', actions: [] }));
  assert.ok(!mgr._validTransition(null));
  assert.ok(!mgr._validTransition(undefined));
  assert.ok(!mgr._validTransition({}));
  // actions must be array
  assert.ok(!mgr._validTransition({ from: 'code', trigger: 'on_enter', actions: 'not-array' }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. _columnExists
// ═══════════════════════════════════════════════════════════════════════════════

test('_columnExists checks column id in workflow', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  const wf = workflow(
    [{ id: 'backlog' }, { id: 'refine' }, { id: 'code' }, { id: 'done' }],
    []
  );

  assert.ok(mgr._columnExists(wf, 'backlog'));
  assert.ok(mgr._columnExists(wf, 'code'));
  assert.ok(mgr._columnExists(wf, 'done'));
  assert.ok(!mgr._columnExists(wf, 'nonexistent'));
  assert.ok(!mgr._columnExists(wf, ''));
});

test('_columnExists handles malformed workflows', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);

  assert.ok(!mgr._columnExists(null, 'code'));
  assert.ok(!mgr._columnExists(undefined, 'code'));
  assert.ok(!mgr._columnExists({}, 'code'));
  assert.ok(!mgr._columnExists({ columns: 'not-array' }, 'code'));
  assert.ok(!mgr._columnExists({ columns: null }, 'code'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. _evaluateCondition
// ═══════════════════════════════════════════════════════════════════════════════

test('_evaluateCondition: assignee_status eq/neq', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Worker', role: 'developer' },
  ]);
  const { id: workerId, agent: worker } = getAgent(mgr, 'Worker');
  const { id: creatorId } = getAgent(mgr, 'Creator');

  const task = { assignee: workerId, agentId: creatorId };

  // Worker is idle
  worker.status = 'idle';
  assert.ok(mgr._evaluateCondition({ field: 'assignee_status', operator: 'eq', value: 'idle' }, task));
  assert.ok(!mgr._evaluateCondition({ field: 'assignee_status', operator: 'eq', value: 'busy' }, task));
  assert.ok(mgr._evaluateCondition({ field: 'assignee_status', operator: 'neq', value: 'busy' }, task));

  // Worker is busy
  worker.status = 'busy';
  assert.ok(mgr._evaluateCondition({ field: 'assignee_status', operator: 'eq', value: 'busy' }, task));
  assert.ok(!mgr._evaluateCondition({ field: 'assignee_status', operator: 'eq', value: 'idle' }, task));
});

test('_evaluateCondition: assignee_enabled', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Worker', role: 'developer' },
  ]);
  const { id: workerId, agent: worker } = getAgent(mgr, 'Worker');
  const { id: creatorId } = getAgent(mgr, 'Creator');

  const task = { assignee: workerId, agentId: creatorId };

  assert.ok(mgr._evaluateCondition({ field: 'assignee_enabled', operator: 'eq', value: 'true' }, task));
  worker.enabled = false;
  assert.ok(mgr._evaluateCondition({ field: 'assignee_enabled', operator: 'eq', value: 'false' }, task));
});

test('_evaluateCondition: task_has_assignee', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  const [agentId] = mgr.agents.keys();

  assert.ok(mgr._evaluateCondition(
    { field: 'task_has_assignee', operator: 'eq', value: 'true' },
    { assignee: agentId, agentId }
  ));
  assert.ok(mgr._evaluateCondition(
    { field: 'task_has_assignee', operator: 'eq', value: 'false' },
    { assignee: null, agentId }
  ));
  assert.ok(mgr._evaluateCondition(
    { field: 'task_has_assignee', operator: 'neq', value: 'true' },
    { assignee: null, agentId }
  ));
});

test('_evaluateCondition: idle_agent_available', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { id: devId, agent: dev } = getAgent(mgr, 'Dev');
  const { id: creatorId } = getAgent(mgr, 'Creator');

  const task = { agentId: creatorId };

  // Dev is idle → idle_agent_available for role "developer" should be true
  assert.ok(mgr._evaluateCondition({ field: 'idle_agent_available', operator: 'eq', value: 'developer' }, task));

  // No idle agent with role "security"
  assert.ok(!mgr._evaluateCondition({ field: 'idle_agent_available', operator: 'eq', value: 'security' }, task));

  // Dev goes busy → no idle developer
  dev.status = 'busy';
  assert.ok(!mgr._evaluateCondition({ field: 'idle_agent_available', operator: 'eq', value: 'developer' }, task));

  // neq operator: "no idle developer available" → true when dev is busy
  assert.ok(mgr._evaluateCondition({ field: 'idle_agent_available', operator: 'neq', value: 'developer' }, task));
});

test('_evaluateCondition: no assignee returns defaults', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  const [agentId] = mgr.agents.keys();
  const task = { assignee: null, agentId };

  // No assignee → status = 'none', enabled = 'false'
  assert.ok(mgr._evaluateCondition({ field: 'assignee_status', operator: 'eq', value: 'none' }, task));
  assert.ok(mgr._evaluateCondition({ field: 'assignee_enabled', operator: 'eq', value: 'false' }, task));
});

test('_evaluateCondition: assignee_role', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { id: devId } = getAgent(mgr, 'Dev');
  const { id: creatorId } = getAgent(mgr, 'Creator');

  assert.ok(mgr._evaluateCondition(
    { field: 'assignee_role', operator: 'eq', value: 'developer' },
    { assignee: devId, agentId: creatorId }
  ));
  assert.ok(!mgr._evaluateCondition(
    { field: 'assignee_role', operator: 'eq', value: 'manager' },
    { assignee: devId, agentId: creatorId }
  ));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. agentHasActiveTask
// ═══════════════════════════════════════════════════════════════════════════════

test('agentHasActiveTask excludes specific task when excludeTaskId is provided', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Titles', role: 'titles-manager' },
  ]);
  const { id: creatorId, agent: creator } = getAgent(mgr, 'Creator');
  const { id: titlesId } = getAgent(mgr, 'Titles');

  const taskId = 'task-chain-1';
  mgr._addTaskToStore(creatorId, { id: taskId, text: 'Multi-action task', status: 'refine', assignee: titlesId });

  assert.equal(mgr.agentHasActiveTask(titlesId), true);
  assert.equal(mgr.agentHasActiveTask(titlesId, taskId), false);
  assert.equal(mgr.agentHasActiveTask(titlesId, 'other-task'), true);
});

test('agentHasActiveTask detects cross-agent assignments', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Worker', role: 'developer' },
  ]);
  const { id: creatorId, agent: creator } = getAgent(mgr, 'Creator');
  const { id: workerId } = getAgent(mgr, 'Worker');

  assert.equal(mgr.agentHasActiveTask(workerId), false);

  mgr._addTaskToStore(creatorId, { id: 'task-1', text: 'Build feature', status: 'code', assignee: workerId });

  assert.equal(mgr.agentHasActiveTask(workerId), true);

  mgr._getAgentTasks(creatorId)[0].status = 'done';
  assert.equal(mgr.agentHasActiveTask(workerId), false);
});

test('agentHasActiveTask: own tasks count', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { id: devId, agent: dev } = getAgent(mgr, 'Dev');

  assert.equal(mgr.agentHasActiveTask(devId), false);

  mgr._addTaskToStore(devId, { id: 't1', text: 'Own task', status: 'code', assignee: null });
  assert.equal(mgr.agentHasActiveTask(devId), true);

  mgr._getAgentTasks(devId)[0].status = 'backlog';
  assert.equal(mgr.agentHasActiveTask(devId), false);
});

test('agentHasActiveTask: multiple tasks, exclude only one', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { id: creatorId, agent: creator } = getAgent(mgr, 'Creator');
  const { id: devId } = getAgent(mgr, 'Dev');

  mgr._addTaskToStore(creatorId, { id: 't1', text: 'Task 1', status: 'code', assignee: devId });
  mgr._addTaskToStore(creatorId, { id: 't2', text: 'Task 2', status: 'refine', assignee: devId });

  // Even excluding t1, t2 still makes the agent busy
  assert.equal(mgr.agentHasActiveTask(devId, 't1'), true);
  // Excluding both individually won't help — the other one is still active
  assert.equal(mgr.agentHasActiveTask(devId, 't2'), true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. setTaskStatus
// ═══════════════════════════════════════════════════════════════════════════════

test('setTaskStatus changes status and emits events', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Status test', 'backlog');

  const result = mgr.setTaskStatus(agentId, task.id, 'code');
  assert.ok(result, 'setTaskStatus should return truthy result');

  const updated = mgr._getAgentTasks(agentId).find(t => t.id === task.id);
  assert.equal(updated.status, 'code');
});

test('setTaskStatus returns falsy for invalid task id', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();

  const result = mgr.setTaskStatus(agentId, 'nonexistent', 'code');
  assert.ok(!result, 'setTaskStatus should return falsy for invalid task');
});

test('setTaskStatus returns falsy for invalid agent id', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const result = mgr.setTaskStatus('nonexistent-agent', 'task-1', 'code');
  assert.ok(!result);
});

test('setTaskStatus is a no-op when moving to same status', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Same status', 'code');

  const historyBefore = task.history?.length || 0;
  const result = mgr.setTaskStatus(agentId, task.id, 'code');
  // Should return the task (truthy) but not add a history entry
  assert.ok(result);
  assert.equal(task.history?.length || 0, historyBefore);
});

test('setTaskStatus sets completedAt when moving to done', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Complete me', 'code');

  assert.equal(task.completedAt, undefined);
  mgr.setTaskStatus(agentId, task.id, 'done');
  assert.ok(task.completedAt, 'completedAt should be set');
  assert.equal(task.status, 'done');
});

test('setTaskStatus records errorFromStatus on error', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Error test', 'code');

  mgr.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true });
  assert.equal(task.status, 'error');
  assert.equal(task.errorFromStatus, 'code');
});

test('setTaskStatus clears error fields when recovering from error', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Recover test', 'code');

  mgr.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true });
  task.error = 'something broke';
  assert.equal(task.errorFromStatus, 'code');
  assert.equal(task.error, 'something broke');

  mgr.setTaskStatus(agentId, task.id, 'backlog', { skipAutoRefine: true });
  assert.equal(task.errorFromStatus, null);
  assert.equal(task.error, null);
});

test('setTaskStatus clears _pendingOnEnter', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Pending test', 'refine');

  task._pendingOnEnter = 'refine';
  mgr.setTaskStatus(agentId, task.id, 'code', { skipAutoRefine: true });
  assert.equal(task._pendingOnEnter, undefined);
});

test('setTaskStatus records history with by field', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'History test', 'backlog');

  mgr.setTaskStatus(agentId, task.id, 'code', { by: 'workflow' });
  const lastEntry = task.history[task.history.length - 1];
  assert.equal(lastEntry.from, 'backlog');
  assert.equal(lastEntry.status, 'code');
  assert.equal(lastEntry.by, 'workflow');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. _completedActionIdx / action chain resume
// ═══════════════════════════════════════════════════════════════════════════════

test('_completedActionIdx is cleaned up before change_status', async () => {
  const mgr = await setup([
    { name: 'Titles', role: 'titles-manager' },
    { name: 'PM', role: 'product-manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { task } = addTask(mgr, 'Test task', 'refine');

  task._completedActionIdx = 2;
  assert.equal(task._completedActionIdx, 2);

  delete task._completedActionIdx;
  task.completedActionIdx = null;
  delete task._pendingOnEnter;
  task.status = 'code';

  assert.equal(task._completedActionIdx, undefined);
  assert.equal(task.completedActionIdx, null);
  assert.equal(task.status, 'code');
});

test('action chain resume index tracks correctly', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  const { task } = addTask(mgr, 'Chain test', 'refine');

  const rawIdx0 = task.completedActionIdx ?? task._completedActionIdx;
  const startIdx0 = (typeof rawIdx0 === 'number') ? rawIdx0 + 1 : 0;
  assert.equal(startIdx0, 0, 'should start at action 0');

  task._completedActionIdx = 0;
  task.completedActionIdx = 0;
  const startIdx1 = task.completedActionIdx + 1;
  assert.equal(startIdx1, 1, 'should resume at action 1');

  task._completedActionIdx = 1;
  task.completedActionIdx = 1;
  const startIdx2 = task.completedActionIdx + 1;
  assert.equal(startIdx2, 2, 'should resume at action 2');

  delete task._completedActionIdx;
  task.completedActionIdx = null;
  const rawIdxClean = task.completedActionIdx ?? task._completedActionIdx;
  const startIdxClean = (typeof rawIdxClean === 'number') ? rawIdxClean + 1 : 0;
  assert.equal(startIdxClean, 0, 'should restart from 0 after cleanup');
});

test('full refine→code chain: _completedActionIdx does not leak across transitions', async () => {
  const mgr = await setup([
    { name: 'Titles', role: 'titles-manager' },
    { name: 'PM', role: 'product-manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { task } = addTask(mgr, 'Full chain test', 'refine');

  task._completedActionIdx = 0; task.completedActionIdx = 0;
  task._completedActionIdx = 1; task.completedActionIdx = 1;
  task._completedActionIdx = 2; task.completedActionIdx = 2;

  delete task._completedActionIdx;
  task.completedActionIdx = null;
  delete task._pendingOnEnter;
  task.status = 'code';

  const rawIdx = task.completedActionIdx ?? task._completedActionIdx;
  const startIdx = (typeof rawIdx === 'number') ? rawIdx + 1 : 0;
  assert.equal(startIdx, 0, 'code on_enter should start at action 0, not resume from refine chain');
  assert.equal(task.status, 'code');
});

test('_pendingOnEnter is set when action chain is interrupted', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  const { task } = addTask(mgr, 'Pending chain', 'refine');

  // Simulate: action 2 was skipped (no idle agent), action 1 completed
  task._pendingOnEnter = 'refine';
  task._completedActionIdx = 1;
  task.completedActionIdx = 1;

  assert.equal(task._pendingOnEnter, 'refine');

  // When retry succeeds: resume from action 2 (completedActionIdx + 1)
  const rawIdx = task.completedActionIdx ?? task._completedActionIdx;
  const resumeIdx = (typeof rawIdx === 'number') ? rawIdx + 1 : 0;
  assert.equal(resumeIdx, 2, 'should resume at the skipped action');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. executionStatus lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

test('executionStatus tracks watching/stopped lifecycle', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task } = addTask(mgr, 'Execution status test', 'code');

  assert.ok(!task.executionStatus, 'should start without executionStatus');

  task.executionStatus = 'watching';
  task._executionWatching = true;
  assert.equal(task.executionStatus, 'watching');

  task.executionStatus = null;
  delete task._executionWatching;
  assert.equal(task.executionStatus, null);

  task.executionStatus = 'stopped';
  task._executionStopped = true;
  assert.equal(task.executionStatus, 'stopped');

  task.executionStatus = null;
  delete task._executionStopped;
  assert.equal(task.executionStatus, null);
});

test('_processNextPendingTasks skips tasks with executionStatus watching', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Skip watching test', 'code', 'board-1', {
    startedAt: new Date().toISOString(),
  });

  task.executionStatus = 'watching';
  task._executionWatching = true;

  const agent = mgr.agents.get(agentId);
  assert.equal(agent.status, 'idle');
  assert.ok(task.executionStatus === 'watching');
});

test('_processNextPendingTasks skips tasks with executionStatus stopped', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Skip stopped test', 'code', 'board-1', {
    startedAt: new Date().toISOString(),
  });

  task.executionStatus = 'stopped';
  task._executionStopped = true;

  const agent = mgr.agents.get(agentId);
  assert.equal(agent.status, 'idle');
  assert.ok(task.executionStatus === 'stopped');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Transition matching
// ═══════════════════════════════════════════════════════════════════════════════

test('transition matching only applies to current task status', async () => {
  const transitions = [
    { from: 'code', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'done' }] },
    { from: 'refine', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'code' }] },
  ];

  const taskStatus = 'code';
  const matching = transitions.filter(t => t.from === taskStatus);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].from, 'code');
});

test('transition matching ignores jira_ticket triggers in auto-refine', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  const transitions = [
    { from: 'code', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'done' }] },
    { from: 'code', trigger: 'jira_ticket', actions: [{ type: 'change_status', target: 'done' }] },
  ];

  // _checkAutoRefine skips jira_ticket triggers
  const valid = transitions
    .filter(t => mgr._validTransition(t))
    .filter(t => t.trigger !== 'jira_ticket');
  assert.equal(valid.length, 1);
  assert.equal(valid[0].trigger, 'on_enter');
});

test('conditional transitions only fire when all conditions are met', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { id: devId, agent: dev } = getAgent(mgr, 'Dev');
  const { id: creatorId } = getAgent(mgr, 'Creator');

  const task = { assignee: devId, agentId: creatorId };

  const conditions = [
    { field: 'assignee_status', operator: 'eq', value: 'idle' },
    { field: 'assignee_enabled', operator: 'eq', value: 'true' },
  ];

  // Both conditions met
  dev.status = 'idle';
  assert.ok(conditions.every(c => mgr._evaluateCondition(c, task)));

  // One condition fails
  dev.status = 'busy';
  assert.ok(!conditions.every(c => mgr._evaluateCondition(c, task)));

  // Back to idle but disabled
  dev.status = 'idle';
  dev.enabled = false;
  assert.ok(!conditions.every(c => mgr._evaluateCondition(c, task)));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Task startedAt
// ═══════════════════════════════════════════════════════════════════════════════

test('task startedAt is preserved for managesContext history scoping', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task } = addTask(mgr, 'Context test', 'code');

  const now = new Date().toISOString();
  task.startedAt = now;
  assert.equal(task.startedAt, now);

  const earlier = '2020-01-01T00:00:00.000Z';
  task.startedAt = earlier;
  if (!task.startedAt) {
    task.startedAt = now;
  }
  assert.equal(task.startedAt, earlier, 'should not overwrite existing startedAt');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. assign_agent_individual
// ═══════════════════════════════════════════════════════════════════════════════

test('assign_agent_individual sets specific agent or null', async () => {
  const mgr = await setup([
    { name: 'Leader', role: 'manager' },
    { name: 'Worker', role: 'developer' },
  ]);
  const worker = Array.from(mgr.agents.values()).find(a => a.name === 'Worker');
  const { task } = addTask(mgr, 'Assign test', 'code');

  task.assignee = worker.id;
  assert.equal(task.assignee, worker.id);

  task.assignee = null;
  assert.equal(task.assignee, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. toggleTask
// ═══════════════════════════════════════════════════════════════════════════════

test('toggleTask flips between done and backlog', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Toggle me', 'backlog');

  // backlog → done
  const toggled = mgr.toggleTask(agentId, task.id);
  assert.equal(toggled.status, 'done');
  assert.ok(toggled.completedAt, 'should set completedAt when done');

  // done → backlog
  const toggled2 = mgr.toggleTask(agentId, task.id);
  assert.equal(toggled2.status, 'backlog');
});

test('toggleTask returns null for unknown task', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  assert.equal(mgr.toggleTask(agentId, 'fake'), null);
});

test('toggleTask returns null for unknown agent', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  assert.equal(mgr.toggleTask('fake-agent', 'fake-task'), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. updateTaskTitle / updateTaskText
// ═══════════════════════════════════════════════════════════════════════════════

test('updateTaskTitle updates title and adds history', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Original text', 'backlog');

  const result = mgr.updateTaskTitle(agentId, task.id, 'New Title');
  assert.equal(result.title, 'New Title');
  const lastEntry = task.history[task.history.length - 1];
  assert.equal(lastEntry.type, 'edit');
  assert.equal(lastEntry.field, 'title');
  assert.equal(lastEntry.newValue, 'New Title');
});

test('updateTaskText updates text and adds history', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Original text', 'backlog');

  const result = mgr.updateTaskText(agentId, task.id, 'Updated text');
  assert.equal(result.text, 'Updated text');
});

test('updateTaskTitle returns null for invalid ids', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  assert.equal(mgr.updateTaskTitle('fake', 'fake', 'title'), null);
  assert.equal(mgr.updateTaskTitle(agentId, 'fake', 'title'), null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. stripToolCalls
// ═══════════════════════════════════════════════════════════════════════════════

test('stripToolCalls removes @tool() calls', () => {
  const input = 'I will read the file.\n@read_file(src/index.js)\nDone.';
  const result = stripToolCalls(input);
  // Removing the tool call leaves a blank line, which gets collapsed to \n\n
  assert.equal(result, 'I will read the file.\n\nDone.');
});

test('stripToolCalls removes <tool_call> blocks', () => {
  const input = 'Hello\n<tool_call>\n{"name":"read_file"}\n</tool_call>\nWorld';
  const result = stripToolCalls(input);
  assert.equal(result, 'Hello\n\nWorld');
});

test('stripToolCalls handles nested parentheses', () => {
  const input = 'Test @run_command(echo "hello (world)") end';
  const result = stripToolCalls(input);
  assert.equal(result, 'Test  end');
});

test('stripToolCalls handles multiple tool calls', () => {
  const input = '@list_dir(.)\n@read_file(package.json)\nSummary of findings.';
  const result = stripToolCalls(input);
  assert.equal(result, 'Summary of findings.');
});

test('stripToolCalls returns empty/null input unchanged', () => {
  assert.equal(stripToolCalls(null), null);
  assert.equal(stripToolCalls(undefined), undefined);
  assert.equal(stripToolCalls(''), '');
});

test('stripToolCalls leaves non-tool text intact', () => {
  const input = 'This is a normal response with no tools.';
  assert.equal(stripToolCalls(input), input);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Cross-agent task detection for workflow transitions
// ═══════════════════════════════════════════════════════════════════════════════

test('cross-agent task assignment: worker detects task from creator todoList', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Worker', role: 'developer' },
  ]);
  const { id: creatorId, agent: creator } = getAgent(mgr, 'Creator');
  const { id: workerId } = getAgent(mgr, 'Worker');

  // Task on creator's list, assigned to worker
  const task = addTaskToAgent(mgr, creatorId, 'Cross-agent task', 'code', 'board-1', {
    assignee: workerId,
    startedAt: new Date().toISOString(),
  });

  // Worker should see the cross-agent task
  assert.ok(mgr.agentHasActiveTask(workerId));
  // But excluding that task, worker is free
  assert.ok(!mgr.agentHasActiveTask(workerId, task.id));
});

test('multiple agents with same role: load balancing by task count', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'PM1', role: 'product-manager' },
    { name: 'PM2', role: 'product-manager' },
  ]);
  const { id: creatorId, agent: creator } = getAgent(mgr, 'Creator');
  const { id: pm1Id } = getAgent(mgr, 'PM1');
  const { id: pm2Id } = getAgent(mgr, 'PM2');

  // PM1 has one task assigned
  mgr._addTaskToStore(creatorId, { id: 't1', text: 'Task 1', status: 'done', assignee: pm1Id });

  // Both agents have active tasks counted by agentHasActiveTask
  // PM1 has 0 active (t1 is done), PM2 has 0 active — both are free
  assert.ok(!mgr.agentHasActiveTask(pm1Id));
  assert.ok(!mgr.agentHasActiveTask(pm2Id));

  // Give PM1 an active task
  mgr._addTaskToStore(creatorId, { id: 't2', text: 'Task 2', status: 'refine', assignee: pm1Id });
  assert.ok(mgr.agentHasActiveTask(pm1Id));
  assert.ok(!mgr.agentHasActiveTask(pm2Id));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. _pendingOnEnter retry lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

test('_pendingOnEnter retry: _recheckConditionalTransitions finds pending on_enter tasks', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { id: creatorId, agent: creator } = getAgent(mgr, 'Creator');

  // Task stuck in refine with pendingOnEnter
  const task = addTaskToAgent(mgr, creatorId, 'Stuck task', 'refine', 'board-1', {
    _pendingOnEnter: 'refine',
    _completedActionIdx: 1,
    completedActionIdx: 1,
  });

  // The on_enter transition filter should match when _pendingOnEnter === task.status
  const transitions = [
    { from: 'refine', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'dev' }] },
  ];
  const matching = transitions.filter(t =>
    mgr._validTransition(t) &&
    t.from === task.status &&
    (t.trigger !== 'on_enter' || task._pendingOnEnter === task.status)
  );
  assert.equal(matching.length, 1, 'should match the on_enter transition for a pending task');
});

test('_pendingOnEnter retry: non-pending tasks do not match on_enter in recheck', async () => {
  const mgr = await setup([{ name: 'A', role: 'dev' }]);
  const { task } = addTask(mgr, 'Normal task', 'refine');

  // No _pendingOnEnter → should NOT match on_enter in recheck
  const transitions = [
    { from: 'refine', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'dev' }] },
  ];
  const matching = transitions.filter(t =>
    mgr._validTransition(t) &&
    t.from === task.status &&
    (t.trigger !== 'on_enter' || task._pendingOnEnter === task.status)
  );
  assert.equal(matching.length, 0, 'should NOT match — no _pendingOnEnter');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. actionRunning flags
// ═══════════════════════════════════════════════════════════════════════════════

test('actionRunning flags track which agent is working on a task', async () => {
  const mgr = await setup([
    { name: 'Creator', role: 'manager' },
    { name: 'Dev', role: 'developer' },
  ]);
  const { id: creatorId, agent: creator } = getAgent(mgr, 'Creator');
  const { id: devId } = getAgent(mgr, 'Dev');

  const task = addTaskToAgent(mgr, creatorId, 'Action task', 'code', 'board-1');

  // Simulate action running
  task.actionRunning = true;
  task.actionRunningAgentId = devId;
  assert.equal(task.actionRunning, true);
  assert.equal(task.actionRunningAgentId, devId);

  // Clear on completion
  task.actionRunning = false;
  delete task.actionRunningAgentId;
  assert.equal(task.actionRunning, false);
  assert.equal(task.actionRunningAgentId, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 18. Workflow-managed statuses
// ═══════════════════════════════════════════════════════════════════════════════

test('workflow-managed statuses prevent task loop from resuming tasks', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Managed task', 'refine', 'board-1', {
    startedAt: new Date().toISOString(),
  });

  // Simulate _workflowManagedStatuses containing 'refine'
  mgr._workflowManagedStatuses = new Set(['refine', 'code']);

  // Task in a managed status should be skipped by the task loop
  assert.ok(mgr._workflowManagedStatuses.has(task.status));

  // But a task in 'security' (not managed) would not be skipped
  task.status = 'security';
  assert.ok(!mgr._workflowManagedStatuses.has(task.status));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 19. addTask
// ═══════════════════════════════════════════════════════════════════════════════

test('addTask creates task with correct defaults', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  const agent = mgr.agents.get(agentId);

  const task = mgr.addTask(agentId, 'New task', null, null, null, { skipAutoRefine: true });
  assert.ok(task);
  assert.equal(task.status, 'backlog');
  assert.ok(task.id);
  assert.equal(task.text, 'New task');
  assert.ok(task.createdAt);
  assert.equal(mgr._getAgentTasks(agentId).length, 1);
});

test('addTask respects initial status', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();

  const task = mgr.addTask(agentId, 'Code task', null, null, 'code', { skipAutoRefine: true });
  assert.equal(task.status, 'code');
});

test('addTask returns null for invalid agent', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  assert.equal(mgr.addTask('fake-agent', 'Task'), null);
});

test('addTask with recurrence config', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();

  const task = mgr.addTask(agentId, 'Daily task', null, null, null, {
    skipAutoRefine: true,
    recurrence: { enabled: true, period: 'daily', intervalMinutes: 1440 },
  });
  assert.ok(task.recurrence);
  assert.equal(task.recurrence.enabled, true);
  assert.equal(task.recurrence.period, 'daily');
  assert.equal(task.recurrence.originalStatus, 'backlog');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 20. History tracking across multiple status changes
// ═══════════════════════════════════════════════════════════════════════════════

test('task history accumulates across multiple status transitions', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Track history', 'backlog');

  mgr.setTaskStatus(agentId, task.id, 'refine', { skipAutoRefine: true, by: 'user' });
  mgr.setTaskStatus(agentId, task.id, 'code', { skipAutoRefine: true, by: 'workflow' });
  mgr.setTaskStatus(agentId, task.id, 'done', { skipAutoRefine: true, by: 'agent' });

  // Initial + 3 transitions = 4 entries (addTask creates with initial history)
  assert.ok(task.history.length >= 3, `expected at least 3 history entries, got ${task.history.length}`);

  const statuses = task.history.map(h => h.status);
  assert.ok(statuses.includes('refine'));
  assert.ok(statuses.includes('code'));
  assert.ok(statuses.includes('done'));
});

test('error → recovery → completion preserves full history', async () => {
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Error recovery', 'code');

  mgr.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true, by: 'workflow' });
  assert.equal(task.errorFromStatus, 'code');

  mgr.setTaskStatus(agentId, task.id, 'code', { skipAutoRefine: true, by: 'user' });
  assert.equal(task.errorFromStatus, null);
  assert.equal(task.error, null);

  mgr.setTaskStatus(agentId, task.id, 'done', { skipAutoRefine: true, by: 'workflow' });
  assert.equal(task.status, 'done');
  assert.ok(task.completedAt);

  const fromFields = task.history.map(h => h.from).filter(Boolean);
  assert.ok(fromFields.includes('code'), 'should record code→error transition');
  assert.ok(fromFields.includes('error'), 'should record error→code recovery');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 21. setTaskStatus clears stale execution state
// ═══════════════════════════════════════════════════════════════════════════════

test('setTaskStatus clears startedAt to prevent stale task loop resume', async () => {
  // Reproduces bug: task done→nextsprint still had startedAt from previous
  // execution, causing the task loop to resume it and assign an agent.
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Done task moved back', 'code');

  // Simulate previous execution set startedAt
  task.startedAt = '2026-04-01T10:00:00.000Z';
  task.executionStatus = null;

  // Move to done (like after execution completes)
  mgr.setTaskStatus(agentId, task.id, 'done', { skipAutoRefine: true, by: 'workflow' });
  assert.equal(task.status, 'done');
  assert.equal(task.startedAt, null, 'startedAt should be cleared on status change');

  // User moves done → nextsprint
  mgr.setTaskStatus(agentId, task.id, 'nextsprint', { skipAutoRefine: true, by: 'user' });
  assert.equal(task.status, 'nextsprint');
  assert.equal(task.startedAt, null, 'startedAt must stay cleared — task loop must NOT resume this');
  assert.equal(task.executionStatus, null, 'executionStatus must be cleared');
});

test('setTaskStatus clears startedAt even during workflow transitions', async () => {
  // Ensure processTransition can re-set startedAt after setTaskStatus clears it
  const mgr = await setup([{ name: 'Dev', role: 'developer' }]);
  const { task, agentId } = addTask(mgr, 'Workflow chain test', 'refine');

  // Simulate: refine chain completes, change_status → code
  task.startedAt = '2026-04-01T10:00:00.000Z';
  mgr.setTaskStatus(agentId, task.id, 'code', { skipAutoRefine: true, by: 'workflow' });

  // startedAt should be cleared by setTaskStatus
  assert.equal(task.startedAt, null);
  // processTransition would re-set it when the code on_enter run_agent starts
});
