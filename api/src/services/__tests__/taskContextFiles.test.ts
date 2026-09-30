import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContextFiles } from '../../lib/taskContextFiles.js';
import { taskContentForPrompt } from '../../lib/taskTrust.js';

test('normalizeContextFiles trims, dedupes and drops junk', () => {
  assert.deepEqual(normalizeContextFiles([' ./a.ts', 'a.ts', '', 3, 'b/c.md']), ['a.ts', 'b/c.md']);
  assert.deepEqual(normalizeContextFiles(null), []);
  assert.equal(normalizeContextFiles(Array.from({ length: 50 }, (_, i) => `f${i}`)).length, 20);
});

test('taskContentForPrompt lists context files', () => {
  const out = taskContentForPrompt({ text: 'do it', contextFiles: ['src/x.ts'] });
  assert.match(out, /- src\/x\.ts/);
  assert.doesNotMatch(taskContentForPrompt({ text: 'do it' }), /task_context_files/);
});
