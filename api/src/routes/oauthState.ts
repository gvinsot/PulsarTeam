import crypto from 'crypto';
import { readSecret } from '../secrets.js';

/**
 * Shared factory for HMAC-signed, stateless OAuth `state` parameters.
 *
 * States are HMAC-signed and stateless so an API restart/redeploy between
 * /auth-url and the provider redirect does not invalidate in-flight consent
 * popups. The consumed set only guards against replay within this process;
 * after a restart a state could be replayed until its TTL expires, which is
 * acceptable because the authorization code is single-use at the provider.
 *
 * Each provider instantiates its own store with a distinct `domain` so states
 * are domain-separated (a google-issued state never verifies under github's
 * consume, and vice-versa). CRITICAL: the domain strings feed the HKDF info
 * parameter ('pulsarteam:oauth-state:<domain>:v1') — they must stay
 * byte-identical across deploys so states issued before a rolling deploy
 * still verify after it when JWT_SECRET is set.
 */

export interface OAuthStateStore<T extends object> {
  /** Sign `entry` (plus expiresAt + nonce) into an opaque state string. */
  generate(entry: T): string;
  /**
   * Verify + parse + expiry-check + replay-guard. Returns the raw parsed
   * payload (still carrying expiresAt/nonce) or null. Callers normalize the
   * fields they care about (e.g. `agentId || null`) in their own wrappers.
   */
  consume(state: string): Record<string, any> | null;
  /**
   * Best-effort, UNVERIFIED read of the state payload — for routing error
   * popups before/without a valid flow. Never trust these fields for authz.
   */
  peek(state: string | undefined): Record<string, any> | undefined;
}

export function createOAuthStateStore<T extends object>(
  domain: string,
  ttlMs: number = 10 * 60 * 1000,
): OAuthStateStore<T> {
  const consumedStates = new Map<string, number>();

  // Dev fallback without JWT_SECRET: per-process, per-store key (states then
  // only survive within this process, as with the previous in-memory store).
  // Kept per-store because a random key has no HKDF domain separation — a
  // shared fallback would let one provider's states verify under another's.
  let fallbackStateSecret: Buffer | null = null;

  function getStateSecret(): Buffer {
    const jwt = readSecret('JWT_SECRET', '');
    if (jwt) {
      // Domain-separate from JWT signing and from the other providers' states.
      return Buffer.from(
        crypto.hkdfSync('sha256', Buffer.from(jwt, 'utf-8'), Buffer.alloc(0), Buffer.from(`pulsarteam:oauth-state:${domain}:v1`, 'utf-8'), 32)
      );
    }
    if (!fallbackStateSecret) fallbackStateSecret = crypto.randomBytes(32);
    return fallbackStateSecret;
  }

  function signStatePayload(payload: string): string {
    return crypto.createHmac('sha256', getStateSecret()).update(payload).digest('base64url');
  }

  return {
    generate(entry: T): string {
      const now = Date.now();
      for (const [k, exp] of consumedStates) {
        if (exp < now) consumedStates.delete(k);
      }
      const payload = Buffer.from(
        JSON.stringify({ ...entry, expiresAt: now + ttlMs, nonce: crypto.randomBytes(8).toString('hex') }),
        'utf-8',
      ).toString('base64url');
      return `${payload}.${signStatePayload(payload)}`;
    },

    consume(state: string): Record<string, any> | null {
      const dot = state.lastIndexOf('.');
      if (dot <= 0) return null;
      const payload = state.slice(0, dot);
      const signature = Buffer.from(state.slice(dot + 1));
      const expected = Buffer.from(signStatePayload(payload));
      if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;

      let entry: Record<string, any>;
      try {
        entry = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      } catch {
        return null;
      }
      if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt < Date.now()) return null;
      if (consumedStates.has(state)) return null;
      consumedStates.set(state, entry.expiresAt);
      return entry;
    },

    peek(state: string | undefined): Record<string, any> | undefined {
      if (!state) return undefined;
      try {
        const payload = state.slice(0, state.lastIndexOf('.'));
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      } catch {
        return undefined;
      }
    },
  };
}
