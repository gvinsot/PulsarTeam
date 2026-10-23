// A blinking cursor is not CLI activity (agentManager/cliActivity.ts).
//
// Regression: some CLI runners blink their cursor by default, so the PTY kept
// printing while the agent sat idle at its prompt and the terminal relay kept
// marking it "busy".

import test from 'node:test';
import assert from 'node:assert/strict';
import { isCursorOnlyOutput } from '../agentManager/cliActivity.js';

test('hardware cursor show/hide toggles are not activity', () => {
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b[?25l')), true);
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b[?25h\x1b[?12h')), true);
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b[2 q')), true); // DECSCUSR cursor style
  assert.equal(isCursorOnlyOutput(Buffer.from('')), true);
});

test('a software cursor glyph redrawn in place is not activity', () => {
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b7\x1b[12;5H\x1b[7m \x1b[0m\x1b8')), true);
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b[12;5H█')), true);
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b[12;5H\x1b[38;5;245m▌\x1b[39m')), true);
  assert.equal(isCursorOnlyOutput('\x1b]0;title\x07\x1b[3;1H '), true);
  assert.equal(isCursorOnlyOutput([Buffer.from('\x1b[12;5'), Buffer.from('H█')]), true);
});

test('real output is still activity', () => {
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b[12;5Hx')), false);
  assert.equal(isCursorOnlyOutput(Buffer.from('⠋ Thinking…')), false);
  assert.equal(isCursorOnlyOutput(Buffer.from('\x1b[2K\rRunning tests')), false);
  assert.equal(isCursorOnlyOutput(Buffer.from('███')), false); // a progress bar, not a cursor
});
