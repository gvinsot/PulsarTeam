// A status update can arrive before STREAM_START's matching busy update.
// Ask for an authoritative stream snapshot instead of clearing on idle alone.
const RECONCILE_MS = 30_000;
const SETTLED_RECONCILE_MS = 1_000;
const END_GRACE_MS = 3_000;

export function createChatStreamLifecycle(
  requestState: () => void,
  clearBuffer: (agentId: string) => void
) {
  let active = new Set<string>();
  const endTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let fastReconcile = false;

  function cancelEnd(id: string) {
    const timer = endTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    endTimers.delete(id);
  }

  function cancelReconcile() {
    clearTimeout(reconcileTimer);
    reconcileTimer = undefined;
    fastReconcile = false;
  }

  function reconcileSoon(fast = false) {
    if (!active.size) {
      cancelReconcile();
      return;
    }
    if (reconcileTimer !== undefined) {
      if (!fast || fastReconcile) return;
      cancelReconcile();
    }
    fastReconcile = fast;
    reconcileTimer = setTimeout(
      () => {
        reconcileTimer = undefined;
        fastReconcile = false;
        requestState();
        // Retry if the snapshot itself was missed. dispose() stops this on logout.
        reconcileSoon();
      },
      fast ? SETTLED_RECONCILE_MS : RECONCILE_MS
    );
  }

  return {
    start(id: string) {
      cancelEnd(id);
      active.add(id);
      reconcileSoon();
    },
    status(id: string, status: string) {
      if (active.has(id) && status !== 'busy') reconcileSoon(true);
    },
    updated(id: string) {
      if (!endTimers.has(id)) return;
      cancelEnd(id);
      clearBuffer(id);
    },
    end(id: string) {
      active.delete(id);
      reconcileSoon();
      cancelEnd(id);
      const timer = setTimeout(() => {
        // A cleanup belonging to an earlier response cannot clear a new one.
        if (endTimers.get(id) !== timer) return;
        endTimers.delete(id);
        clearBuffer(id);
      }, END_GRACE_MS);
      endTimers.set(id, timer);
    },
    resume(ids: string[]) {
      const next = new Set(ids);
      const ended = [...active].filter(id => !next.has(id));
      for (const id of endTimers.keys()) cancelEnd(id);
      cancelReconcile();
      active = next;
      reconcileSoon();
      return ended;
    },
    remove(id: string) {
      cancelEnd(id);
      active.delete(id);
      reconcileSoon();
      clearBuffer(id);
    },
    dispose() {
      for (const id of endTimers.keys()) cancelEnd(id);
      active.clear();
      cancelReconcile();
    },
  };
}
