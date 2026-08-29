import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRunnerService,
  runnerServiceUrlFor,
  runnerServiceUrl,
} from '../execution/runnerRegistry.js';
import { isCliRunner, CLI_RUNNER_IDS } from '../runners.js';

// ─── CLI-runner single-source-of-truth: alias + casing resolution ───────────
// Regression coverage for the migration that removed the hand-rolled runner
// tables in chat.ts / llmProviders.ts / terminal.ts. The deprecated 'coder'
// alias and legacy casing must resolve to the claudecode runner service.

test('resolveRunnerService maps the deprecated coder alias to claudecode', () => {
  assert.equal(resolveRunnerService('coder'), 'claudecode');
});

test('resolveRunnerService lowercases legacy casing', () => {
  assert.equal(resolveRunnerService('ClaudeCode'), 'claudecode');
  assert.equal(resolveRunnerService('CODER'), 'claudecode');
});

test('resolveRunnerService passes through canonical CLI runner ids', () => {
  for (const id of CLI_RUNNER_IDS) {
    // Every CLI runner id resolves to a real runner-service entry.
    assert.ok(resolveRunnerService(id), `expected a service for '${id}'`);
  }
});

test('resolveRunnerService returns undefined for non-runner providers', () => {
  assert.equal(resolveRunnerService('openai'), undefined);
  assert.equal(resolveRunnerService(''), undefined);
});

test('runnerServiceUrlFor resolves the coder alias and honours CODER_SERVICE_URL', () => {
  const prev = process.env.CODER_SERVICE_URL;
  const prevCc = process.env.CLAUDECODE_SERVICE_URL;
  try {
    delete process.env.CLAUDECODE_SERVICE_URL;
    process.env.CODER_SERVICE_URL = 'http://legacy-coder:9000';
    // The legacy 'coder' runner resolves to claudecode and picks up the
    // legacy CODER_SERVICE_URL fallback that runnerServiceUrl('claudecode') honours.
    assert.equal(runnerServiceUrlFor('coder'), 'http://legacy-coder:9000');
    assert.equal(runnerServiceUrlFor('coder'), runnerServiceUrl('claudecode'));
  } finally {
    if (prev === undefined) delete process.env.CODER_SERVICE_URL;
    else process.env.CODER_SERVICE_URL = prev;
    if (prevCc === undefined) delete process.env.CLAUDECODE_SERVICE_URL;
    else process.env.CLAUDECODE_SERVICE_URL = prevCc;
  }
});

test('isCliRunner recognises the coder alias and mixed casing', () => {
  assert.equal(isCliRunner({ runner: 'coder' }), true);
  assert.equal(isCliRunner({ runner: 'ClaudeCode' }), true);
  assert.equal(isCliRunner({ runner: 'openai' }), false);
  assert.equal(isCliRunner({ runner: 'sandbox' }), false);
});
