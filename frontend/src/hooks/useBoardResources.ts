import { useState, useEffect } from 'react';
import { api } from '../api';

// Shared fetch pattern for board-scoped plugin resources (repos, storages):
// clear the list when no board is selected, otherwise fetch and surface the
// failure message. The cancelled guard drops late responses after a board
// switch so they can't overwrite fresher state.
function useBoardList(boardId, fetcher, fallbackMsg) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!boardId) { setItems([]); setError(null); return; }
    let cancelled = false;
    setError(null);
    fetcher(boardId)
      .then(list => { if (!cancelled) setItems(Array.isArray(list) ? list : []); })
      .catch(err => {
        if (cancelled) return;
        setItems([]);
        setError(err?.message || fallbackMsg);
      });
    return () => { cancelled = true; };
  }, [boardId]);
  return { items, error };
}

// Repos accessible via the board's GitHub plugin OAuth (picker source)
export function useBoardRepos(boardId) {
  const { items, error } = useBoardList(boardId, api.getBoardAvailableRepos, 'Failed to load repos');
  return { repos: items, error };
}

// Storage roots accessible via the board's OneDrive plugin OAuth
export function useBoardStorages(boardId) {
  const { items, error } = useBoardList(boardId, api.getBoardAvailableStorages, 'Failed to load storages');
  return { storages: items, error };
}
