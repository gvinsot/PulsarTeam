import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const projectListCalls: any[][] = [];
const projectResourceCalls: Record<string, any[][]> = {
  boards: [],
  repos: [],
  storages: [],
};
const poolQueries: Array<{ sql: string; params: any[] }> = [];

const pool = {
  query: async (sql: string, params: any[] = []) => {
    poolQueries.push({ sql, params });
    return { rows: [] };
  },
};

mock.module('../database.js', {
  namedExports: {
    getPool: () => pool,
    getAllBoards: async () => [],
    getBoardsByUser: async () => [{ id: 'board-A' }],
    getBoardById: async () => null,
    getLlmConfig: async () => null,
    rowToTask: (row: any) => row,
    getOAuthToken: () => null,
    getTaskById: async () => null,
    updateTaskExecutionStatus: async () => {},
    saveTaskToDb: async () => {},
    getProjectsForUser: async (...args: any[]) => {
      projectListCalls.push(args);
      return [{ id: 'proj-A', name: 'Project A', owner_id: 'user-A' }];
    },
    getProjectByName: async () => null,
    createProject: async () => null,
    updateProject: async () => null,
    deleteProject: async () => true,
    getBoardsForProject: async (...args: any[]) => {
      projectResourceCalls.boards.push(args);
      return [];
    },
    setBoardProject: async () => true,
    getReposForBoard: async () => [],
    getReposForProject: async (...args: any[]) => {
      projectResourceCalls.repos.push(args);
      return [];
    },
    getAccessibleBoardRepos: async () => [],
    getStoragesForBoard: async () => [],
    getStoragesForProject: async (...args: any[]) => {
      projectResourceCalls.storages.push(args);
      return [];
    },
  },
});

mock.module('../../middleware/auth.js', {
  namedExports: {
    requireRole: () => (_req: any, _res: any, next: any) => next(),
  },
});

// Authorization helpers were split out of auth.js into authz.js; routes now
// import check* from there, so they must be stubbed on the authz module.
mock.module('../../middleware/authz.js', {
  namedExports: {
    checkBoardAccess: async () => ({ ok: false, status: 403, error: 'Access denied' }),
    checkProjectAccess: async () => ({ ok: false, status: 403, error: 'Access denied' }),
  },
});

mock.module('../agentManager/tasks.js', {
  namedExports: {
    setTaskSignal: () => {},
    clearTaskSignal: () => {},
  },
});

const { projectRoutes } = await import('../../routes/projects.js');
const { default: taskRoutes } = await import('../../routes/tasks.js');

async function request(router: any, path: string) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { userId: 'user-A', role: 'basic' };
    next();
  });
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    server.close();
  }
}

test('GET /projects lists and enriches only projects accessible to the caller', async () => {
  const response = await request(projectRoutes(), '/');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    id: 'proj-A',
    name: 'Project A',
    owner_id: 'user-A',
    boardCount: 0,
    repoCount: 0,
    storageCount: 0,
  }]);
  assert.deepEqual(projectListCalls, [['user-A', 'basic']]);
  assert.deepEqual(projectResourceCalls.boards, [['proj-A', 'user-A', 'basic']]);
  assert.deepEqual(projectResourceCalls.repos, [['proj-A', 'user-A', 'basic']]);
  assert.deepEqual(projectResourceCalls.storages, [['proj-A', 'user-A', 'basic']]);
});

test('GET /tasks/project-stats filters project metadata as well as task counts', async () => {
  poolQueries.length = 0;
  const response = await request(taskRoutes, '/project-stats?days=30');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { projects: [] });

  assert.equal(poolQueries.length, 2);
  assert.match(poolQueries[0].sql, /WHERE p\.owner_id = \$2/);
  assert.match(poolQueries[0].sql, /visible_b\.project_id = p\.id AND visible_b\.id = ANY\(\$1\)/);
  assert.deepEqual(poolQueries[0].params, [['board-A'], 'user-A']);
  assert.deepEqual(poolQueries[1].params, [['board-A'], 30]);
});
