import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { __setUserDirectoryForTests, resolveDisplayName } from '../useUserDisplayName';
import TaskCard from '../../components/tasks/TaskCard';

test('resolveDisplayName maps known usernames and passes unknown names through', () => {
  const map = new Map([['jdoe@example.com', 'Jane Doe']]);
  assert.equal(resolveDisplayName(map, 'jdoe@example.com'), 'Jane Doe');
  assert.equal(resolveDisplayName(map, 'Some Agent'), 'Some Agent');
  assert.equal(resolveDisplayName(map, null), '');
});

test('TaskCard shows the creator display name instead of the username', () => {
  __setUserDirectoryForTests({ 'jdoe@example.com': 'Jane Doe' });
  const html = renderToStaticMarkup(
    createElement(TaskCard, {
      task: {
        id: 't',
        title: 'Task',
        createdAt: '2026-09-01T12:00:00.000Z',
        source: { type: 'user', name: 'jdoe@example.com' },
      },
      onDelete() {},
      onStop() {},
      onOpen() {},
      showCreator: true,
    } as never)
  );
  assert.match(html, /Jane Doe/);
  assert.doesNotMatch(html, /jdoe@example\.com/);
});
