import test from 'node:test';
import assert from 'node:assert/strict';
import { chatWindowStart, terminalTail, CHAT_WINDOW_SIZE } from '../chatWindow.js';

test('chatWindowStart renders only the most recent messages', () => {
  assert.equal(chatWindowStart(10, CHAT_WINDOW_SIZE), 0);
  assert.equal(chatWindowStart(500, 60), 440);
  assert.equal(chatWindowStart(500, 1000), 0);
  assert.equal(chatWindowStart(5, -1), 5);
});

test('terminalTail keeps short output and trims long output on a line boundary', () => {
  assert.equal(terminalTail('abc'), 'abc');
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const tail = terminalTail(text, 50);
  assert.ok(tail.length <= 50);
  assert.ok(tail.endsWith('line 99'));
  assert.ok(tail.startsWith('line '));
});
