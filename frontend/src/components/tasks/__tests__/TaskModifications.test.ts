import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskModifications from '../TaskModifications';
import { groupStorageChanges } from '../storageChanges';
import type { TaskCommit, TaskStorageChange } from '../../../types';

const commit: TaskCommit = { hash: 'abcdef1234567', message: 'feat: thing', date: '2026-10-25' };

function change(overrides: Partial<TaskStorageChange> = {}): TaskStorageChange {
  return {
    provider: 'onedrive',
    action: 'created',
    path: '/Docs/report.docx',
    name: 'report.docx',
    itemId: 'item-1',
    webUrl: 'https://onedrive.example/report',
    at: '2026-10-25T10:00:00.000Z',
    count: 1,
    ...overrides,
  };
}

function render(commits: TaskCommit[], storageChanges: TaskStorageChange[]) {
  return renderToStaticMarkup(
    createElement(TaskModifications, { taskId: 't1', agentId: 'a1', commits, storageChanges })
  );
}

test('TaskModifications shows an empty state when the task changed nothing', () => {
  assert.match(render([], []), /No modifications yet/);
});

test('TaskModifications opens on the commit diffs when the task has commits', () => {
  const html = render([commit], [change()]);
  assert.match(html, /All Commits \(1\)/);
  assert.match(html, /abcdef1/);
  assert.match(html, /feat: thing/);
  assert.doesNotMatch(html, /report\.docx/);
  assert.match(html, /Drive files/);
});

test('TaskModifications lists Drive/OneDrive files when there are no commits', () => {
  const html = render(
    [],
    [
      change(),
      change({
        provider: 'gdrive',
        action: 'deleted',
        path: '/old.txt',
        itemId: 'g1',
        webUrl: null,
        count: 3,
      }),
    ]
  );
  assert.doesNotMatch(html, /All Commits/);
  assert.match(html, /OneDrive/);
  assert.match(html, /Google Drive/);
  assert.match(html, /\/Docs\/report\.docx/);
  assert.match(html, /href="https:\/\/onedrive\.example\/report"/);
  // A deleted item has no link, is struck through and shows its write count.
  assert.match(html, /line-through[^>]*>\/old\.txt/);
  assert.match(html, /×3/);
});

test('groupStorageChanges groups by provider, latest first', () => {
  const groups = groupStorageChanges([
    change({ path: '/a', at: '2026-10-25T09:00:00.000Z' }),
    change({ provider: 'gdrive', path: '/g' }),
    change({ path: '/b', at: '2026-10-25T11:00:00.000Z' }),
  ]);
  assert.deepEqual(
    groups.map(g => [g.provider, g.items.map(i => i.path)]),
    [
      ['onedrive', ['/b', '/a']],
      ['gdrive', ['/g']],
    ]
  );
});
