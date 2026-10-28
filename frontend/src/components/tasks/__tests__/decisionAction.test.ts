import test from 'node:test';
import assert from 'node:assert/strict';
import { validDecisionAction } from '../decisionAction.ts';
import { isChatModel, isDecisionModel } from '../../../utils/llmConfig.ts';
import type { WorkflowActionDecision } from '../../../types/board.ts';

const columns = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];
const action: WorkflowActionDecision = {
  type: 'decision_model',
  llmConfigId: 'model',
  instructions: 'Choose a team',
  minConfidence: 0.6,
  routes: [
    { target: 'a', description: 'Payments' },
    { target: 'b', description: 'Bugs' },
  ],
};
test('decision actions round trip and reject incomplete, duplicate or deleted destinations', () => {
  assert.equal(validDecisionAction(JSON.parse(JSON.stringify(action)), columns), true);
  for (const changes of [
    { llmConfigId: '' },
    { instructions: ' ' },
    { minConfidence: NaN },
    { minConfidence: 2 },
    { fallbackTarget: 'deleted' },
    { routes: [action.routes[0], action.routes[0]] },
    { routes: [{ target: 'a', description: '' }, action.routes[1]] },
  ]) {
    assert.equal(validDecisionAction({ ...action, ...changes }, columns), false);
  }
  assert.equal(validDecisionAction(action, columns.slice(0, 1)), false);
  assert.equal(validDecisionAction({ type: 'change_status', target: '__next__' }, columns), true);
});
test('decision models are available for decisions and excluded from chat', () => {
  assert.equal(isDecisionModel({ provider: 'decision' }), true);
  assert.equal(isChatModel({ provider: 'decision' }), false);
  assert.equal(isChatModel({ provider: 'vllm', model: 'd3-mini' }), true);
  assert.equal(isDecisionModel({ provider: 'openai' }), false);
});
