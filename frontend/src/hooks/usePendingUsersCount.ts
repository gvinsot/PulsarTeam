import { useState, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../api';
import { WsEvents } from '../socketEvents';
import type { PendingUsersCount } from '../types';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Number of OAuth accounts awaiting admin approval, for the admin alert badge.
 *
 * Fetched once from GET /api/users/pending/count when `enabled` (admins only —
 * the route is admin-only), then kept live by the 'users:pending' { count }
 * socket event, which the server emits to admin sessions only. A (re)connect
 * re-fetches, since events sent while the socket was down are lost.
 *
 * Disabled (a non-admin, or an admin impersonating someone), the count is 0
 * and nothing is fetched or listened to.
 */
export function usePendingUsersCount(enabled: boolean, socket: Socket | null) {
  const [count, setCountRaw] = useState(0);

  const setCount = useCallback((next: number) => {
    if (isCount(next)) setCountRaw(next);
  }, []);

  const refresh = useCallback(() => {
    api
      .getPendingUsersCount()
      .then(data => setCount(data.count))
      .catch(() => {});
  }, [setCount]);

  useEffect(() => {
    if (!enabled) {
      setCountRaw(0);
      return;
    }
    refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !socket) return;
    const onPending = (data: PendingUsersCount) => setCount(data?.count);
    socket.on(WsEvents.USERS_PENDING, onPending);
    socket.on('connect', refresh);
    return () => {
      socket.off(WsEvents.USERS_PENDING, onPending);
      socket.off('connect', refresh);
    };
  }, [enabled, socket, refresh, setCount]);

  return { count, setCount, refresh };
}
