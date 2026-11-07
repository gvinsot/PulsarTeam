import type { AuthBrowserSession } from '../../api';

/** Websites from a status payload; anything that is not a list means none. */
export function browserSessions(raw: unknown): AuthBrowserSession[] {
  return Array.isArray(raw) ? (raw as AuthBrowserSession[]) : [];
}

/**
 * The transfer waiting in this scope. The worker allows only one at a time
 * (the extension pairs with exactly one request element on the page): `mine`
 * is the one this user can complete, `blocked` means another user's transfer
 * is waiting, so no website can be added for now.
 */
export function pendingTransfer(sessions: AuthBrowserSession[]) {
  const waiting = sessions.filter(s => s.phase === 'pending');
  const mine = waiting.find(s => s.canControl);
  return { mine, blocked: waiting.length > 0 && !mine, canAdd: waiting.length === 0 };
}

export function sessionLabel(s: AuthBrowserSession) {
  if (s.connected) return 'Session shared on the cluster';
  if (s.phase === 'pending') return 'Waiting for session transfer';
  if (s.phase === 'reauth_required') return 'The website requires a new session transfer';
  return 'Agent access paused';
}
