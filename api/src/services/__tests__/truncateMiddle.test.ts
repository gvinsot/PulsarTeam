import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateMiddle } from '../../lib/truncateMiddle.js';
import { executeTool } from '../agentTools.js';
import { ExecutionProvider } from '../execution/executionProvider.js';
import { compactionMethods } from '../agentManager/compaction.js';

test('truncateMiddle preserves text below and exactly at the limit', () => {
  for (const text of ['', 'é漢🙂', 'x'.repeat(10000)]) {
    assert.equal(truncateMiddle(text), text);
  }
});

test('truncateMiddle preserves the head and ERROR at the end of 50k output', () => {
  const text = 'start\n' + 'x'.repeat(49989) + 'ERROR';
  assert.equal(text.length, 50000);
  const result = truncateMiddle(text);
  assert.ok(result.startsWith(text.slice(0, 3000)));
  assert.ok(result.endsWith('ERROR'));
  assert.ok(result.length <= 10000);
  assert.match(result, /\[\.\.\. \d+ chars \/ \d+ lines omitted \.\.\.\]/);
});

test('truncateMiddle reports the actual omitted character and line counts', () => {
  const text = 'first\n' + 'line\n'.repeat(100) + 'last';
  const result = truncateMiddle(text, 100, 10);
  const match = /\n\[\.\.\. (\d+) chars \/ (\d+) lines omitted \.\.\.\]\n/.exec(result);
  assert.ok(match);
  const prefix = result.slice(0, match.index);
  const suffix = result.slice(match.index + match[0].length);
  const omitted = text.slice(prefix.length, text.length - suffix.length);
  assert.equal(prefix, text.slice(0, 10));
  assert.equal(suffix, text.slice(-suffix.length));
  assert.equal(Number(match[1]), omitted.length);
  assert.equal(Number(match[2]), omitted.split('\n').length);
  assert.ok(result.length <= 100);
});

test('truncateMiddle keeps multibyte text intact at both cut boundaries', () => {
  const text = 'é漢🙂'.repeat(10000) + 'ERROR';
  for (const max of [500, 501, 502, 503]) {
    for (const head of [101, 102, 103, 104]) {
      const result = truncateMiddle(text, max, head);
      assert.ok(result.length <= max);
      assert.equal(Buffer.from(result).toString('utf8'), result);
      assert.ok(result.startsWith('é漢🙂'));
      assert.ok(result.endsWith('ERROR'));
    }
  }
});

test('truncateMiddle handles budgets too small for a marker without splitting Unicode', () => {
  assert.equal(truncateMiddle('abc🙂', 1), '');
  assert.equal(truncateMiddle('abc🙂', 2), '🙂');
  assert.equal(truncateMiddle('abc', 0), '');
  assert.throws(() => truncateMiddle('abc', -1), RangeError);
});

for (const path of [
  'direct success',
  'RTK success',
  'fallback success',
  'direct failure',
  'fallback failure',
]) {
  for (const streams of [
    { stdout: '', stderr: 'x'.repeat(49995) + 'ERROR', truncated: true },
    { stdout: 'x'.repeat(6000), stderr: 'y'.repeat(6000) + 'ERROR', truncated: true },
    { stdout: '', stderr: 'ERROR', truncated: false },
  ]) {
    test(`run_command ${path}: stdout=${streams.stdout.length}, stderr=${streams.stderr.length}`, async () => {
      const calls: string[] = [];
      const provider = new ExecutionProvider();
      provider.hasEnvironment = () => true;
      provider.getProject = () => null;
      provider.exec = async (_id, command) => {
        calls.push(command);
        if (path.startsWith('fallback') && calls.length === 1) throw new Error('RTK unavailable');
        if (path.endsWith('failure'))
          throw Object.assign(new Error('failed'), streams, { code: 1 });
        return streams;
      };
      const command = path.startsWith('direct') ? 'custom-build' : 'npm test';
      const result = await executeTool('run_command', [command], null, provider, 'agent-id');
      assert.ok(result.result);
      assert.ok(result.result.endsWith('ERROR'));
      assert.ok(result.result.length <= 10000);
      assert.equal(result.meta?.truncated, streams.truncated);
      assert.equal(calls.length, path.startsWith('fallback') ? 2 : 1);
      if (path.startsWith('fallback')) assert.deepEqual(calls, ['rtk test npm test', 'npm test']);
    });
  }
}

test('context truncation keeps tool output tails and fits the token budget', () => {
  const messages = [
    { role: 'system', content: 'System instructions' },
    { role: 'tool', content: 'START\n' + 'x'.repeat(49989) + 'ERROR' },
  ];
  assert.equal(compactionMethods._truncateMessagesToFit(messages, 2000, 1024), true);
  assert.equal(messages[0].content, 'System instructions');
  assert.ok(messages[1].content.startsWith('START'));
  assert.ok(messages[1].content.endsWith('ERROR'));
  assert.ok(compactionMethods._estimateTokens(messages) <= 2000 - 1024 - 300);
});

test('context truncation leaves fitting messages and non-tool truncation behavior unchanged', () => {
  const fitting = [{ role: 'tool', content: 'ERROR' }];
  assert.equal(compactionMethods._truncateMessagesToFit(fitting, 2000, 1024), false);
  assert.equal(fitting[0].content, 'ERROR');
  const messages = [
    { role: 'system', content: 'System instructions' },
    { role: 'user', content: 'START' + 'x'.repeat(50000) + 'END' },
  ];
  assert.equal(compactionMethods._truncateMessagesToFit(messages, 2000, 1024), true);
  assert.ok(messages[1].content.startsWith('START'));
  assert.match(messages[1].content, /truncated from .* to .* chars to fit context window/);
});
