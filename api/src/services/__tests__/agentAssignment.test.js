import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';

// Minimal mock io that supports .to().emit() and .emit()
function createMockIo() {
  return {
    emit() {},
    to() { return { emit() {} }; },
  };
}

test('acquireAgentLock prevents double-locking', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Worker1', role: 'developer' });

  assert.equal(manager.acquireAgentLock(agent.id, 'task-1', 'creator-1'), true);
  assert.equal(manager.isAgentLocked(agent.id), true);

  // Second lock attempt for the same agent should fail
  assert.equal(manager.acquireAgentLock(agent.id, 'task-2', 'creator-1'), false);

  // Release and re-acquire should work
  manager.releaseAgentLock(agent.id, 'task-1');
  assert.equal(manager.isAgentLocked(agent.id), false);
  assert.equal(manager.acquireAgentLock(agent.id, 'task-2', 'creator-1'), true);
});

test('releaseAgentLock with wrong taskId does not release', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Worker2', role: 'developer' });

  manager.acquireAgentLock(agent.id, 'task-1', 'creator-1');

  // Try to release with wrong task ID
  manager.releaseAgentLock(agent.id, 'task-wrong');
  assert.equal(manager.isAgentLocked(agent.id), true);

  // Release with correct task ID
  manager.releaseAgentLock(agent.id, 'task-1');
  assert.equal(manager.isAgentLocked(agent.id), false);
});

test('stale locks are evicted after timeout', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Worker3', role: 'developer' });

  // Set a very short timeout for testing
  manager.AGENT_LOCK_TIMEOUT_MS = 50;

  manager.acquireAgentLock(agent.id, 'task-1', 'creator-1');
  assert.equal(manager.isAgentLocked(agent.id), true);

  // Wait for the lock to expire
  await new Promise(resolve => setTimeout(resolve, 100));

  // isAgentLocked should evict the stale lock
  assert.equal(manager.isAgentLocked(agent.id), false);
});

test('enqueueForAgent adds tasks and avoids duplicates', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Worker4', role: 'developer' });

  manager.enqueueForAgent(agent.id, {
    task: { id: 'task-1', text: 'First task' },
    retrigger: () => {},
  });
  assert.equal(manager.getAgentQueueLength(agent.id), 1);

  // Duplicate should be skipped
  manager.enqueueForAgent(agent.id, {
    task: { id: 'task-1', text: 'First task' },
    retrigger: () => {},
  });
  assert.equal(manager.getAgentQueueLength(agent.id), 1);

  // Different task should be added
  manager.enqueueForAgent(agent.id, {
    task: { id: 'task-2', text: 'Second task' },
    retrigger: () => {},
  });
  assert.equal(manager.getAgentQueueLength(agent.id), 2);
});

test('releaseAgentLock processes next queued task', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Worker5', role: 'developer' });

  let retriggered = false;
  manager.acquireAgentLock(agent.id, 'task-1', 'creator-1');
  manager.enqueueForAgent(agent.id, {
    task: { id: 'task-2', text: 'Queued task' },
    retrigger: () => { retriggered = true; },
  });

  assert.equal(manager.getAgentQueueLength(agent.id), 1);

  // Release the lock — should trigger processing of queued task
  manager.releaseAgentLock(agent.id, 'task-1');

  // Wait for setImmediate to fire
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(retriggered, true);
  assert.equal(manager.getAgentQueueLength(agent.id), 0);
});

test('getAgentAvailability returns correct structure', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent1 = await manager.create({ name: 'Avail1', role: 'developer' });
  const agent2 = await manager.create({ name: 'Avail2', role: 'developer' });

  // Lock agent1
  manager.acquireAgentLock(agent1.id, 'task-1', 'creator-1');

  const availability = manager.getAgentAvailability();
  assert.equal(availability.length, 2);

  const a1 = availability.find(a => a.id === agent1.id);
  const a2 = availability.find(a => a.id === agent2.id);

  assert.equal(a1.locked, true);
  assert.equal(a1.available, false);
  assert.equal(a1.currentTaskId, 'task-1');
  assert.ok(a1.lockedSince);
  assert.ok(a1.lockDurationMs >= 0);

  assert.equal(a2.locked, false);
  assert.equal(a2.available, true);
  assert.equal(a2.currentTaskId, null);
  assert.equal(a2.queuedTasks, 0);
});

test('getAgentLockInfo returns lock details', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'LockInfo1', role: 'developer' });

  assert.equal(manager.getAgentLockInfo(agent.id), null);

  manager.acquireAgentLock(agent.id, 'task-42', 'creator-5');
  const info = manager.getAgentLockInfo(agent.id);

  assert.equal(info.taskId, 'task-42');
  assert.equal(info.creatorAgentId, 'creator-5');
  assert.ok(info.lockedAt);
});

test('stopAgent releases locks and clears queue', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'StopMe', role: 'developer' });

  manager.acquireAgentLock(agent.id, 'task-1', 'creator-1');
  manager.enqueueForAgent(agent.id, {
    task: { id: 'task-2', text: 'Queued task' },
    retrigger: () => {},
  });

  assert.equal(manager.isAgentLocked(agent.id), true);
  assert.equal(manager.getAgentQueueLength(agent.id), 1);

  manager.stopAgent(agent.id);

  assert.equal(manager.isAgentLocked(agent.id), false);
  assert.equal(manager.getAgentQueueLength(agent.id), 0);
});

test('getAgentStatus includes lock and queue info', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'StatusCheck', role: 'developer' });

  // Unlocked state
  let status = manager.getAgentStatus(agent.id);
  assert.equal(status.locked, false);
  assert.equal(status.lockedTaskId, null);
  assert.equal(status.queuedTasks, 0);

  // Lock and add to queue
  manager.acquireAgentLock(agent.id, 'task-1', 'creator-1');
  manager.enqueueForAgent(agent.id, {
    task: { id: 'task-2', text: 'Queued' },
    retrigger: () => {},
  });

  status = manager.getAgentStatus(agent.id);
  assert.equal(status.locked, true);
  assert.equal(status.lockedTaskId, 'task-1');
  assert.equal(status.queuedTasks, 1);
});

test('two agents with same role: second task goes to second agent', async () => {
  const io = createMockIo();
  const manager = new AgentManager(io, null, null, null);
  const agent1 = await manager.create({ name: 'Dev1', role: 'developer' });
  const agent2 = await manager.create({ name: 'Dev2', role: 'developer' });

  // Lock agent1 (simulating it executing task-1)
  manager.acquireAgentLock(agent1.id, 'task-1', 'creator-1');

  // agent1 is locked, so agent2 should be available
  assert.equal(manager.isAgentLocked(agent1.id), true);
  assert.equal(manager.isAgentLocked(agent2.id), false);

  // Lock agent2 with a different task
  assert.equal(manager.acquireAgentLock(agent2.id, 'task-2', 'creator-1'), true);

  // Both agents now locked
  assert.equal(manager.isAgentLocked(agent1.id), true);
  assert.equal(manager.isAgentLocked(agent2.id), true);

  // No agents available
  const availability = manager.getAgentAvailability();
  const available = availability.filter(a => a.available);
  assert.equal(available.length, 0);

  // Release agent1 — should become available again
  manager.releaseAgentLock(agent1.id, 'task-1');
  const availability2 = manager.getAgentAvailability();
  const available2 = availability2.filter(a => a.available);
  assert.equal(available2.length, 1);
  assert.equal(available2[0].id, agent1.id);
});
