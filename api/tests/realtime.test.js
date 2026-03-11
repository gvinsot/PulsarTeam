import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRealtimeSessionConfig,
  DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  VOICE_TOOLS,
} from '../src/routes/realtime.js';

test('buildRealtimeSessionConfig enables automatic speech turn handling and transcription', () => {
  const session = buildRealtimeSessionConfig({
    instructions: 'Talk naturally.',
    voice: 'alloy',
    model: 'gpt-realtime-1.5',
  });

  assert.equal(session.type, 'realtime');
  assert.equal(session.model, 'gpt-realtime-1.5');
  assert.equal(session.instructions, 'Talk naturally.');
  assert.equal(session.audio.output.voice, 'alloy');
  assert.equal(session.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(session.audio.input.turn_detection.create_response, true);
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(session.audio.input.transcription.model, DEFAULT_REALTIME_TRANSCRIPTION_MODEL);
  assert.equal(session.tools, VOICE_TOOLS);
});

test('buildRealtimeSessionConfig allows a custom transcription model', () => {
  const session = buildRealtimeSessionConfig({
    transcriptionModel: 'custom-transcriber',
  });

  assert.equal(session.audio.input.transcription.model, 'custom-transcriber');
});