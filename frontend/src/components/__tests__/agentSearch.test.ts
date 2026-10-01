import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterAgents } from '../agentSearch.ts';

const agent = (name: string, role = '', description = '', currentTask: string | null = null) =>
  ({ name, role, description, currentTask }) as any;

const dev = agent('Claude #3', 'Développeur', 'Writes frontend code');
const qa = agent('Tester', 'qa', '', 'Reviewing login flow');
const lead = agent('Boss', 'Swarm Leaders', 'Coordinates the team');
const list = [dev, qa, lead];

test('blank query keeps every agent (same array)', () => {
  assert.equal(filterAgents(list, ''), list);
  assert.equal(filterAgents(list, '   '), list);
});

test('matches name case-insensitively', () => {
  assert.deepEqual(filterAgents(list, 'claude'), [dev]);
});

test('matches role, description and current task', () => {
  assert.deepEqual(filterAgents(list, 'swarm'), [lead]);
  assert.deepEqual(filterAgents(list, 'frontend'), [dev]);
  assert.deepEqual(filterAgents(list, 'login'), [qa]);
});

test('ignores diacritics in both query and fields', () => {
  assert.deepEqual(filterAgents(list, 'developpeur'), [dev]);
  assert.deepEqual(filterAgents(list, 'DÉVE'), [dev]);
});

test('all terms must match, across fields', () => {
  assert.deepEqual(filterAgents(list, 'boss team'), [lead]);
  assert.deepEqual(filterAgents(list, 'boss frontend'), []);
});

test('tolerates missing fields', () => {
  assert.deepEqual(filterAgents([{ name: undefined } as any], 'x'), []);
});
