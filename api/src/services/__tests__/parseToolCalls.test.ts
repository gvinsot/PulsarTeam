/**
 * parseToolCalls tests
 *
 * Locks in the parser's recovery of malformed tool calls that used to be
 * silently dropped. A dropped call executes nothing, so no continuation fires
 * and a decide/execute loop stalls until it errors out with
 * "produced no @update_task call after N attempts" — observed in QA when a
 * "Software Architect" agent emitted `@write_file(path, """…` / `@read_file(…`
 * with no reachable closing ')'.
 *
 * Two recovered shapes:
 *   1. A single-line call missing its ')' (agent forgot it).
 *   2. A multi-line `"""` block left unterminated (long/truncated @write_file).
 *
 * Plus regressions: well-formed calls and the pre-existing unbalanced-paren
 * fallback (an emoticon in a comment) must keep parsing as before.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseToolCalls } from '../agentTools.js';

test('recovers @read_file with a missing closing paren (whole response)', () => {
  const calls = parseToolCalls('@read_file(docs/functional/product_vision_and_actors_spec.md');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].args[0], 'docs/functional/product_vision_and_actors_spec.md');
});

test('recovers @run_command with a missing closing paren', () => {
  const calls = parseToolCalls('@run_command(git branch -a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'run_command');
  assert.equal(calls[0].args[0], 'git branch -a');
});

test('a missing-paren call closes at end of line, not end of response', () => {
  // The forgotten ')' must not swallow following prose/lines.
  const calls = parseToolCalls('@read_file(src/index.js\nSome trailing explanation here.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].args[0], 'src/index.js');
});

test('recovers @write_file with an unterminated """ block (consumes multi-line content)', () => {
  const content = '# Spécification Technique\n\nSection avec une parenthèse (déséquilibrée\nligne finale';
  const calls = parseToolCalls(`@write_file(docs/technical/01-system-architecture.md, """\n${content}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'write_file');
  assert.equal(calls[0].args[0], 'docs/technical/01-system-architecture.md');
  // Opening fence + leading newline stripped; the full body is preserved.
  assert.equal(calls[0].args[1], content);
});

test('regression: well-formed @write_file(path, """content""") still parses', () => {
  const calls = parseToolCalls('@write_file(src/utils/helper.js, """hello world""")');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'write_file');
  assert.equal(calls[0].args[0], 'src/utils/helper.js');
  assert.equal(calls[0].args[1], 'hello world');
});

test('regression: well-formed @read_file with line range still parses', () => {
  const calls = parseToolCalls('@read_file(src/index.js, 10, 25)');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['src/index.js', '10', '25']);
});

test('regression: unbalanced-paren emoticon in a comment uses the last-paren fallback', () => {
  const calls = parseToolCalls('@update_task(abc-123, done, all good :()');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'update_task');
  assert.equal(calls[0].args[0], 'abc-123');
  assert.equal(calls[0].args[1], 'done');
  assert.equal(calls[0].args[2], 'all good :(');
});

test('a well-formed call followed by an unterminated write both parse', () => {
  const resp = [
    '@read_file(src/a.js)',
    '@write_file(docs/b.md, """',
    '# Titre',
    'contenu tronqué',
  ].join('\n');
  const calls = parseToolCalls(resp);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].args[0], 'src/a.js');
  assert.equal(calls[1].tool, 'write_file');
  assert.equal(calls[1].args[0], 'docs/b.md');
  assert.equal(calls[1].args[1], '# Titre\ncontenu tronqué');
});

test('a plain response with no tool call yields nothing', () => {
  assert.equal(parseToolCalls('Just some prose about the architecture.').length, 0);
});
