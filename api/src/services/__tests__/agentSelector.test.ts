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

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findAgentByRole,
  findAgentForAssignment,
  hasIdleAgentWithRole,
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

// ── Board is a preference, not a fence ──────────────────────────────────────
//
// The role pickers in the workflow editor offer every role the user has an
// agent for, including roles staffed only on another board. Hard-filtering on
// the board here would accept such a workflow and then silently strand its
// tasks (`idle_agent_available` goes green — hasIdleAgentWithRole is board-
// agnostic — while the action finds nobody).

test('findAgentByRole falls back to another board when the role is staffed elsewhere', () => {
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

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target') as any;

  assert.ok(
    picked,
    'a role with no agent on this board must still run rather than strand the task'
  );
  assert.equal(picked.id, 'a1');
});

test('an idle agent that makes the condition green is reachable by the action', () => {
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

  assert.equal(hasIdleAgentWithRole(agents, 'dev'), true);
  assert.ok(
    findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo'),
    'condition and selection must agree'
  );
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

test('findAgentForAssignment prefers the task board but falls back to another one', () => {
  const onBoard = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b2',
      status: 'busy',
      project: 'org/repo',
      enabled: true,
    },
    {
      id: 'a2',
      name: 'A2',
      role: 'dev',
      boardId: 'b1',
      status: 'busy',
      project: 'org/repo',
      enabled: true,
    },
  ]);
  const picked = findAgentForAssignment(
    onBoard,
    'dev',
    null,
    () => [],
    null,
    'b1',
    'org/repo'
  ) as any;
  assert.equal(picked.id, 'a2', 'an agent on the task board wins');

  const offBoard = makeAgents([
    {
      id: 'a1',
      name: 'A1',
      role: 'dev',
      boardId: 'b2',
      status: 'busy',
      project: 'org/repo',
      enabled: true,
    },
  ]);
  const fallback = findAgentForAssignment(
    offBoard,
    'dev',
    null,
    () => [],
    null,
    'b1',
    'org/repo'
  ) as any;
  assert.ok(
    fallback,
    'assignment must not return null just because the role lives on another board'
  );
  assert.equal(fallback.id, 'a1');
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
