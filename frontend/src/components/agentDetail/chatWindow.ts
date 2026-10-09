// Rendering helpers that keep long chats (notably sandbox agents) responsive.
import type { ConversationMessage } from '../../types';

// Long conversations (sandbox agents in particular accumulate hundreds of
// tool results and CLI transcripts) made the chat sluggish: every streamed
// chunk re-rendered and re-parsed the markdown of the whole history. Only the
// most recent messages are mounted; older ones are revealed on demand.
export const CHAT_WINDOW_SIZE = 60;
// Live CLI/PTY output can grow without bound during a long sandbox turn; only
// its tail is useful while it streams, so cap what the DOM has to lay out.
export const MAX_TERMINAL_CHARS = 20_000;

/** Index of the first history message to render for the current window. */
export function chatWindowStart(total: number, visibleCount: number): number {
  return Math.max(0, total - Math.max(0, visibleCount));
}

/** Keep the tail of a (possibly huge) terminal transcript. */
export function terminalTail(text: string, max = MAX_TERMINAL_CHARS): string {
  if (!text || text.length <= max) return text;
  const tail = text.slice(-max);
  // Drop the partial first line so the terminal columns stay aligned.
  const nl = tail.indexOf('\n');
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
}

/**
 * History refreshes deliver fresh message objects with identical contents, so
 * compare the fields that are rendered rather than the object identity —
 * re-parsing the markdown of every message on each streamed chunk is what made
 * long chats crawl.
 */
export function sameRenderedMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  if (a === b) return true;
  // Cheap rejections first; the full comparison covers the remaining fields
  // (tool-result metadata, images, …) that ChatMessage renders.
  if (a.role !== b.role || a.type !== b.type || a.content !== b.content) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
