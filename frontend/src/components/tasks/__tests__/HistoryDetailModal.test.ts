import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HistoryDetailModal from '../HistoryDetailModal.js';
import type { TaskHistoryEntry } from '../../../types/task.js';

function render(entry: Partial<TaskHistoryEntry>) {
  return renderToStaticMarkup(
    createElement(HistoryDetailModal, {
      entry: {
        type: 'execution',
        at: '2026-09-16T10:00:00Z',
        by: 'Developer',
        mode: 'decide',
        ...entry,
      },
      onClose: () => {},
    })
  );
}

test('execution details display escaped CLI output instead of the empty conversation placeholder', () => {
  const html = render({ messages: [], terminalOutput: 'Tests passed\n<script>untrusted</script>' });
  assert.ok(html.includes('Latest CLI output'));
  assert.ok(html.includes('Tests passed\n&lt;script&gt;untrusted&lt;/script&gt;'));
  assert.ok(!html.includes('No conversation recorded.'));
});

test('execution details display the agent completion note', () => {
  const html = render({ messages: [{ role: 'assistant', content: 'Fix committed and pushed.' }] });
  assert.ok(html.includes('Fix committed and pushed.'));
  assert.ok(!html.includes('No conversation recorded.'));
});

test('historical empty execution records remain supported', () => {
  assert.ok(render({ messages: [] }).includes('No conversation recorded.'));
});
