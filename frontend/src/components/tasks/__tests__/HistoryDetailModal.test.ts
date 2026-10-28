import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HistoryDetailModal from '../HistoryDetailModal.js';
import type { TaskHistoryEntry } from '../../../types/task.js';
import { LanguageProvider } from '../../../contexts/LanguageContext.js';

function render(entry: Partial<TaskHistoryEntry>) {
  return renderToStaticMarkup(
    createElement(LanguageProvider, {
      children: createElement(HistoryDetailModal, {
        entry: {
          type: 'execution',
          at: '2026-09-16T10:00:00Z',
          by: 'Developer',
          mode: 'decide',
          ...entry,
        },
        onClose: () => {},
      }),
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

test('decision audit displays confidence and escapes model-selected column labels', () => {
  const html = render({
    type: 'decision',
    llmConfigId: 'd3-mini',
    choice: '<script>billing</script>',
    target: 'review',
    confidence: 0.4,
    threshold: 0.6,
    fallback: true,
  });
  assert.ok(html.includes('d3-mini'));
  assert.ok(html.includes('0.400'));
  assert.ok(html.includes('review'));
  assert.ok(html.includes('&lt;script&gt;billing&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
});
