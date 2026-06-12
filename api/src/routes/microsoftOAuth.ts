import express from 'express';
import crypto from 'crypto';
import { storeOAuthToken } from '../services/database.js';
import type { ScopeType } from '../services/database.js';
import { getMicrosoftOAuthConfig, MICROSOFT_PLUGIN_REDIRECT_PATH } from '../services/microsoftOAuthConfig.js';
import { sendOAuthResult } from './oauthHelper.js';
import { readSecret } from '../secrets.js';

/**
 * Unified Microsoft OAuth callback handler.
 *
 * OneDrive, Outlook, and any future Microsoft Graph plugin share one OAuth
 * client (one Azure App registration) and one registered redirect URI. The
 * originating service is encoded in the `state` parameter so the callback
 * dispatcher can route the resulting tokens to the right provider in the
 * oauth_tokens table.
 *
 * Mirrors the Google OAuth pattern (api/src/routes/googleOAuth.ts).
 *
 * Mounted at /api/microsoft/oauth-redirect.
 */

export type MicrosoftService = 'onedrive' | 'outlook';

interface StateEntry {
  service: MicrosoftService;
  username: string;
  agentId: string | null;
  boardId: string | null;
  consumerFlow: boolean;
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

// States are HMAC-signed and stateless so an API restart/redeploy between
// /auth-url and the provider redirect does not invalidate in-flight consent
// popups. The consumed set below only guards against replay within this
// process; after a restart a state could be replayed until its TTL expires,
// which is acceptable because the authorization code is single-use at Microsoft.
const consumedStates = new Map<string, number>();

let fallbackStateSecret: Buffer | null = null;
function getStateSecret(): Buffer {
  const jwt = readSecret('JWT_SECRET', '');
  if (jwt) {
    // Domain-separate from JWT signing and from the other providers' states.
    return Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(jwt, 'utf-8'), Buffer.alloc(0), Buffer.from('pulsarteam:oauth-state:microsoft:v1', 'utf-8'), 32)
    );
  }
  // Dev fallback without JWT_SECRET: per-process key (states then only
  // survive within this process, as with the previous in-memory store).
  if (!fallbackStateSecret) fallbackStateSecret = crypto.randomBytes(32);
  return fallbackStateSecret;
}

function signStatePayload(payload: string): string {
  return crypto.createHmac('sha256', getStateSecret()).update(payload).digest('base64url');
}

export function generateMicrosoftOAuthState(
  service: MicrosoftService,
  username: string,
  agentId: string | null = null,
  boardId: string | null = null,
  consumerFlow: boolean = false,
): string {
  const now = Date.now();
  for (const [k, exp] of consumedStates) {
    if (exp < now) consumedStates.delete(k);
  }
  const entry: StateEntry = { service, username, agentId, boardId, consumerFlow, expiresAt: now + STATE_TTL_MS };
  const payload = Buffer.from(
    JSON.stringify({ ...entry, nonce: crypto.randomBytes(8).toString('hex') }),
    'utf-8',
  ).toString('base64url');
  return `${payload}.${signStatePayload(payload)}`;
}

export function consumeMicrosoftOAuthState(state: string): Omit<StateEntry, 'expiresAt'> | null {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const signature = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(signStatePayload(payload));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;

  let entry: StateEntry;
  try {
    entry = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt < Date.now()) return null;
  if (consumedStates.has(state)) return null;
  consumedStates.set(state, entry.expiresAt);
  return {
    service: entry.service,
    username: entry.username,
    agentId: entry.agentId || null,
    boardId: entry.boardId || null,
    consumerFlow: !!entry.consumerFlow,
  };
}

function resolveScope(
  agentId: string | null,
  boardId: string | null,
  username: string,
): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
}

async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const profile = await res.json();
      return profile.mail || profile.userPrincipalName || null;
    }
  } catch (err) {
    console.warn('[Microsoft] Could not fetch profile email:', (err as Error).message);
  }
  return null;
}

const PROVIDER_LABEL: Record<MicrosoftService, string> = {
  onedrive: 'OneDrive',
  outlook: 'Outlook',
};

const OAUTH_CALLBACK_MESSAGE_TYPE = 'microsoft-oauth-callback';

// Best-effort service recovery for errors that arrive before state
// verification, so the opener can route the message to the right widget.
// Reads the (signed) state payload without requiring a valid flow.
function peekServiceFromState(state: string | undefined): { service: MicrosoftService } | undefined {
  if (!state) return undefined;
  try {
    const payload = state.slice(0, state.lastIndexOf('.'));
    const entry = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (entry?.service === 'onedrive' || entry?.service === 'outlook') return { service: entry.service };
  } catch { /* untaggable — the popup itself still displays the error */ }
  return undefined;
}

export async function handleMicrosoftOAuthCallback(req: express.Request, res: express.Response) {
  const err = req.query.error as string | undefined;
  const state = req.query.state as string | undefined;
  if (err) {
    const desc = (req.query.error_description as string | undefined) || err;
    return sendOAuthResult(res, 'Microsoft', OAUTH_CALLBACK_MESSAGE_TYPE, false, String(desc), peekServiceFromState(state));
  }

  const code = req.query.code as string | undefined;
  if (!code || !state) {
    return sendOAuthResult(res, 'Microsoft', OAUTH_CALLBACK_MESSAGE_TYPE, false, 'Missing code or state parameter', peekServiceFromState(state));
  }

  const stateData = consumeMicrosoftOAuthState(state);
  if (!stateData) {
    return sendOAuthResult(res, 'Microsoft', OAUTH_CALLBACK_MESSAGE_TYPE, false, 'Invalid or expired state. Please try again.');
  }

  const providerLabel = PROVIDER_LABEL[stateData.service] || 'Microsoft';

  const config = getMicrosoftOAuthConfig();
  if (!config) {
    return sendOAuthResult(res, providerLabel, OAUTH_CALLBACK_MESSAGE_TYPE, false, 'Microsoft OAuth not configured on server', { service: stateData.service });
  }

  try {
    // Must match the redirect_uri sent in the auth URL — derive the same way.
    const redirectUri = `${req.protocol}://${req.get('host')}${MICROSOFT_PLUGIN_REDIRECT_PATH}`;
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    // Le token exchange DOIT se faire sur le même endpoint que l'auth: si la
    // popup d'autorisation a utilisé /consumers/, l'échange de code aussi —
    // sinon Microsoft renvoie AADSTS70000121 ("grant from personal account").
    const tokenEndpointTenant = stateData.consumerFlow ? 'consumers' : config.tenantId;
    const response = await fetch(`https://login.microsoftonline.com/${tokenEndpointTenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error(`[${providerLabel}] Token exchange failed:`, data);
      return sendOAuthResult(
        res,
        providerLabel,
        OAUTH_CALLBACK_MESSAGE_TYPE,
        false,
        'Token exchange failed: ' + (data.error_description || data.error || 'unknown'),
        { service: stateData.service },
      );
    }

    const email = await fetchUserEmail(data.access_token);
    const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

    await storeOAuthToken({
      provider: stateData.service,
      scopeType,
      scopeId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      meta: { email, consumerFlow: stateData.consumerFlow || undefined },
    }, { throwOnPersistError: true });

    console.log(`✅ [${providerLabel}] OAuth tokens stored for ${scopeType}:${scopeId} (${email || 'unknown'}) via redirect`);
    return sendOAuthResult(res, providerLabel, OAUTH_CALLBACK_MESSAGE_TYPE, true, null, { service: stateData.service, email });
  } catch (e) {
    console.error(`[${providerLabel}] OAuth redirect error:`, e);
    return sendOAuthResult(res, providerLabel, OAUTH_CALLBACK_MESSAGE_TYPE, false, 'Internal error during token exchange', { service: stateData.service });
  }
}

export function microsoftOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleMicrosoftOAuthCallback);
  return router;
}
