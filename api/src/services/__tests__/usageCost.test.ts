import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';
import { sameModelId } from '../agentManager/index.js';

// CLI runners report the model each turn actually ran on, read from the CLI's
// own transcripts. Pricing has to follow it: a Claude Code agent configured on
// Opus that spends a turn on Haiku must not be billed at the Opus rate.

function managerWith(configs: any[]) {
  const manager = new AgentManager(
    { emit() {}, to: () => ({ emit() {} }) },
    null,
    null,
    null
  ) as any;
  for (const config of configs) manager.llmConfigs.set(config.id, config);
  return manager;
}

const opus = {
  id: 'opus',
  name: 'Opus',
  provider: 'anthropic',
  model: 'claude-opus-4-5',
  costPerInputToken: 5,
  costPerOutputToken: 25,
};
const haiku = {
  id: 'haiku',
  name: 'Haiku',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  costPerInputToken: 1,
  costPerOutputToken: 5,
};
const agent = { id: 'a1', name: 'Coder', llmConfigId: 'opus' };

test('a reported model with a priced config is billed at that config’s rate', () => {
  const manager = managerWith([opus, haiku]);
  assert.equal(manager._resolveUsageCost(agent, 1e6, 1e6, 'claude-haiku-4-5-20251001'), 6);
});

test('the agent’s own rate applies when the reported model is the configured one', () => {
  const manager = managerWith([opus, { ...opus, id: 'opus-other', costPerInputToken: 99 }]);
  assert.equal(manager._resolveUsageCost(agent, 1e6, 1e6, 'claude-opus-4-5'), 30);
});

test('an unpriced reported model falls back to the agent’s rate', () => {
  const manager = managerWith([opus, haiku]);
  assert.equal(manager._resolveUsageCost(agent, 1e6, 1e6, 'gpt-5-codex'), 30);
  assert.equal(manager._resolveUsageCost(agent, 1e6, 1e6), 30);
});

test('model ids match across provider prefix, context tag, date snapshot and case', () => {
  assert.ok(sameModelId('claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'));
  assert.ok(sameModelId('anthropic/Claude-Opus-4-1[1m]', 'claude-opus-4-1'));
  assert.ok(sameModelId('gpt-5-codex', 'openai/gpt-5-codex'));
  assert.ok(!sameModelId('claude-opus-4-5', 'claude-opus-4-1'));
  assert.ok(!sameModelId('', ''));
  assert.ok(!sameModelId(undefined, 'claude-opus-4-5'));
});
