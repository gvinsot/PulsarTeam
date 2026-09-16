import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskCard from '../TaskCard';
import type { TaskSocketPayload } from '../../../types';

function renderCard(overrides: Partial<TaskSocketPayload> = {}) {
  return renderToStaticMarkup(
    createElement(TaskCard, {
      task: {
        id: 'task',
        title: 'Review this task',
        createdAt: '2026-09-01T12:00:00.000Z',
        source: { type: 'mcp' },
        ...overrides,
      },
      onDelete() {},
      onStop() {},
      onOpen() {},
      onTouchDrop() {},
    })
  );
}

test('unseen MCP/API cards show the review indicator even when metadata is hidden', () => {
  for (const type of ['mcp', 'api']) {
    assert.match(renderCard({ source: { type } }), />To review</);
  }
});

test('acknowledged tasks and tasks excluded from the board counter have no review indicator', () => {
  const excluded: Partial<TaskSocketPayload>[] = [
    { humanViewedAt: '2026-09-16T12:00:00.000Z' },
    { source: { type: 'user' }, isManual: true },
    { source: { type: 'website' }, trustLevel: 'untrusted' },
    { source: null },
    { source: undefined },
    { isTemplate: true },
    { deletedAt: '2026-09-16T12:00:00.000Z' },
  ];
  for (const task of excluded) assert.doesNotMatch(renderCard(task), />To review</);
});

test('review indicator coexists with execution, manual and external-approval states', () => {
  const html = renderCard({ status: 'error', isManual: true, trustLevel: 'untrusted' });
  assert.match(html, />To review</);
  assert.match(html, />Manual</);
  assert.match(html, />To approve/);
});
