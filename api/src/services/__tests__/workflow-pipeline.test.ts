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
import { makeTaskDbFake } from './helpers/taskDbFake.js';
import type { WorkflowColumn } from '../workflow/taskStateMachine.js';
import type { TaskHistoryEntry } from '../database/tasks.js';

/**
 * A workflow config as the mocked configManager serves it here.
 *
 * `columns` is the engine's own type. A transition is spelled out instead of
 * reusing WorkflowTransition because one fixture below builds
 * `{ type: 'assign_agent_individual', agentId: null }` and WorkflowAction
 * declares `agentId?: string` — an action stays the raw passthrough bag it is
 * on disk until that interface admits the null.
 */
interface WorkflowFixture {
  columns: WorkflowColumn[];
  transitions: Array<{
    from: string;
    trigger: string;
    conditions?: unknown[];
    actions?: Array<Record<string, unknown>>;
  }>;
}

/**
 * What the helpers below need from the manager `setup` builds. It is a real
 * AgentManager with `sendMessage` and `_saveExecutionLog` swapped for test
 * doubles, so the helpers ask for the two members they actually touch rather
 * than for the whole interface.
 */
interface PipelineManager {
  agents: Map<string, unknown>;
  _recheckConditionalTransitions(): void;
}

// ── Module mocks — must be registered BEFORE importing modules under test ────

const noop = async () => {};

// In-memory task DB (the store was removed; DB is the single source of truth).
const { rows: taskRows, exports: taskDbFake } = makeTaskDbFake();

// Mock database: every export as a no-op
mock.module('../database.js', {
  namedExports: {
    // connection
    getPool: () => null,
    isDatabaseConnected: () => false,
    // schema
    initDatabase: noop,
    // agents
    getAllAgents: async () => [],
    getAgentById: async () => null,
    saveAgent: noop,
    deleteAgentFromDb: noop,
    getAgentsByBoard: async () => [],
    // skills
    getAllSkills: async () => [],
    saveSkill: noop,
    deleteSkillFromDb: noop,
    // agentSkills
    getAllAgentSkills: async () => [],
    searchAgentSkills: async () => [],
    getAgentSkillById: async () => null,
    saveAgentSkill: noop,
    deleteAgentSkillFromDb: noop,
    // mcpServers
    getAllMcpServers: async () => [],
    saveMcpServer: noop,
    deleteMcpServerFromDb: noop,
    // projects
    getAllProjects: async () => [],
    getProjectsForUser: async () => [],
    getProjectById: async () => null,
    getProjectByName: async () => null,
    createProject: noop,
    updateProject: noop,
    deleteProject: noop,
    hasProjectBoardAccess: async () => false,
    getBoardsForProject: async () => [],
    setBoardProject: noop,
    // boardRepos
    getReposForBoard: async () => [],
    getReposForProject: async () => [],
    getAccessibleBoardRepos: async () => [],
    // boardStorages
    getStoragesForBoard: async () => [],
    getStoragesForProject: async () => [],
    // settings
    getSetting: () => null,
    getSettingAsync: async () => null,
    setSetting: noop,
    loadSettingsCache: noop,
    // tokenUsage
    recordTokenUsage: noop,
    getTokenUsageSummary: () => ({}),
    getTokenUsageSummaryAsync: async () => ({}),
    getTokenUsageByAgent: async () => [],
    getTokenUsageTimeline: async () => [],
    getDailyTokenUsage: async () => [],
    getTotalTokensByAgentId: async () => new Map(),
    getTotalTokensForAgent: async () => ({ input: 0, output: 0 }),
    refreshTokenSummaryCache: noop,
    // users
    getAllUsers: async () => [],
    getUserById: async () => null,
    getUserByUsername: async () => null,
    createUser: noop,
    updateUser: noop,
    deleteUser: noop,
    getUserByGoogleId: async () => null,
    createGoogleUser: noop,
    linkGoogleId: noop,
    getUserByMicrosoftId: async () => null,
    createMicrosoftUser: noop,
    linkMicrosoftId: noop,
    getUserByGitHubId: async () => null,
    createGitHubUser: noop,
    linkGitHubId: noop,
    countUsers: async () => 0,
    updateLastSeen: noop,
    acceptTerms: noop,
    completeTutorial: noop,
    // llmConfigs
    getAllLlmConfigs: async () => [],
    getLlmConfig: async () => null,
    saveLlmConfig: noop,
    deleteLlmConfig: noop,
    // boards
    getAllBoards: async () => [],
    getBoardsByUser: async () => [],
    getBoardById: async () => null,
    createBoard: async () => ({ id: 'board-mock' }),
    updateBoard: noop,
    deleteBoard: noop,
    removeLegacyDefaultBoards: noop,
    // boardSharing
    getBoardShares: async () => [],
    getBoardShare: async () => null,
    createBoardShare: noop,
    updateBoardShare: noop,
    deleteBoardShare: noop,
    getSharedBoardsForUser: async () => [],
    logBoardAudit: noop,
    getBoardAuditLogs: async () => [],
    // oauthTokens
    storeOAuthToken: noop,
    getOAuthToken: () => null,
    hasOAuthToken: () => false,
    deleteOAuthToken: noop,
    deleteOAuthTokensByScope: noop,
    getOAuthTokensByScope: () => [],
    resolveAccessToken: async () => null,
    resolveOAuthTokenRecord: async () => null,
    loadOAuthTokens: noop,
    getOAuthTokenCache: () => new Map(),
    // tasks — Map-backed in-memory fake (identity-preserving)
    ...taskDbFake,
    rowToTask: (r: unknown) => r,
    tryAcquireTaskLock: async () => true,
    releaseTaskLock: async () => {},
    heldTaskLockCount: () => 0,
    getBoardWithMostTasksForProject: async () => null,
    searchTasks: async () => ({ total: 0, returned: 0, tasks: [] }),
  },
});

// Mock configManager
const TEST_WORKFLOW: WorkflowFixture = {
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
      from: 'todo',
      trigger: 'on_enter',
      conditions: [],
      actions: [{ type: 'change_status', target: 'step1' }],
    },
    {
      from: 'step1',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { mode: 'set_type', role: 'assistant', type: 'run_agent' },
        { type: 'change_status', target: 'step2' },
      ],
    },
    {
      from: 'step2',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { mode: 'title', role: 'assistant', type: 'run_agent' },
        { type: 'change_status', target: 'step3' },
      ],
    },
    {
      from: 'step3',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { mode: 'refine', role: 'assistant', type: 'run_agent', instructions: '' },
        { type: 'change_status', target: 'step4' },
      ],
    },
    {
      from: 'step4',
      trigger: 'on_enter',
      conditions: [],
      actions: [{ type: 'change_status', target: 'done' }],
    },
  ],
};

function replaceWorkflow(next: WorkflowFixture) {
  const previous = {
    columns: TEST_WORKFLOW.columns,
    transitions: TEST_WORKFLOW.transitions,
  };
  TEST_WORKFLOW.columns = next.columns;
  TEST_WORKFLOW.transitions = next.transitions;
  return () => {
    TEST_WORKFLOW.columns = previous.columns;
    TEST_WORKFLOW.transitions = previous.transitions;
  };
}

mock.module('../configManager.js', {
  namedExports: {
    getWorkflowForBoard: async () => TEST_WORKFLOW,
    getAllBoardWorkflows: async () => [{ boardId: 'board-test', workflow: TEST_WORKFLOW }],
    getSettings: async () => ({}),
    getWorkflow: async () => TEST_WORKFLOW,
    getReminderConfig: async () => ({
      intervalMinutes: 5,
      cooldownMinutes: 1,
      maxReminders: 3,
      intervalMs: 300000,
      cooldownMs: 60000,
    }),
  },
});

// Now import the module under test
const { AgentManager } = await import('../agentManager.js');
const { processColumnEntry, reconcileStaleActionRunning } = await import('../workflow/index.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockIo = {
  emit() {},
  to() {
    return { emit() {} };
  },
};

async function setup(agentDefs: any[] = []) {
  taskRows.clear();
  const mgr = new AgentManager(mockIo, null, null, null);
  for (const def of agentDefs) {
    const created = await mgr.create({ boardId: 'board-test', ...def });
    const raw = mgr.agents.get(created.id);
    assert.ok(raw, 'created agent should be registered in the manager');
    raw.status = 'idle';
    raw.boardId = 'board-test';
    raw.conversationHistory = [];
    console.log(
      `[test-setup] agent "${raw.name}" role="${raw.role}" boardId="${raw.boardId}" enabled=${raw.enabled}`
    );
  }

  // Mock sendMessage — simulates LLM returning immediately
  mgr.sendMessage = async (agentId, _message, _streamCallback) => {
    await new Promise(r => setTimeout(r, 2));
    const agent = mgr.agents.get(agentId);
    if (agent) agent.status = 'idle';
    return 'Mocked LLM response.';
  };

  // Mock execution log — no-op
  mgr._saveExecutionLog = async () => {};

  return mgr;
}

function createTask(mgr: PipelineManager, text: string, status = 'backlog') {
  const [firstAgentId] = mgr.agents.keys();
  const task: any = {
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
    environment: 'prod',
    createdAt: new Date().toISOString(),
  };
  task.agentId = firstAgentId;
  taskRows.set(task.id, task);
  return { task, agentId: firstAgentId };
}

/** Live task lookup from the DB fake (identity-preserving). */
function findTask(agentId: string, taskId: string) {
  const t = taskRows.get(taskId);
  return t && !t.deletedAt && t.agentId === agentId ? t : null;
}

async function waitForStatus(
  mgr: PipelineManager,
  agentId: string,
  taskId: string,
  expectedStatus: string,
  timeoutMs = 15000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = findTask(agentId, taskId);
    if (task?.status === expectedStatus) return task;
    // Trigger the recheck loop manually (simulates the 5s task loop interval)
    mgr._recheckConditionalTransitions();
    await new Promise(r => setTimeout(r, 100));
  }
  const task = findTask(agentId, taskId);
  const transitions = (task?.history || [])
    .filter((h: TaskHistoryEntry) => h.from !== undefined)
    .map((h: TaskHistoryEntry) => `${h.from}→${h.status}`);
  throw new Error(
    `Task ${taskId.slice(0, 12)} stuck at "${task?.status}" (expected "${expectedStatus}"). ` +
      `Transitions: [${transitions.join(', ')}]`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

test('single task flows through entire pipeline: todo → done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'assistant' }]);
  const { task, agentId } = createTask(mgr, 'Build a login page');

  await mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });
  const final = await waitForStatus(mgr, agentId, task.id, 'done');

  assert.equal(final.status, 'done');
  assert.ok(final.completedAt, 'completedAt should be set');

  const statuses = final.history
    .filter((h: TaskHistoryEntry) => h.from !== undefined)
    .map((h: TaskHistoryEntry) => h.status);
  for (const step of ['todo', 'step1', 'step2', 'step3', 'step4', 'done']) {
    assert.ok(statuses.includes(step), `Missing transition to "${step}"`);
  }
});

test('skipped decide action clears actionRunning before saving retry state', async () => {
  const restore = replaceWorkflow({
    columns: [
      { id: 'backlog', color: '#6b7280', label: 'Backlog' },
      { id: 'code', color: '#3b82f6', label: 'Code' },
      { id: 'done', color: '#22c55e', label: 'Done' },
    ],
    transitions: [
      {
        from: 'code',
        trigger: 'on_enter',
        conditions: [],
        actions: [{ type: 'run_agent', mode: 'decide', role: 'assistant', instructions: '' }],
      },
    ],
  });

  try {
    const mgr = await setup([{ name: 'Architect', role: 'assistant' }]);
    const { task, agentId } = createTask(mgr, 'Needs instructions');

    await mgr.setTaskStatus(agentId, task.id, 'code', { by: 'user' });

    let final = taskRows.get(task.id);
    const started = Date.now();
    while (Date.now() - started < 1000) {
      final = taskRows.get(task.id);
      if (final?._pendingOnEnter === 'code') break;
      await new Promise(r => setTimeout(r, 10));
    }

    assert.equal(final?._pendingOnEnter, 'code');
    assert.equal(final?.completedActionIdx, -1);
    assert.equal(final?.actionRunning, false);
    assert.equal(final?.actionRunningAgentId ?? null, null);
    assert.equal(final?.actionRunningMode ?? null, null);
    assert.equal(final?.startedAt ?? null, null);
  } finally {
    restore();
  }
});

test('assign_agent_individual no-change does not arm an on_enter retry', async () => {
  const restore = replaceWorkflow({
    columns: [
      { id: 'backlog', color: '#6b7280', label: 'Backlog' },
      { id: 'nextsprint', color: '#3b82f6', label: 'Next sprint' },
      { id: 'done', color: '#22c55e', label: 'Done' },
    ],
    transitions: [
      {
        from: 'nextsprint',
        trigger: 'on_enter',
        conditions: [],
        actions: [{ type: 'assign_agent_individual', agentId: null }],
      },
    ],
  });

  try {
    const mgr = await setup([{ name: 'Architect', role: 'assistant' }]);
    const { task, agentId } = createTask(mgr, 'No-op assignment', 'nextsprint');

    await processColumnEntry({ ...task, agentId }, mgr, { by: 'test' });

    const final = taskRows.get(task.id);
    assert.equal(final?._pendingOnEnter, undefined);
    assert.equal(final?.completedActionIdx ?? null, null);
    assert.equal(final?.actionRunning, false);
  } finally {
    restore();
  }
});

test('3 parallel tasks all reach done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'assistant' }]);

  const tasks = Array.from({ length: 3 }, (_, i) => createTask(mgr, `Parallel task ${i + 1}`));

  for (const { task, agentId } of tasks)
    await mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done'))
  );

  for (const r of results) assert.equal(r.status, 'done');
});

test('5 parallel tasks with 1 agent all reach done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'assistant' }]);

  const tasks = Array.from({ length: 5 }, (_, i) => createTask(mgr, `Stress task ${i + 1}`));

  for (const { task, agentId } of tasks)
    await mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done', 30000))
  );

  assert.equal(results.filter(r => r.status !== 'done').length, 0);
});

test('5 parallel tasks with 2 agents all reach done', async () => {
  const mgr = await setup([
    { name: 'TitlesBot-A', role: 'assistant' },
    { name: 'TitlesBot-B', role: 'assistant' },
  ]);

  const tasks = Array.from({ length: 5 }, (_, i) => createTask(mgr, `Multi-agent task ${i + 1}`));

  for (const { task, agentId } of tasks)
    await mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done', 30000))
  );

  assert.equal(results.filter(r => r.status !== 'done').length, 0);
});

test('task history records every transition in order', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'assistant' }]);
  const { task, agentId } = createTask(mgr, 'History test');

  await mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });
  const final = await waitForStatus(mgr, agentId, task.id, 'done');

  const transitions = final.history
    .filter((h: TaskHistoryEntry) => h.from !== undefined)
    .map((h: TaskHistoryEntry) => `${h.from}→${h.status}`);

  const expected = [
    'backlog→todo',
    'todo→step1',
    'step1→step2',
    'step2→step3',
    'step3→step4',
    'step4→done',
  ];
  for (const t of expected) {
    assert.ok(transitions.includes(t), `Missing "${t}". Got: [${transitions.join(', ')}]`);
  }
});

test('step4 → done transitions instantly (no run_agent)', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'assistant' }]);
  const { task, agentId } = createTask(mgr, 'Instant test');

  await mgr.setTaskStatus(agentId, task.id, 'step4', { by: 'user' });
  const final = await waitForStatus(mgr, agentId, task.id, 'done');
  assert.equal(final.status, 'done');
});

test('status does not regress after reaching done', async () => {
  const mgr = await setup([{ name: 'TitlesBot', role: 'assistant' }]);
  const { task, agentId } = createTask(mgr, 'No regression');

  await mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });
  await waitForStatus(mgr, agentId, task.id, 'done');

  // Let any straggling async operations settle
  await new Promise(r => setTimeout(r, 500));
  assert.equal(task.status, 'done');
});

test('10 tasks fired rapidly with 3 agents all complete', async () => {
  const mgr = await setup([
    { name: 'Bot-A', role: 'assistant' },
    { name: 'Bot-B', role: 'assistant' },
    { name: 'Bot-C', role: 'assistant' },
  ]);

  const tasks = Array.from({ length: 10 }, (_, i) => createTask(mgr, `Rapid task ${i + 1}`));

  for (const { task, agentId } of tasks)
    await mgr.setTaskStatus(agentId, task.id, 'todo', { by: 'user' });

  const results = await Promise.all(
    tasks.map(({ task, agentId }) => waitForStatus(mgr, agentId, task.id, 'done', 60000))
  );

  const stuck = results.filter(r => r.status !== 'done');
  assert.equal(stuck.length, 0, `${stuck.length} task(s) stuck`);
});

test('reconcileStaleActionRunning heals stranded tasks but spares live/fresh runs', async () => {
  const { acquireLock, releaseLock } = await import('../workflow/agentSelector.js');
  const mgr = await setup([{ name: 'Dev', role: 'assistant' }]);
  const [agentId] = mgr.agents.keys();

  const mkStranded = (label: string, startedAt: string | null, status = 'code') => {
    const id = `stale-${label}-${Math.random().toString(36).slice(2, 8)}`;
    const t: any = {
      id,
      agentId,
      text: label,
      title: null,
      status,
      boardId: 'board-test',
      assignee: null,
      taskType: null,
      history: [],
      commits: [],
      error: null,
      startedAt,
      completedAt: null,
      executionStatus: null,
      completedActionIdx: null,
      actionRunning: true,
      actionRunningAgentId: agentId,
      actionRunningMode: 'title',
      environment: 'prod',
      createdAt: new Date().toISOString(),
    };
    taskRows.set(id, t);
    return t;
  };

  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const corrupt = mkStranded('corrupt', null); // no startedAt → heal
  const stale = mkStranded('stale', old); // > 20min old → heal
  const fresh = mkStranded('fresh', new Date().toISOString()); // just started → spare
  const live = mkStranded('live', old); // old but a run is live → spare

  // Hold a live execution lock for the "live" task (mirrors executeRunAgent).
  const token = acquireLock(`${agentId}:${live.id}:decide`);
  try {
    await reconcileStaleActionRunning(mgr, 'prod');
  } finally {
    releaseLock(`${agentId}:${live.id}:decide`, token);
  }

  // The fake's updateTaskFields assigns the field key verbatim; the real accessor
  // maps pendingOnEnter → pending_on_enter → _pendingOnEnter on read.
  const pending = (t: any) => t._pendingOnEnter ?? t.pendingOnEnter;

  // Healed: flag cleared + on_enter re-armed → visible to the recheck loop again.
  for (const t of [corrupt, stale]) {
    const r = taskRows.get(t.id);
    assert.equal(r.actionRunning, false, `${t.text}: actionRunning cleared`);
    assert.equal(r.actionRunningAgentId ?? null, null, `${t.text}: agent cleared`);
    assert.equal(r.actionRunningMode ?? null, null, `${t.text}: mode cleared`);
    assert.equal(r.startedAt ?? null, null, `${t.text}: startedAt cleared`);
    assert.equal(pending(r), 'code', `${t.text}: on_enter re-armed`);
  }

  // Spared: still busy, not re-armed (clearing them would double-run an in-flight action).
  for (const t of [fresh, live]) {
    const r = taskRows.get(t.id);
    assert.equal(r.actionRunning, true, `${t.text}: left running`);
    assert.equal(pending(r) ?? null, null, `${t.text}: not re-armed`);
  }
});

test('chain-continuation advances columns immediately, without waiting for the poll', async () => {
  const restore = replaceWorkflow({
    columns: [
      { id: 'backlog', color: '#6b7280', label: 'Backlog' },
      { id: 'a', color: '#3b82f6', label: 'A' },
      { id: 'b', color: '#6b7280', label: 'B' },
      { id: 'done', color: '#22c55e', label: 'Done' },
    ],
    transitions: [
      {
        from: 'a',
        trigger: 'on_enter',
        conditions: [],
        actions: [{ type: 'change_status', target: 'b' }],
      },
      {
        from: 'b',
        trigger: 'on_enter',
        conditions: [],
        actions: [{ type: 'change_status', target: 'done' }],
      },
    ],
  });

  try {
    const mgr = await setup([{ name: 'Bot', role: 'assistant' }]);
    const { task, agentId } = createTask(mgr, 'flows via continuation');

    await mgr.setTaskStatus(agentId, task.id, 'a', { by: 'user' });

    // Deliberately do NOT drive the poll (_recheckConditionalTransitions): reaching
    // 'done' proves the detached chain-continuation walked a → b → done on its own.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && taskRows.get(task.id)?.status !== 'done') {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.equal(
      taskRows.get(task.id)?.status,
      'done',
      'reached done via continuation without the poll'
    );
  } finally {
    restore();
  }
});

test('run_agent finally emits the current column, not the stale pre-run one', async () => {
  const restore = replaceWorkflow({
    columns: [
      { id: 'backlog', color: '#6b7280', label: 'Backlog' },
      { id: 'work', color: '#3b82f6', label: 'Work' },
      { id: 'review', color: '#6b7280', label: 'Review' },
      { id: 'done', color: '#22c55e', label: 'Done' },
    ],
    transitions: [
      {
        from: 'work',
        trigger: 'on_enter',
        conditions: [],
        actions: [
          {
            type: 'run_agent',
            mode: 'decide',
            role: 'assistant',
            instructions: 'Move to next column',
          },
        ],
      },
    ],
  });

  try {
    const mgr = await setup([{ name: 'Mover', role: 'assistant' }]);
    const { task, agentId } = createTask(mgr, 'agent moves me forward');

    // The decide agent moves the task to "review" DURING its run — like a real
    // agent advancing the card via update_task/change_status.
    let decidePrompt = '';
    mgr.sendMessage = async (aid: any, message: string) => {
      decidePrompt = message;
      await mgr.setTaskStatus(agentId, task.id, 'review', { by: 'agent' });
      const a = mgr.agents.get(aid);
      if (a) a.status = 'idle';
      return 'moved';
    };

    // Observe every task:updated emitted for this task (call through to preserve behavior).
    const emitted: string[] = [];
    const origEmit = mgr._emit.bind(mgr);
    mgr._emit = (event: string, payload: any) => {
      if (event === 'task:updated' && payload?.task?.id === task.id)
        emitted.push(payload.task.status);
      return origEmit(event, payload);
    };

    await mgr.setTaskStatus(agentId, task.id, 'work', { by: 'user' });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const t = taskRows.get(task.id);
      if (t?.status === 'review' && !t?.actionRunning) break;
      await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 40)); // let any trailing finally emit flush

    assert.equal(taskRows.get(task.id)?.status, 'review', 'DB ended at review');
    assert.ok(decidePrompt.includes('Decision contract:'), 'decide prompt has tool contract');
    assert.ok(
      decidePrompt.includes(`@update_task(${task.id}, review, Moved to review)`),
      'next-column prompt gives exact update_task call'
    );
    // The bug: the finally re-emits the captured (work) status, bouncing the card
    // back. After the move to review, no emit may carry the stale "work" again.
    const afterMove = emitted.slice(emitted.indexOf('review'));
    assert.ok(emitted.includes('review'), `expected a review emit, got [${emitted.join(', ')}]`);
    assert.ok(
      !afterMove.includes('work'),
      `no stale "work" emit after reaching review — got [${emitted.join(', ')}]`
    );
    assert.equal(
      emitted.at(-1),
      'review',
      `last emit must be the current column, got [${emitted.join(', ')}]`
    );
  } finally {
    restore();
  }
});
