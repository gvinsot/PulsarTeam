/**
 * Workflow Pipeline Integration Tests
 *
 * Tests that tasks flow through a multi-step workflow pipeline from todo → done,
 * with mocked LLM calls and parallel task execution.
 *
 * Workflow under test:
 *   todo → step1 (set_type) → step2 (title) → step3 (refine) → step4 → done
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Module mocks — must be registered BEFORE importing modules under test ────

const noop = async () => {};
const noopSync = () => {};

// Mock database: every export as a no-op
mock.module('../database.js', {
  namedExports: {
    initializeDatabase: noop,
    getPool: () => null,
    getAllAgents: async () => [],
    saveAgent: noop,
    deleteAgentFromDb: noop,
    setAgentOwner: noop,
    getAllLlmConfigs: async () => [],
    recordTokenUsage: noop,
    saveTaskToDb: noop,
    deleteTaskFromDb: noop,
    deleteTasksByAgent: noop,
    hardDeleteTaskFromDb: noop,
    restoreTaskFromDb: async () => null,
    getDeletedTasks: async () => [],
    getDeletedTaskById: async () => null,
    getTasksForResume: async () => [],
    updateTaskExecutionStatus: noop,
    getTaskById: async () => null,
    getTasksByAgent: async () => [],
    getActiveTasksByAgent: async () => [],
    getActiveTaskForExecutor: async () => null,
    getRecurringDoneTasks: async () => [],
    hasActiveTask: async () => false,
    updateTaskFields: noop,
    clearTaskExecutionFlags: noop,
    clearActionRunningForAgent: noop,
    softDeleteTaskFromDb: noop,
    getAllBoards: async () => [],
    getBoardById: async () => null,
    getDefaultBoard: async () => null,
    getAllSkills: async () => [],
    saveSkill: noop,
    deleteSkillFromDb: noop,
    getAllMcpServers: async () => [],
    saveMcpServer: noop,
    deleteMcpServerFromDb: noop,
  },
});

// Mock configManager
const TEST_WORKFLOW = {
  columns: [
    { id: 'todo', color: '#6b7280', label: 'Todo' },
    { id: 'step1', color: '#3b82f6', label: 'Step1' },
    { id: 'step2', color: '#6b7280', label: 'Step2' },
    { id: 'step3', color: '#6b7280', label: 'Step3' },
    { id: 'step4', color: '#6b7280', label: 'Step4' },
    { id: 'done', color: '#22c55e', label: 'Done' },
  ],
  transitions: [
    {
      from: 'todo', trigger: 'on_enter', conditions: [],
      actions: [{ type: 'change_status', target: 'step1' }],
    },
    {
      from: 'step1', trigger: 'on_enter', conditions: [],
      actions: [
        { mode: 'set_type', role: 'titles-manager', type: 'run_agent' },
        { type: 'change_status', target: 'step2' },
      ],
    },
    {
      from: 'step2', trigger: 'on_enter', conditions: [],
      actions: [
        { mode: 'title', role: 'titles-manager', type: 'run_agent' },
        { type: 'change_status', target: 'step3' },
      ],
    },
    {
      from: 'step3', trigger: 'on_enter', conditions: [],
      actions: [
        { mode: 'refine', role: 'titles-manager', type: 'run_agent', instructions: '' },
        { type: 'change_status', target: 'step4' },
      ],
    },
    {
      from: 'step4', trigger: 'on_enter', conditions: [],
      actions: [{ type: 'change_status', target: 'done' }],
    },
  ],
};

mock.module('../configManager.js', {
  namedExports: {
    getWorkflowForBoard: async () => TEST_WORKFLOW,
    getAllBoardWorkflows: async () => [{ boardId: 'board-test', workflow: TEST_WORKFLOW }],
    getSettings: async () => ({}),
    getWorkflow: async () => TEST_WORKFLOW,
    getReminderConfig: async () => ({
      intervalMinutes: 5, cooldownMinutes: 1, maxReminders: 3,
      intervalMs: 300000, cooldownMs: 60000,
    }),
  },
});

mock.module('../githubProjects.js', {
  namedExports: {
    getProjectGitUrl: async () => null,
    listStarredRepos: async () => [],
  },
});

mock.module('../jiraSync.js', {
  namedExports: {
    onTaskStatusChanged: noopSync,
    executeTransitionActions: noop,
  },
});

// Now import the module under test
const { AgentManager } = await import('../agentManager.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockIo = { emit() {}, to() { return { emit() {} }; } };

async function setup(agentDefs = []) {
  const mgr = new AgentManager(mockIo, null, null, null);
  for (const def of agentDefs) {
    const created = await mgr.create(def);
    const raw = mgr.agents.get(created.id);
    raw.status = 'idle';
    raw.conversationHistory = [];
    mgr._tasks.set(created.id, []);
  }

  // Mock sendMessage — simulates LLM returning immediately
  mgr.sendMessage = async (agentId, message, streamCallback) => {
    await new Promise(r => setTimeout(r, 2));
    const agent = mgr.agents.get(agentId);
    if (agent) agent.status = 'idle';
    return 'Mocked LLM response.';
  };

  // Mock execution log — no-op
  mgr._saveExecutionLog = () => {};

  return mgr;
}

function createTask(mgr, text, status = 'backlog') {
  const [firstAgentId] = mgr.agents.keys();
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    title: null,
    status,
    boardId: 'board-test',
    assignee: null,
    taskType: null,
    history: [],
    commits: [],
    error: null,
    startedAt: null,
    completedAt: null,
    executionStatus: null,
    completedActionIdx: null,
    actionRunning: false,
    actionRunningAgentId: null,
    createdAt: new Date().toISOString(),
  };
  mgr._addTaskToStore(firstAgentId, task);
  return { task, agentId: firstAgentId };
}

async function waitForStatus(mgr, agentId, taskId, expectedStatus, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = mgr._getAgentTasks(agentId).find(t => t.id === taskId);
    if (task?.status === expectedStatus) return task;
    // Trigger the recheck loop manually (simulates the 5s task loop interval)
    mgr._recheckConditionalTransitions();
    await new Promise(r => setTimeout(r, 100));
  }
  const task = mgr._getAgentTasks(agentId).find(t => t.id === taskId);
  const transitions = (task?.history || [])
    .filter(h => h.from !== undefined)
    .map(h => `${h.from}→${h.status}`);
  throw new Error(
    `Task ${taskId.slice(0, 12)} stuck at "${task?.status}" (expected "${expectedStatus}"). ` +
    `Transitions: [${transitions.join(', ')}]`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

test('single task flows through entire pipeline: todo → done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'titles-manager' }]);
  const { task, agentId } = createTask(mgr, 'Build a login page');

  mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });
  const final = await waitForStatus(mgr, agentId, task.id, 'done');

  assert.equal(final.status, 'done');
  assert.ok(final.completedAt, 'completedAt should be set');

  const statuses = final.history.filter(h => h.from !== undefined).map(h => h.status);
  for (const step of ['todo', 'step1', 'step2', 'step3', 'step4', 'done']) {
    assert.ok(statuses.includes(step), `Missing transition to "${step}"`);
  }
});

test('3 parallel tasks all reach done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'titles-manager' }]);

  const tasks = Array.from({ length: 3 }, (_, i) =>
    createTask(mgr, `Parallel task ${i + 1}`)
  );

  for (const { task, agentId } of tasks)
    mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done'))
  );

  for (const r of results) assert.equal(r.status, 'done');
});

test('5 parallel tasks with 1 agent all reach done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'titles-manager' }]);

  const tasks = Array.from({ length: 5 }, (_, i) =>
    createTask(mgr, `Stress task ${i + 1}`)
  );

  for (const { task, agentId } of tasks)
    mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done', 30000))
  );

  assert.equal(results.filter(r => r.status !== 'done').length, 0);
});

test('5 parallel tasks with 2 agents all reach done', async () => {
  const mgr = await setup([
    { name: 'TitlesBot-A', role: 'titles-manager' },
    { name: 'TitlesBot-B', role: 'titles-manager' },
  ]);

  const tasks = Array.from({ length: 5 }, (_, i) =>
    createTask(mgr, `Multi-agent task ${i + 1}`)
  );

  for (const { task, agentId } of tasks)
    mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done', 30000))
  );

  assert.equal(results.filter(r => r.status !== 'done').length, 0);
});

test('task history records every transition in order', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'titles-manager' }]);
  const { task, agentId } = createTask(mgr, 'History test');

  mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });
  const final = await waitForStatus(mgr, agentId, task.id, 'done');

  const transitions = final.history
    .filter(h => h.from !== undefined)
    .map(h => `${h.from}→${h.status}`);

  const expected = [
    'backlog→todo', 'todo→step1', 'step1→step2',
    'step2→step3', 'step3→step4', 'step4→done',
  ];
  for (const t of expected) {
    assert.ok(transitions.includes(t), `Missing "${t}". Got: [${transitions.join(', ')}]`);
  }
});

test('step4 → done transitions instantly (no run_agent)', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'titles-manager' }]);
  const { task, agentId } = createTask(mgr, 'Instant test');

  mgr.setTaskStatus(agentId, task.id, 'step4', { by: 'user' });
  const final = await waitForStatus(mgr, agentId, task.id, 'done');
  assert.equal(final.status, 'done');
});

test('status does not regress after reaching done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'titles-manager' }]);
  const { task, agentId } = createTask(mgr, 'No regression');

  mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });
  await waitForStatus(mgr, agentId, task.id, 'done');

  // Let any straggling async operations settle
  await new Promise(r => setTimeout(r, 500));
  assert.equal(task.status, 'done');
});

test('10 tasks fired rapidly with 3 agents all complete', async () => {
  const mgr = await setup([
    { name: 'Bot-A', role: 'titles-manager' },
    { name: 'Bot-B', role: 'titles-manager' },
    { name: 'Bot-C', role: 'titles-manager' },
  ]);

  const tasks = Array.from({ length: 10 }, (_, i) =>
    createTask(mgr, `Rapid task ${i + 1}`)
  );

  for (const { task, agentId } of tasks)
    mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done', 60000))
  );

  const stuck = results.filter(r => r.status !== 'done');
  assert.equal(stuck.length, 0, `${stuck.length} task(s) stuck`);
});
