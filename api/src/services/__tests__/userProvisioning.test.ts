import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let createdBoard: any = null;

mock.module('../database.js', {
  namedExports: {
    createBoard: async (userId: string, name: string, workflow: any, filters: any) => {
      createdBoard = { userId, name, workflow, filters };
      return { id: 'board-default-user' };
    },
  },
});

const { provisionNewUser, setAgentManager } = await import('../userProvisioning.js');

test('provisionNewUser creates the default workflow and developer plugins', async () => {
  let createdAgent: any = null;
  setAgentManager({
    create: async (config: any) => {
      createdAgent = config;
      return { id: 'agent-developer' };
    },
  });

  await provisionNewUser('user-new');

  assert.equal(createdBoard.userId, 'user-new');
  assert.equal(createdBoard.name, 'My Board');
  assert.deepEqual(createdBoard.filters, {});

  const inProgress = createdBoard.workflow.columns.find((column: any) => column.id === 'in_progress');
  const done = createdBoard.workflow.columns.find((column: any) => column.id === 'done');
  for (const column of [inProgress, done]) {
    assert.equal(column.showAgent, true);
    assert.equal(column.showProject, true);
    assert.equal(column.showTaskType, true);
  }

  assert.equal(createdAgent.name, 'Developer');
  assert.equal(createdAgent.runner, 'opencode');
  assert.equal(createdAgent.boardId, 'board-default-user');
  assert.deepEqual(createdAgent.skills, ['skill-basic-tools', 'skill-web-browser']);
});
