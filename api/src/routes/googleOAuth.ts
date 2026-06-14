import express from 'express';
import { getGoogleOAuthConfig, GOOGLE_PLUGIN_REDIRECT_PATH } from '../services/googleOAuthConfig.js';
import { sendOAuthResult } from './oauthHelper.js';
import { runOAuthCodeExchange } from './oauthCallback.js';
import { createOAuthStateStore } from './oauthState.js';

/**
 * Unified Google OAuth callback handler.
 *
 * Gmail, Drive, and any future Google API share one OAuth client and one
 * registered redirect URI. The originating service is encoded in the `state`
 * parameter so the callback handler can route the resulting tokens to the
 * right provider in the oauth_tokens table.
 *
 * The handler is mounted at /api/google/oauth-redirect — the single URI
 * registered in the Google Cloud Console. The URL path is irrelevant to the
 * dispatch logic, only state.service is.
 */

export type GoogleService = 'gmail' | 'gdrive';

interface StateEntry {
  service: GoogleService;
  username: string;
  agentId: string | null;
  boardId: string | null;
  expiresAt: number;
}

// HKDF domain 'google' must stay byte-identical across deploys — see oauthState.ts.
const oauthStates = createOAuthStateStore<Omit<StateEntry, 'expiresAt'>>('google');

export function generateGoogleOAuthState(
  service: GoogleService,
  username: string,
  agentId: string | null = null,
  boardId: string | null = null,
): string {
  return oauthStates.generate({ service, username, agentId, boardId });
}

export function consumeGoogleOAuthState(state: string): Omit<StateEntry, 'expiresAt'> | null {
  const entry = oauthStates.consume(state);
  if (!entry) return null;
  return {
    service: entry.service,
    username: entry.username,
    agentId: entry.agentId || null,
    boardId: entry.boardId || null,
  };
}

async function fetchUserEmail(service: GoogleService, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const profile = await res.json();
      return profile.email || null;
    }
  } catch (err) {
    console.warn(`[${service}] Could not fetch profile email:`, (err as Error).message);
  }
  return null;
}

// Per-service message types — listeners in GmailConnect.tsx / GoogleDriveConnect.tsx
// filter on these so a Gmail popup never notifies the Drive widget and vice-versa.
const MESSAGE_TYPE_BY_SERVICE: Record<GoogleService, string> = {
  gmail: 'gmail-oauth-callback',
  gdrive: 'gdrive-oauth-callback',
};

const PROVIDER_LABEL_BY_SERVICE: Record<GoogleService, string> = {
  gmail: 'Gmail',
  gdrive: 'Google Drive',
};

function googleOAuthResult(
  res: express.Response,
  service: GoogleService | null,
  success: boolean,
  error?: string | null,
  email?: string | null,
) {
  const providerLabel = service ? PROVIDER_LABEL_BY_SERVICE[service] : 'Google';
  // No service → no listener can claim the message, but we still send the gmail
  // type so the popup reports _something_. Errors at this stage are rare.
  const messageType = service ? MESSAGE_TYPE_BY_SERVICE[service] : 'gmail-oauth-callback';
  const extra: Record<string, any> = {};
  if (email) extra.email = email;
  if (service) extra.service = service;
  sendOAuthResult(res, providerLabel, messageType, success, error, extra);
}

export async function handleGoogleOAuthCallback(req: express.Request, res: express.Response) {
  return runOAuthCodeExchange<Omit<StateEntry, 'expiresAt'>, NonNullable<ReturnType<typeof getGoogleOAuthConfig>>>(req, res, {
    consumeState: consumeGoogleOAuthState,
    getConfig: getGoogleOAuthConfig,
    notConfiguredError: 'Google OAuth not configured on server',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    redirectPath: GOOGLE_PLUGIN_REDIRECT_PATH,
    logLabel: (state) => state.service,
    fetchProfileEmail: (accessToken, state) => fetchUserEmail(state.service, accessToken),
    buildMeta: (_state, email) => ({ email }),
    sendSuccess: (res2, state, email) => googleOAuthResult(res2, state.service, true, null, email),
    // Early errors (provider_error/missing_params/bad_state) arrive with
    // consumed=null and map to service=null — the gmail-type fallback in
    // googleOAuthResult takes over there.
    sendError: (res2, _stage, consumed, _rawState, error) =>
      googleOAuthResult(res2, consumed?.service ?? null, false, error),
  });
}

export function googleOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleGoogleOAuthCallback);
  return router;
}
