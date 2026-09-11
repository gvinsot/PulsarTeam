import test from 'node:test';
import assert from 'node:assert/strict';
import { isRealtimeLlm, selectedVoice } from '../../utils/llmConfig.ts';

test('voice picker includes both providers and excludes text and unrelated providers', () => {
  assert.equal(isRealtimeLlm({ provider: 'openai', model: 'gpt-realtime-2' }), true);
  assert.equal(isRealtimeLlm({ provider: 'google', model: 'gemini-3.1-flash-live-preview' }), true);
  assert.equal(
    isRealtimeLlm({ provider: 'google', model: 'gemini-2.5-flash-native-audio-preview-12-2025' }),
    true
  );
  assert.equal(isRealtimeLlm({ provider: 'google', model: 'gemini-2.5-flash' }), false);
  assert.equal(isRealtimeLlm({ provider: 'openrouter', model: 'gpt-realtime-2' }), false);
  assert.equal(isRealtimeLlm(null), false);
});
test('switching provider chooses a valid voice without losing a compatible selection', () => {
  assert.equal(selectedVoice('alloy', { provider: 'google' }), 'Kore');
  assert.equal(selectedVoice('Kore', { provider: 'openai' }), 'alloy');
  assert.equal(selectedVoice('Puck', { provider: 'google' }), 'Puck');
});
