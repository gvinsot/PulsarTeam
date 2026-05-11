/**
 * AgentSelector tests
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

import { findAgentByRole } from '../workflow/agentSelector.js';

function makeAgents(list: any[]): Map<string, any> {
  const m = new Map<string, any>();
  for (const a of list) m.set(a.id, a);
  return m;
}

test('findAgentByRole picks idle agent on different repo when same-repo agent is busy', () => {
  const agents = makeAgents([
    { id: 'a1', name: 'A1', role: 'dev', boardId: 'b1', status: 'busy',  project: 'org/repo-target', enabled: true },
    { id: 'a2', name: 'A2', role: 'dev', boardId: 'b1', status: 'idle',  project: 'org/repo-other',  enabled: true },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target') as any;

  assert.ok(picked, 'should select the idle agent on a different repo (caller switches its repo)');
  assert.equal(picked.id, 'a2');
});

test('findAgentByRole still prefers a same-repo idle agent over different-repo idle agents', () => {
  const agents = makeAgents([
    { id: 'a1', name: 'A1', role: 'dev', boardId: 'b1', status: 'idle', project: 'org/repo-target', enabled: true },
    { id: 'a2', name: 'A2', role: 'dev', boardId: 'b1', status: 'idle', project: 'org/repo-other',  enabled: true },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target') as any;

  assert.ok(picked);
  assert.equal(picked.id, 'a1', 'same-repo idle agent should win to avoid an unnecessary repo switch');
});

test('findAgentByRole returns null when no agent matches role+board', () => {
  const agents = makeAgents([
    { id: 'a1', name: 'A1', role: 'qa', boardId: 'b1', status: 'idle', project: 'org/repo', enabled: true },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo');
  assert.equal(picked, null);
});

test('findAgentByRole returns null when matching agents are all non-idle', () => {
  const agents = makeAgents([
    { id: 'a1', name: 'A1', role: 'dev', boardId: 'b1', status: 'busy', project: 'org/repo-target', enabled: true },
    { id: 'a2', name: 'A2', role: 'dev', boardId: 'b1', status: 'busy', project: 'org/repo-other',  enabled: true },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target');
  assert.equal(picked, null);
});

test('findAgentByRole honours boardId filter', () => {
  const agents = makeAgents([
    { id: 'a1', name: 'A1', role: 'dev', boardId: 'b2', status: 'idle', project: 'org/repo-target', enabled: true },
    { id: 'a2', name: 'A2', role: 'dev', boardId: 'b1', status: 'idle', project: 'org/repo-other',  enabled: true },
  ]);

  const picked = findAgentByRole(agents, 'dev', null, () => [], 'b1', 'org/repo-target') as any;

  assert.ok(picked);
  assert.equal(picked.id, 'a2', 'a1 lives on a different board and must be excluded even though it is on the right repo');
});
