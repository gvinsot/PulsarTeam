import { useState, useEffect } from 'react';
import { api } from '../api';
import type { AvailableRepo, AvailableStorage } from '../types';

// Shared fetch pattern for board-scoped plugin resources (repos, storages):
// clear the list when no board is selected, otherwise fetch and surface the
// failure message. The cancelled guard drops late responses after a board
// switch so they can't overwrite fresher state.
function useBoardList<T>(
  // A board id is a UUID string, null before a board is selected, and undefined
  // where the caller has no board scope at all — the effect below guards all three.
  boardId: string | null | undefined,
  fetcher: (boardId: string) => Promise<T[]>,
  fallbackMsg: string
) {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  // `loading` lets callers tell "still fetching" apart from "loaded, empty" —
  // the latter now means "no plugin connected" (the endpoints return 200 [] for
  // an unconnected board instead of erroring), which must render differently
  // from a spinner.
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!boardId) {
      setItems([]);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setError(null);
    setLoading(true);
    fetcher(boardId)
      .then(list => {
        if (!cancelled) setItems(Array.isArray(list) ? list : []);
      })
      .catch(err => {
        if (cancelled) return;
        setItems([]);
        setError(err?.message || fallbackMsg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);
  return { items, error, loading };
}

// Repos accessible via the board's GitHub plugin OAuth (picker source)
//
// The element type is AvailableRepo widened with `name?: undefined` — the same
// encoding api.ts already uses for GET /projects/available-repos: neither
// available-repos route emits a `name` key, but AgentDetail.tsx:116 reads
// `r.fullName || r.name` on this very list. `name?: undefined` says exactly
// that — readable, always absent — instead of pretending the key exists.
export function useBoardRepos(boardId: string | null | undefined) {
  const { items, error, loading } = useBoardList<AvailableRepo & { name?: undefined }>(
    boardId,
    api.getBoardAvailableRepos,
    'Failed to load repos'
  );
  return { repos: items, error, loading };
}

// Storage roots accessible via the board's OneDrive plugin OAuth
export function useBoardStorages(boardId: string | null | undefined) {
  const { items, error, loading } = useBoardList<AvailableStorage>(
    boardId,
    api.getBoardAvailableStorages,
    'Failed to load storages'
  );
  return { storages: items, error, loading };
}
