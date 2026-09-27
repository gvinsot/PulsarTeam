/**
 * AgentSelector tests
 *
 * Board and repo are *preferences* here, not filters: the selector narrows to
 * the task's board, then to its repo, but falls back to the wider pool rather
 * than returning nobody.
 *
 * Focus: when a pending run_agent action looks for an idle agent on a given
 * board+role, the selector must be willing to pick an idle agent that is
 * currently on a different repo so that the caller can repo-switch it. The
 * older implementation narrowed by project preference BEFORE the idle filter,
 * which caused tasks to stay blocked whenever the same-project agent was
 * busy even though idle agents on other repos were available.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  findAgentByRole,
  findAgentForAssignment,
  hasIdleAgentWithRole,
  reserveAgentForTask,
  acquireLock,
  releaseLock,
  hasLockForTask,
  isAgentBusy,
} from '../workflow/agentSelector.js';

function makeAgents(list: any[]): Map<string, any> {
  const m = new Map<string, any>();
  for (const a of list) m.set(a.id, a);
  return m;
}

test('findAgentByRole picks idle agent on different repo when same-repo agent is busy', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b1',
      status: 'busy',
      project: 'org/repo-target',
      enabled: true,
    },
    {
      id: 'a2',
      name: 'A2',
      role: 'dev',
      boardId: 'b1',
      status: 'idle',
      project: 'org/repo-other',
      enabled: true,
    },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target') as any;

  assert.ok(picked, 'should select the idle agent on a different repo (caller switches its repo)');
  assert.equal(picked.id, 'a2');
});

test('findAgentByRole still prefers a same-repo idle agent over different-repo idle agents', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b1',
      status: 'idle',
      project: 'org/repo-target',
      enabled: true,
    },
    {
      id: 'a2',
      name: 'A2',
      role: 'dev',
      boardId: 'b1',
      status: 'idle',
      project: 'org/repo-other',
      enabled: true,
    },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target') as any;

  assert.ok(picked);
  assert.equal(
    picked.id,
    'a1',
    'same-repo idle agent should win to avoid an unnecessary repo switch'
  );
});

test('findAgentByRole returns null when no agent matches role+board', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'qa',
      boardId: 'b1',
      status: 'idle',
      project: 'org/repo',
      enabled: true,
    },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo');
  assert.equal(picked, null);
});

test('findAgentByRole returns null when matching agents are all non-idle', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b1',
      status: 'busy',
      project: 'org/repo-target',
      enabled: true,
    },
    {
      id: 'a2',
      name: 'A2',
      role: 'dev',
      boardId: 'b1',
      status: 'busy',
      project: 'org/repo-other',
      enabled: true,
    },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target');
  assert.equal(picked, null);
});

test('findAgentByRole prefers the task board over the task repo', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b2',
      status: 'idle',
      project: 'org/repo-target',
      enabled: true,
    },
    {
      id: 'a2',
      name: 'A2',
      role: 'dev',
      boardId: 'b1',
      status: 'idle',
      project: 'org/repo-other',
      enabled: true,
    },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target') as any;

  assert.ok(picked);
  assert.equal(picked.id, 'a2', 'the board preference is applied before the repo preference');
});

// ── Board is a fence ────────────────────────────────────────────────────────
//
// A task is never handed to another board's agent, even one with the right
// role. The `idle_agent_available` condition is scoped the same way so it never
// goes green on an agent the following action would refuse.

test('findAgentByRole never picks an agent from another board', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b2',
      status: 'idle',
      project: 'org/repo-target',
      enabled: true,
    },
  ]);

  assert.equal(findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target'), null);
});

test('idle_agent_available and the selector agree on the board scope', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b2',
      status: 'idle',
      project: 'org/repo',
      enabled: true,
    },
  ]);

  assert.equal(hasIdleAgentWithRole(agents, 'dev', 'b1'), false);
  assert.equal(hasIdleAgentWithRole(agents, 'dev', 'b2'), true);
  assert.equal(findAgentByRole(agents, 'dev', null, () => [], 'b2', 'org/repo')?.id, 'a1');
});

test('findAgentByRole still returns null when no agent holds the role at all', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'qa',
      boardId: 'b2',
      status: 'idle',
      project: 'org/repo',
      enabled: true,
    },
  ]);

  assert.equal(
    findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo'),
    null
  );
});

test('findAgentForAssignment only draws from the task board', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b2',
      status: 'idle',
      project: 'org/repo',
      enabled: true,
    },
    {
      id: 'a2',
      name: 'A2',
      role: 'dev',
      boardId: 'b1',
      status: 'idle',
      project: 'org/repo',
      enabled: true,
    },
  ]);
  assert.equal(
    findAgentForAssignment(agents, 'dev', null, () => [], null, 'b1', 'org/repo')?.id,
    'a2',
    'an agent on the task board wins'
  );

  agents.delete('a2');
  assert.equal(
    findAgentForAssignment(agents, 'dev', null, () => [], null, 'b1', 'org/repo'),
    null,
    'a same-role agent on another board must never receive the task'
  );
});

test('automatic assignment excludes occupied agents before board and repo preferences', () => {
  const agents = makeAgents([
    { id: 'busy', role: 'dev', status: 'busy', boardId: 'home', project: 'org/repo' },
    { id: 'free', role: 'dev', status: 'idle', boardId: 'home', project: 'org/other' },
  ]);
  assert.equal(
    findAgentForAssignment(agents, 'dev', null, () => [], null, 'home', 'org/repo')?.id,
    'free'
  );
  agents.delete('free');
  assert.equal(findAgentForAssignment(agents, 'dev'), null);
});

test('a live reservation excludes an idle CLI from assignment and survives the stale-lock TTL', () => {
  const agents = makeAgents([{ id: 'reserved', role: 'dev', status: 'idle' }]);
  const release = reserveAgentForTask('reserved', 'task-live', 'owner:task-live:decide');
  assert.ok(release);
  try {
    assert.equal(reserveAgentForTask('reserved', 'task-other', 'owner:task-other:resume'), null);
    assert.equal(reserveAgentForTask('other-agent', 'task-live', 'owner:task-live:resume'), null);
    assert.equal(findAgentByRole(agents, 'dev'), null);
    assert.equal(findAgentForAssignment(agents, 'dev'), null);
    assert.equal(hasIdleAgentWithRole(agents, 'dev'), false);
    const later = Date.now() + 21 * 60 * 1000;
    mock.method(Date, 'now', () => later);
    const unrelated = acquireLock('unrelated'); // triggers stale-lock eviction
    releaseLock('unrelated', unrelated);
    assert.equal(hasLockForTask('owner:task-live:'), true);
    assert.equal(isAgentBusy('reserved'), true);
  } finally {
    mock.restoreAll();
    release();
  }
  const successor = reserveAgentForTask('reserved', 'task-other', 'owner:task-other:resume');
  assert.ok(successor);
  release(); // an old finally must not release its successor
  assert.equal(isAgentBusy('reserved'), true);
  successor();
  assert.equal(findAgentForAssignment(agents, 'dev')?.id, 'reserved');
});

test('findAgentForAssignment still respects the owner scope', () => {
  const agents = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b2',
      status: 'idle',
      project: 'org/repo',
      enabled: true,
      ownerId: 'u2',
    },
  ]);

  assert.equal(
    findAgentForAssignment(agents, 'dev', 'u1', () => [], null, 'b1', 'org/repo'),
    null
  );
  assert.equal(
    findAgentByRole(agents, 'dev', 'u1', () => [], 'b1', 'org/repo'),
    null
  );
});
