import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';

/**
 * Resolve a stored username (task `history[].by`, comment `author`, task
 * `source.name`, board `owner_username`…) to the user's display name.
 *
 * The server records the immutable `username` (for OAuth accounts that is an
 * email) — the UI shows the friendlier `display_name` instead. Resolving at
 * render time also covers everything written before display names existed.
 *
 * The directory (GET /boards/users, open to every authenticated user) is
 * fetched once per page load and shared by every consumer. Unknown names —
 * agents, 'system', 'user', or a deleted account — are returned unchanged.
 */

let directory: Map<string, string> = new Map();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  if (!loading) {
    loading = api
      .getBoardUsers()
      .then(users => {
        const next = new Map<string, string>();
        for (const u of users || []) {
          const dn = (u.display_name || '').trim();
          if (u.username && dn) next.set(u.username, dn);
        }
        directory = next;
        listeners.forEach(l => l());
      })
      .catch(() => {
        // Allow a retry on the next mount; usernames stay as a fallback.
        loading = null;
      });
  }
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return directory;
}

/** Pure lookup against a directory snapshot — exported for tests. */
export function resolveDisplayName(
  map: Map<string, string>,
  name: string | null | undefined
): string {
  if (!name) return '';
  return map.get(name) || name;
}

/** Test hook: replace the cached directory. */
export function __setUserDirectoryForTests(entries: Record<string, string>) {
  directory = new Map(Object.entries(entries));
  loading = Promise.resolve();
  listeners.forEach(l => l());
}

export function useUserDisplayName() {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void load();
  }, []);

  return useCallback((name: string | null | undefined) => resolveDisplayName(map, name), [map]);
}
