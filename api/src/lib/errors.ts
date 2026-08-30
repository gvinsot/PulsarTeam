// Narrowing helpers for `catch` bindings.
//
// `useUnknownInCatchVariables` types a caught value as `unknown`, which is the
// truth: `throw` accepts any value, and a rejected promise carries whatever the
// rejecting code passed. `err.message` was only ever correct by convention.
//
// These are the two shapes this codebase actually reads off a caught value.
// Reach for `err instanceof Error` directly when you need more than the text —
// a `.code`, a `.stack`, a custom subclass — rather than widening these.

/**
 * The human-readable text of a caught value, whatever was thrown.
 *
 * Errors give their `message`; a thrown string is itself the message; anything
 * carrying a string `message` (a rejected fetch envelope, a pg error crossing a
 * module boundary) is trusted for that field. Everything else is stringified,
 * which is honest rather than pretty — a `[object Object]` in a log means the
 * throw site is passing something that deserves a look.
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

/** Narrow a caught value to an `Error`, wrapping anything else in one. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(errorMessage(err));
}

/**
 * The `code` of a caught value, or undefined when it carries none.
 *
 * Driver errors are dispatched on this — pg's SQLSTATE (`23505` for a unique
 * violation), node's `ENOENT`/`ECONNREFUSED` — so the comparison needs to
 * survive a non-Error being thrown rather than crash on it.
 */
export function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
