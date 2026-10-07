import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatMessage from '../ChatMessage.js';
import type { ConversationMessage } from '../../../types/agent.js';

function render(message: Partial<ConversationMessage>) {
  return renderToStaticMarkup(
    createElement(ChatMessage, {
      message: { role: 'assistant', content: '', timestamp: '2026-10-08T10:00:00Z', ...message },
      index: 0,
      isLast: true,
    })
  );
}

test('completed sandbox messages keep the transcript instead of the tool-only placeholder', () => {
  const html = render({
    content: '(used tools: read_file)',
    displayContent: '✓ read_file\nFile inspected.',
    thinking: 'Checking <script>untrusted</script>',
  });
  assert.ok(html.includes('File inspected.'));
  assert.ok(html.includes('✓ read_file'));
  assert.ok(!html.includes('(used tools:'));
  assert.ok(html.includes('Checking &lt;script&gt;untrusted&lt;/script&gt;'));
});

test('existing messages and final model responses remain visible', () => {
  assert.ok(render({ content: 'Existing answer' }).includes('Existing answer'));
  assert.ok(
    render({ content: 'Answer', displayContent: '✓ read_file\nAnswer' }).includes('Answer')
  );
});

test('reasoning-only responses remain accessible after completion', () => {
  const html = render({ content: '(no response)', thinking: 'Provider reasoning' });
  assert.ok(html.includes('Provider reasoning'));
  assert.match(html, /<details[^>]* open=""/);
});
