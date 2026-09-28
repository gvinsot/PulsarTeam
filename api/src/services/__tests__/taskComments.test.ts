import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskComment,
  normalizeComments,
  splitLegacyComments,
  MAX_COMMENT_LENGTH,
} from '../../lib/taskComments.js';
import {
  taskContentForPrompt,
  commentsForPrompt,
  listingTaskComments,
} from '../../lib/taskTrust.js';
import { recordTaskComment } from '../../lib/taskComments.js';

test('createTaskComment trims, caps and rejects blank bodies', () => {
  assert.equal(createTaskComment({ author: 'a', authorType: 'user', text: '   ' }), null);
  const c = createTaskComment({ author: 'Dev', authorType: 'agent', text: '  hello  ' })!;
  assert.equal(c.text, 'hello');
  assert.equal(c.author, 'Dev');
  assert.equal(c.authorType, 'agent');
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(c.at)));
  const long = createTaskComment({ author: 'x', authorType: 'user', text: 'a'.repeat(30000) })!;
  assert.equal(long.text.length, MAX_COMMENT_LENGTH);
});

test('normalizeComments drops malformed entries', () => {
  assert.deepEqual(normalizeComments(null), []);
  assert.deepEqual(normalizeComments('x'), []);
  const ok = { id: '1', text: 't', author: 'a', authorType: 'user', at: 'now' };
  assert.deepEqual(normalizeComments([ok, { text: 'no id' }, null]), [ok]);
});

test('splitLegacyComments moves appended notes out of the description', () => {
  const text =
    'Fix the login bug\n\nSteps:\n---\nnot a note' +
    '\n\n---\n**[CLAUDE #2]** Fixed in abc123' +
    '\n\n---\n**[Reviewer]** Looks good\n\nmultiline';
  const history = [
    {
      type: 'edit',
      field: 'text',
      newValue: '**[CLAUDE #2]** Fixed in abc123',
      at: '2026-01-01T10:00:00.000Z',
    },
  ];
  const r = splitLegacyComments(text, history, '2026-02-02T00:00:00.000Z');
  assert.equal(r.text, 'Fix the login bug\n\nSteps:\n---\nnot a note');
  assert.equal(r.comments.length, 2);
  assert.equal(r.comments[0].author, 'CLAUDE #2');
  assert.equal(r.comments[0].text, 'Fixed in abc123');
  assert.equal(r.comments[0].at, '2026-01-01T10:00:00.000Z');
  assert.equal(r.comments[1].author, 'Reviewer');
  assert.equal(r.comments[1].text, 'Looks good\n\nmultiline');
  assert.equal(r.comments[1].at, '2026-02-02T00:00:00.000Z');
});

test('splitLegacyComments leaves a plain description untouched', () => {
  const text = 'Title\n\n---\nA horizontal rule, not a note';
  assert.deepEqual(splitLegacyComments(text, [], 'x'), { text, comments: [] });
});

test('recordTaskComment appends to comments, never to the description', () => {
  const task: any = { id: 't', text: 'Do the thing', status: 'execute', history: [] };
  const c = recordTaskComment(task, { author: 'Dev', authorType: 'agent', text: 'Done' })!;
  assert.equal(task.text, 'Do the thing');
  assert.deepEqual(task.comments, [c]);
  assert.equal(task.history.length, 1);
  assert.equal(task.history[0].type, 'comment');
  assert.equal(task.history[0].commentId, c.id);
  assert.equal(recordTaskComment(task, { author: 'Dev', authorType: 'agent', text: ' ' }), null);
  assert.equal(task.comments.length, 1);
});

test('taskContentForPrompt keeps description and comments in separate blocks', () => {
  const task: any = {
    text: 'Build it',
    comments: [
      {
        id: '1',
        author: 'Alice',
        authorType: 'user',
        text: 'Please add tests',
        at: '2026-01-01T10:00:00Z',
      },
    ],
  };
  const prompt = taskContentForPrompt(task);
  assert.match(prompt, /<task_content_[0-9a-f]+>\nBuild it\n<\/task_content_/);
  assert.match(prompt, /Comments on this task/);
  assert.match(
    prompt,
    /<task_comments_[0-9a-f]+>\n\[2026-01-01 10:00\] Alice \(user\):\nPlease add tests/
  );
  assert.equal(commentsForPrompt([]), '');
  assert.doesNotMatch(taskContentForPrompt({ text: 'x' } as any), /Comments on this task/);
});

test('commentsForPrompt keeps only the most recent comments', () => {
  const comments = Array.from({ length: 25 }, (_, i) => ({
    id: String(i),
    author: 'a',
    authorType: 'agent' as const,
    text: `c${i}`,
    at: '2026-01-01T00:00:00Z',
  }));
  const out = commentsForPrompt(comments);
  assert.match(out, /5 older omitted/);
  assert.doesNotMatch(out, /\nc4\n/);
  assert.match(out, /\nc24/);
});

test('listingTaskComments withholds comments of external tasks', () => {
  const comments = [{ id: '1', author: 'a', authorType: 'user', text: 't', at: 'x' }];
  assert.deepEqual(listingTaskComments({ comments } as any), comments);
  assert.deepEqual(listingTaskComments({ comments, trustLevel: 'approved' } as any), []);
});
