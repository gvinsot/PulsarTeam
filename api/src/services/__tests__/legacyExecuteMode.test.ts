/**
 * mapLegacyExecuteMode tests
 *
 * The 'execute' run_agent action mode was removed in favor of a single 'decide'
 * mode. Boards saved before the change may still carry mode:'execute' actions;
 * the engine no longer knows that mode and would skip them (unknown-mode). The
 * loader maps such actions to 'decide' so they keep running. These tests lock in
 * that mapping — and that non-execute transitions are returned untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapLegacyExecuteMode } from '../configManager.js';

test('maps a legacy run_agent execute action to decide', () => {
  const transitions = [
    { from: 'pending', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'developer', mode: 'execute', instructions: 'do it' }] },
  ];
  const out = mapLegacyExecuteMode(transitions);
  assert.equal(out[0].actions[0].mode, 'decide');
  // Other fields are preserved.
  assert.equal(out[0].actions[0].instructions, 'do it');
  assert.equal(out[0].actions[0].role, 'developer');
  assert.equal(out[0].from, 'pending');
});

test('leaves non-execute run_agent actions untouched (same reference)', () => {
  const transitions = [
    { from: 'idea', trigger: 'on_enter', actions: [{ type: 'run_agent', mode: 'refine', instructions: 'x' }] },
    { from: 'todo', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'done' }] },
  ];
  const out = mapLegacyExecuteMode(transitions);
  // Nothing to map → returns the original array reference unchanged.
  assert.equal(out, transitions);
});

test('maps only the execute actions within a mixed transition', () => {
  const transitions = [
    { from: 'pending', trigger: 'on_enter', actions: [
      { type: 'assign_agent', role: 'dev' },
      { type: 'run_agent', mode: 'execute', instructions: 'run' },
      { type: 'run_agent', mode: 'decide', instructions: 'decide' },
    ] },
  ];
  const out = mapLegacyExecuteMode(transitions);
  assert.equal(out[0].actions[0].type, 'assign_agent');
  assert.equal(out[0].actions[1].mode, 'decide');
  assert.equal(out[0].actions[2].mode, 'decide');
});

test('tolerates malformed input', () => {
  assert.equal(mapLegacyExecuteMode(null), null);
  assert.equal(mapLegacyExecuteMode(undefined), undefined);
  const noActions = [{ from: 'a', trigger: 'on_enter' }];
  assert.equal(mapLegacyExecuteMode(noActions), noActions);
});
