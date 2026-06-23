import { useState, useEffect } from 'react';
import { api } from '../api';

// Shared fetch pattern for board-scoped plugin resources (repos, storages):
// clear the list when no board is selected, otherwise fetch and surface the
// failure message. The cancelled guard drops late responses after a board
// switch so they can't overwrite fresher state.
function useBoardList(boardId, fetcher, fallbackMsg) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  // `loading` lets callers tell "still fetching" apart from "loaded, empty" —
  // the latter now means "no plugin connected" (the endpoints return 200 [] for
  // an unconnected board instead of erroring), which must render differently
  // from a spinner.
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!boardId) { setItems([]); setError(null); setLoading(false); return; }
    let cancelled = false;
    setError(null);
    setLoading(true);
    fetcher(boardId)
      .then(list => { if (!cancelled) setItems(Array.isArray(list) ? list : []); })
      .catch(err => {
        if (cancelled) return;
        setItems([]);
        setError(err?.message || fallbackMsg);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [boardId]);
  return { items, error, loading };
}

// Repos accessible via the board's GitHub plugin OAuth (picker source)
export function useBoardRepos(boardId) {
  const { items, error, loading } = useBoardList(boardId, api.getBoardAvailableRepos, 'Failed to load repos');
  return { repos: items, error, loading };
}

// Storage roots accessible via the board's OneDrive plugin OAuth
export function useBoardStorages(boardId) {
  const { items, error, loading } = useBoardList(boardId, api.getBoardAvailableStorages, 'Failed to load storages');
  return { storages: items, error, loading };
}
