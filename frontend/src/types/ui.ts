// ── Cross-cutting UI shapes ─────────────────────────────────────────────────
//
// Everything in this file is PRODUCED BY THE FRONTEND — no API endpoint emits any
// of it. It is here because these shapes are re-declared, slightly differently,
// in a dozen components, and the drift is already visible (see ShowToastFn).
//
// UI-local shapes that only make sense next to one wire payload live with that
// payload instead: RepoFileTreeNode, RepoExplorerFileState and GitHubActivityTarget
// are in code.ts.

/**
 * Toast severity. Defaults to 'error' at the producer (App.tsx:46). Every call
 * site in the repo passes only 'error' or 'success'; 'info' is the renderer's
 * else-branch (blue + Info icon) — reachable by contract, never emitted today.
 */
export type ToastType = 'error' | 'success' | 'info';

/**
 * One transient notification in App's toast stack.
 * Produced by frontend/src/App.tsx:56.
 */
export interface Toast {
  /** `Date.now() + Math.random()` — a FRACTIONAL number, not an integer and not a
   *  string. Used as the React key and as the dismissal handle. */
  id: number;
  /** Also the dedupe key, together with `type`. */
  message: string;
  type: ToastType;
}

/**
 * The showToast callback, threaded as an identical prop through at least eight
 * components. Declared once here so the drift stops.
 * Produced by frontend/src/App.tsx:46.
 *
 * `duration` defaults to 5000ms and `duration <= 0` disables auto-dismissal.
 * WelcomeTutorialModal used to declare its own widened `(msg: string, type?:
 * string) => void`, which a ShowToastFn does not assign to under
 * strictFunctionTypes; it now imports this alias, and the `showToastWidened`
 * bridge App.tsx kept for it is gone. Every prop of this shape is this alias.
 *
 * Every consumer except App and Dashboard receives it as OPTIONAL and calls it
 * with `showToast?.(...)`, so the prop type is normally `ShowToastFn | undefined`.
 */
export type ShowToastFn = (message: string, type?: ToastType, duration?: number) => void;
