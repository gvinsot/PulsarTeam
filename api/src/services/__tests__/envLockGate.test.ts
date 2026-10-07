/**
 * The task loop waits for the instance's environment.
 *
 * Without APP_ENVIRONMENT the environment is only known after the first public
 * request; until then getCurrentEnvironment() answers the 'prod' default. A QA
 * replica sharing the database used to run its boot recovery and its workflow
 * ticks as 'prod' — clearing prod's live run flags and executing prod's tasks.
 * Runs in its own process (one file), so the environment starts unlocked.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeTaskDbFake } from './helpers/taskDbFake.js';

delete process.env.APP_ENVIRONMENT;
const realDb = await import('../database.js');
const { exports: taskDbFake } = makeTaskDbFake();
const resumeQueries: Array<string | null> = [];
const cleanups: Array<string | null> = [];
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    ...taskDbFake,
    getTasksForResume: async (env: string | null) => {
      resumeQueries.push(env);
      return [];
    },
    clearAllStaleActionRunning: async (env: string | null) => {
      cleanups.push(env);
      return 0;
    },
    getRecurringTasks: async () => {
      throw new Error('the scheduler must not run before the environment is known');
    },
  },
});

const { AgentManager } = await import('../agentManager.js');
const { setCurrentEnvironmentFromHost, isEnvironmentLocked } =
  await import('../../lib/environment.js');

const mockIo = {
  emit() {},
  to() {
    return { emit() {} };
  },
};

test('nothing runs before the environment is locked, then only that environment', async () => {
  assert.equal(isEnvironmentLocked(), false);
  const mgr: any = new AgentManager(mockIo, null, null, null);
  mgr._loopProcessing = new Set();
  const rechecks = mock.method(mgr, '_recheckConditionalTransitions', () => {});

  mgr._processNextPendingTasks();
  await mgr._processRecurringTasks();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rechecks.mock.callCount(), 0, 'no workflow recheck');
  assert.deepEqual(resumeQueries, [], 'no resume');
  assert.deepEqual(cleanups, [], 'no boot cleanup under a guessed environment');

  setCurrentEnvironmentFromHost('qa.pulsar.example');
  mgr._processNextPendingTasks();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rechecks.mock.callCount(), 1);
  assert.deepEqual(resumeQueries, ['qa']);
  assert.deepEqual(cleanups, ['qa'], 'boot cleanup runs once, for the locked environment');
});
