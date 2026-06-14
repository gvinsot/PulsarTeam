import { useEffect, useRef, RefObject } from 'react';

/**
 * Dismiss helpers shared by the dropdowns and modals.
 *
 * All three register plain bubble-phase listeners (no capture) to match the
 * previously hand-rolled copies exactly — switching to capture phase would
 * change behavior for inner elements that stopPropagation() in bubble phase.
 * The callbacks are kept in a ref so callers can pass inline arrows without the
 * effect re-registering every render and without narrowing useCallback deps.
 */

/** Fire `onOutside` on a mousedown outside `ref`. No-op while ref is unattached. */
export function useClickOutside(
  ref: RefObject<HTMLElement>,
  onOutside: () => void,
  enabled = true,
) {
  const cb = useRef(onOutside);
  useEffect(() => { cb.current = onOutside; });

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, enabled]);
}

/** Fire `onEscape` on the Escape key. */
export function useEscapeKey(onEscape: () => void, enabled = true) {
  const cb = useRef(onEscape);
  useEffect(() => { cb.current = onEscape; });

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') cb.current(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled]);
}

/** Lock body scroll while mounted, restoring overflow to '' on unmount. */
export function useBodyScrollLock() {
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);
}
