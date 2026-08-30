// Narrowing helpers for `catch` bindings.
//
// `useUnknownInCatchVariables` types a caught value as `unknown`, which is the
// truth: `throw` accepts any value, and in the browser a rejected fetch or a
// DOM API can hand back anything. `err.message` was only ever correct by
// convention.
//
// Mirror of api/src/lib/errors.ts — kept as a copy rather than a shared package
// because the two builds have no common module graph.

/**
 * The human-readable text of a caught value, whatever was thrown.
 *
 * Errors give their `message`; a thrown string is itself the message; anything
 * carrying a string `message` (a rejected API envelope) is trusted for that
 * field. Everything else is stringified, which is honest rather than pretty.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/**
 * The `name` of a caught value, or '' when it carries none.
 *
 * DOM errors are dispatched on this — `NotAllowedError` from getUserMedia,
 * `AbortError` from a cancelled fetch — so the comparison needs to survive a
 * non-Error being thrown rather than crash on it.
 */
export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (err !== null && typeof err === 'object' && 'name' in err) {
    const name = (err as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}
