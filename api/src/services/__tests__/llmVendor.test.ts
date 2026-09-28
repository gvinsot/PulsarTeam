import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageLabel, vendorFor } from '../llmVendor.js';

test('vendorFor maps runners and provider types to vendors', () => {
  assert.equal(vendorFor('claudecode'), 'Anthropic');
  assert.equal(vendorFor('coder'), 'Anthropic');
  assert.equal(vendorFor('claude-paid'), 'Anthropic');
  assert.equal(vendorFor('codex'), 'OpenAI');
  assert.equal(vendorFor('openai'), 'OpenAI');
  assert.equal(vendorFor('github-copilot'), 'Copilot');
  assert.equal(vendorFor('unknown'), null);
  assert.equal(vendorFor(null), null);
});

test('usageLabel prefers a known model', () => {
  assert.equal(usageLabel({ provider: 'claudecode', model: 'claude-opus-5-5' }), 'claude-opus-5-5');
});

test('usageLabel falls back to the vendor when the model is unknown', () => {
  assert.equal(usageLabel({ provider: 'claudecode', model: 'unknown' }), 'Anthropic');
  assert.equal(usageLabel({ provider: 'codex', model: '' }), 'OpenAI');
  assert.equal(usageLabel({ provider: 'copilot', model: null }), 'Copilot');
  assert.equal(
    usageLabel({ provider: 'custom', model: 'unknown', displayName: 'My Claude Max' }),
    'Anthropic'
  );
});

test('usageLabel falls back to provider names, then Unknown', () => {
  assert.equal(
    usageLabel({ provider: 'acme', model: 'unknown', displayName: 'Acme LLM' }),
    'Acme LLM'
  );
  assert.equal(usageLabel({ provider: 'acme', model: 'unknown' }), 'acme');
  assert.equal(usageLabel({ provider: 'unknown', model: 'unknown' }), 'Unknown');
});
