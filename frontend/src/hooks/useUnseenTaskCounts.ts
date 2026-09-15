import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../api';
import { getSocket } from '../socket';
import { WsEvents } from '../socketEvents';

/** Counts for all accessible boards, regardless of the selected board/filters. */
export function useUnseenTaskCounts() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const requests = useRef({ revision: 0, mounted: false });
  const refresh = useCallback(async () => {
    const state = requests.current;
    if (!state.mounted) return;
    const request = ++state.revision;
    try {
      const result = await api.getUnseenTaskCounts();
      if (state.mounted && request === state.revision) setCounts(result);
    } catch (err) {
      console.error('Failed to load unseen task counts:', err);
    }
  }, []);

  useEffect(() => {
    const state = requests.current;
    state.mounted = true;
    let attached: Socket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Coalesce bursts without postponing refresh forever on a busy board.
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 250);
    };
    const events = [WsEvents.TASK_UPDATED, WsEvents.TASK_DELETED, 'connect'];
    const detach = () => events.forEach(event => attached?.off(event, schedule));
    const sync = () => {
      const socket = getSocket();
      if (socket === attached) return;
      detach();
      attached = socket;
      events.forEach(event => attached?.on(event, schedule));
      schedule();
    };
    const visibleRefresh = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    sync();
    const socketInterval = setInterval(sync, 1000);
    // Also catches restores and events missed during a disconnect.
    const pollInterval = setInterval(visibleRefresh, 15000);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      state.mounted = false;
      ++state.revision;
      detach();
      clearTimeout(timer);
      clearInterval(socketInterval);
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [refresh]);

  return { counts, refresh };
}
