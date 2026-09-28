// ── Task comments ───────────────────────────────────────────────────────────
//
// A task has two distinct kinds of text:
//   • `text`      — the DESCRIPTION of the work. Edited by humans (or the refine
//                   action), handed to agents as the task to perform.
//   • `comments`  — an append-only discussion thread: agent completion summaries
//                   (update_task's `comment`), human remarks, review feedback.
//
// Comments used to be appended to `text` behind a `\n\n---\n**[Author]** …`
// separator, which mixed the thread into the description (and fed it back to
// the refine action as if it were part of the spec). They now live in their own
// JSONB column; `splitLegacyComments` converts the old format once, at
// migration time.

import { randomUUID } from 'crypto';

/** Who wrote a comment. */
export type TaskCommentAuthorType = 'agent' | 'user' | 'system';

/** One entry of `task.comments`. */
export interface TaskComment {
  id: string;
  /** Display name: the agent name or the username. */
  author: string;
  authorType: TaskCommentAuthorType;
  /** Agent id or user id, when known — used to authorise deletion. */
  authorId?: string | null;
  /** Markdown body. */
  text: string;
  /** ISO 8601. */
  at: string;
}

/** Hard cap on one comment body, so a runaway agent cannot bloat the row. */
export const MAX_COMMENT_LENGTH = 20000;

/** Build a well-formed comment. Returns null when the body is blank. */
export function createTaskComment(input: {
  author: string;
  authorType: TaskCommentAuthorType;
  authorId?: string | null;
  text: string;
  at?: string;
}): TaskComment | null {
  const text = String(input.text ?? '').trim();
  if (!text) return null;
  return {
    id: randomUUID(),
    author: String(input.author || 'unknown').slice(0, 200),
    authorType: input.authorType,
    authorId: input.authorId ?? null,
    text: text.length > MAX_COMMENT_LENGTH ? text.slice(0, MAX_COMMENT_LENGTH) : text,
    at: input.at || new Date().toISOString(),
  };
}

/** Normalise whatever the column holds into a clean array. */
export function normalizeComments(value: unknown): TaskComment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c: any): c is TaskComment =>
      c && typeof c === 'object' && typeof c.id === 'string' && typeof c.text === 'string'
  );
}

// The legacy separator written by appendTaskNote: a blank line, a horizontal
// rule, then a bold bracketed author.
const LEGACY_SEPARATOR = /\n\n---\n(?=\*\*\[[^\]\n]{1,200}\]\*\* )/;
const LEGACY_BLOCK = /^\*\*\[([^\]\n]{1,200})\]\*\* ([\s\S]*)$/;

/**
 * Split a description that still carries legacy appended notes into the real
 * description and the comment thread. `history` is used to recover each note's
 * timestamp (appendTaskNote logged an {type:'edit', field:'text'} entry whose
 * newValue is the exact block); `fallbackAt` is used otherwise.
 */
export function splitLegacyComments(
  text: string,
  history: Array<Record<string, any>> | null | undefined,
  fallbackAt: string
): { text: string; comments: TaskComment[] } {
  const source = String(text || '');
  const parts = source.split(LEGACY_SEPARATOR);
  if (parts.length < 2) return { text: source, comments: [] };

  const timestamps = new Map<string, string>();
  for (const h of Array.isArray(history) ? history : []) {
    if (h?.type === 'edit' && h.field === 'text' && typeof h.newValue === 'string' && h.at) {
      if (!timestamps.has(h.newValue)) timestamps.set(h.newValue, h.at);
    }
  }

  const comments: TaskComment[] = [];
  for (const block of parts.slice(1)) {
    const m = block.match(LEGACY_BLOCK);
    if (!m) continue;
    const comment = createTaskComment({
      author: m[1].trim(),
      authorType: 'agent',
      text: m[2],
      at: timestamps.get(block) || fallbackAt,
    });
    if (comment) comments.push(comment);
  }
  return { text: parts[0], comments };
}

export interface TaskCommentInput {
  author: string;
  authorType: TaskCommentAuthorType;
  authorId?: string | null;
  text: string;
  /** Stamp task.updatedAt (skip when a setTaskStatus follows and stamps it). */
  stampUpdatedAt?: boolean;
}

/**
 * Append a comment to the IN-MEMORY task + a matching {type:'comment'} history
 * entry. Does not persist: callers follow up with appendTaskComment (atomic,
 * database/tasks.ts) or use taskMutations.addTaskComment. Returns null for a blank body.
 */
export function recordTaskComment(task: any, input: TaskCommentInput): TaskComment | null {
  const comment = createTaskComment(input);
  if (!comment) return null;
  task.comments = [...(Array.isArray(task.comments) ? task.comments : []), comment];
  if (!task.history) task.history = [];
  task.history.push({
    status: task.status,
    at: comment.at,
    by: comment.author,
    type: 'comment',
    commentId: comment.id,
    newValue: comment.text.length > 500 ? `${comment.text.slice(0, 500)}…` : comment.text,
  });
  if (input.stampUpdatedAt !== false) task.updatedAt = comment.at;
  return comment;
}
