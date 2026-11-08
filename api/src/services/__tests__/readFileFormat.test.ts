// read_file output format (ADR sandbox agentic loop, P6): `cat -n` numbering,
// consistent with start_line, and a truncation marker naming the next range.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReadFile, splitLines } from '../readFileFormat.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('full read is numbered like cat -n', () => {
  const r = formatReadFile('alpha\n\tbeta\n', undefined, undefined);
  assert.equal(r.text, '     1\talpha\n     2\t\tbeta');
  assert.equal(r.totalLines, 2);
  assert.equal(r.truncated, false);
});

test('range read numbers lines from start_line', () => {
  const r = formatReadFile(lines(20), '5', '7');
  assert.equal(r.text, '     5\tline 5\n     6\tline 6\n     7\tline 7');
  assert.equal(r.startLine, 5);
  assert.equal(r.endLine, 7);
  assert.equal(r.totalLines, 20);
});

test('range read without end_line goes to EOF; past EOF is reported', () => {
  assert.equal(formatReadFile(lines(3), '3').text, '     3\tline 3');
  assert.match(formatReadFile(lines(3), '10').text, /past the end of the file \(3 lines\)/);
});

test('large file is truncated with a marker giving the next start_line', () => {
  const r = formatReadFile(lines(1200), undefined, undefined);
  const out = r.text.split('\n');
  assert.equal(out[0], '     1\tline 1');
  assert.equal(out[499], '   500\tline 500');
  assert.ok(!r.text.includes('line 501\n'));
  assert.match(r.text, /TRUNCATED: showing lines 1-500 of 1200/);
  assert.match(r.text, /start_line=501/);
  assert.equal(r.truncated, true);
});

test('trailing newline does not create an extra line; empty file has none', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.equal(formatReadFile('').text, '');
});
