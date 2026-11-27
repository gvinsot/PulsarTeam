import type { AuthBrowserCredentials, AuthBrowserSession } from '../../api';

/** The lifetimes the browser worker accepts (LIFETIME_HOURS in server.py). */
export const LIFETIME_HOURS = [8, 24, 168, 720] as const;

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
  if (s.phase === 'reauth_required') {
    if (s.autoLoginBlocked)
      return 'Automatic sign-in failed: update the credentials or transfer the session again';
    if (s.autoLogin) return 'The website rejected the session: signing in again automatically';
    return 'The website requires a new session transfer';
  }
  return 'Agent access paused';
}

/** Lifetime choices shown for one session; a session cannot be shortened below its age. */
export function lifetimeChoices(s: AuthBrowserSession, now = Date.now()) {
  const lifetime = s.lifetimeHours || 8;
  const created = s.expiresAt ? s.expiresAt - lifetime * 3600_000 : now;
  return LIFETIME_HOURS.filter(h => h === lifetime || created + h * 3600_000 > now);
}

export type CredentialsForm = {
  username: string;
  password: string;
  totpSecret: string;
  loginUrl: string;
};

/**
 * The payload for `set_credentials`, or an error message. Mirrors the API's
 * checks so mistakes show before anything is sent; the API checks again.
 */
export function credentialsPayload(
  form: CredentialsForm,
  site: string
): { credentials: AuthBrowserCredentials } | { error: string } {
  const username = form.username.trim();
  if (!username || !form.password) return { error: 'Enter the username and the password.' };
  const totpSecret = form.totpSecret.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  if (totpSecret && !/^[A-Z2-7]{16,128}$/.test(totpSecret))
    return { error: 'The two-factor secret must be the base32 key shown when setting up TOTP.' };
  const loginUrl = form.loginUrl.trim();
  if (loginUrl) {
    let origin = '';
    try {
      origin = new URL(loginUrl).origin;
    } catch {
      // handled below
    }
    if (origin !== site) return { error: `The sign-in page must be on ${site}.` };
  }
  return {
    credentials: {
      username,
      password: form.password,
      ...(totpSecret ? { totpSecret } : {}),
      ...(loginUrl ? { loginUrl } : {}),
    },
  };
}
