// Keep retrying a failed final-history read while this conversation is open.
// Cancellation also fences in-flight reads, so an old response cannot replace
// the history after another turn starts or the user switches agents.
export function refreshChatHistory<T>(
  load: () => Promise<T>,
  apply: (history: T) => void,
  onError: (error: unknown) => void
): () => void {
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1_000;
  async function refresh() {
    try {
      const history = await load();
      if (!cancelled) apply(history);
    } catch (error) {
      if (cancelled) return;
      onError(error);
      retryTimer = setTimeout(() => void refresh(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
    }
  }
  void refresh();
  return () => {
    cancelled = true;
    clearTimeout(retryTimer);
  };
}
