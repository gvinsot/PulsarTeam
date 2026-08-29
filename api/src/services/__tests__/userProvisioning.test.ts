import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let createdBoard: any = null;
let boardsByUser: any[] = [];
let agentsByBoard: any[] = [];

mock.module('../database.js', {
  namedExports: {
    getBoardsByUser: async () => boardsByUser,
    getAgentsByBoard: async () => agentsByBoard,
    createBoard: async (userId: string, name: string, workflow: any, filters: any) => {
      createdBoard = { userId, name, workflow, filters };
      return { id: 'board-default-user' };
    },
  },
});

const { provisionNewUser, setAgentManager } = await import('../userProvisioning.js');

test('provisionNewUser creates the default workflow and developer plugins', async () => {
  createdBoard = null;
  boardsByUser = [];
  agentsByBoard = [];
  let createdAgent: any = null;
  setAgentManager({
    create: async (config: any) => {
      createdAgent = config;
      return { id: 'agent-developer' };
    },
  });

  await provisionNewUser('user-new');

  assert.equal(createdBoard.userId, 'user-new');
  assert.equal(createdBoard.name, 'My board');
  assert.deepEqual(createdBoard.filters, {});

  assert.deepEqual(createdBoard.workflow.columns, [
    { id: 'todo', label: 'Todo', color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
    { id: 'done', label: 'Done', color: '#22c55e' },
  ]);
  assert.deepEqual(createdBoard.workflow.transitions, [
    {
      from: 'in_progress',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        {
          type: 'run_agent',
          mode: 'decide',
          role: '__auto__',
          instructions:
            'Execute the task fully, and when you are finished, update the task to next state.',
        },
      ],
    },
  ]);

  assert.equal(createdAgent.name, 'Developer');
  assert.equal(createdAgent.runner, 'opencode');
  assert.equal(createdAgent.boardId, 'board-default-user');
  assert.deepEqual(createdAgent.skills, ['skill-basic-tools', 'skill-web-browser']);
});

test('provisionNewUser reuses an existing personal board', async () => {
  createdBoard = null;
  boardsByUser = [{ id: 'board-existing', user_id: 'user-new', name: 'My board' }];
  agentsByBoard = [];
  let createdAgent: any = null;
  setAgentManager({
    create: async (config: any) => {
      createdAgent = config;
      return { id: 'agent-developer' };
    },
  });

  await provisionNewUser('user-new');

  assert.equal(createdBoard, null);
  assert.equal(createdAgent.boardId, 'board-existing');
});
