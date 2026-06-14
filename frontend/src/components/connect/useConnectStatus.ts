import { useState, useEffect, useCallback, useRef } from 'react';

export interface ConnectStatus {
  configured: boolean;
  connected: boolean;
  [key: string]: any;
}

/**
 * Shared status-fetch state for the integration connect widgets
 * (OAuth popups and credential forms alike).
 *
 * The onStatusChange callback is kept in a ref so parents can pass a new
 * inline function on every render without re-triggering the fetch effect.
 */
export function useConnectStatus(
  name: string,
  getStatus: (agentId?: string, boardId?: string) => Promise<ConnectStatus>,
  agentId?: string,
  boardId?: string,
  onStatusChange?: (status: ConnectStatus) => void,
) {
  const [status, setStatus] = useState<ConnectStatus>({ configured: false, connected: false });
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(null);

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const fetchStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const data = await getStatus(agentId || undefined, boardId || undefined);
      setStatus(data);
      onStatusChangeRef.current?.(data);
    } catch (err) {
      console.error(`${name} status check failed:`, err);
      setStatusError(err.message || 'Status check failed');
    } finally {
      setLoading(false);
    }
  }, [name, getStatus, agentId, boardId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // The Retry button flips the widget back into its loading state while re-fetching.
  const retry = () => {
    setLoading(true);
    fetchStatus();
  };

  return { status, loading, statusError, fetchStatus, retry };
}
