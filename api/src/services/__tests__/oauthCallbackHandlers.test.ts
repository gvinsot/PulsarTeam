/**
 * Handler-level tests for the Google/Microsoft OAuth callback handlers
 * (routes/googleOAuth.ts, routes/microsoftOAuth.ts), which both run on the
 * shared runOAuthCodeExchange engine (routes/oauthCallback.ts).
 *
 * The postMessage payload embedded in the result page is wire format for the
 * frontend connect widgets (GmailConnect, GoogleDriveConnect, OneDriveConnect,
 * …) — these tests assert it field-for-field per branch, including the
 * deliberate absence of `service` on Microsoft's invalid-state branch.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Module mocks — must be registered BEFORE importing modules under test ────

const storedTokens: any[] = [];
mock.module('../database.js', {
  namedExports: {
    storeOAuthToken: async (record: any) => { storedTokens.push(record); },
  },
});

process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
process.env.MICROSOFT_CLIENT_ID = 'test-ms-client';
process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';

const { handleGoogleOAuthCallback, generateGoogleOAuthState } = await import('../../routes/googleOAuth.js');
const { handleMicrosoftOAuthCallback, generateMicrosoftOAuthState } = await import('../../routes/microsoftOAuth.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function jsonResponse(ok: boolean, body: Record<string, any>, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as any;
}

/** Replaces global fetch; the i-th call gets the i-th handler (last one repeats). */
function mockFetch(...handlers: Array<(url: string, init?: any) => any>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const handler = handlers[Math.min(i++, handlers.length - 1)];
    return handler(String(url), init);
  }) as any;
  return calls;
}

function fakeReq(query: Record<string, any>) {
  return { query, protocol: 'https', get: () => 'team.example.test', user: undefined } as any;
}

function fakeRes() {
  const out = { html: '' };
  const res = {
    setHeader: () => { /* CSP header — not under test */ },
    send: (html: string) => { out.html = html; },
  } as any;
  return { res, out };
}

/** Extracts the postMessage payload object embedded in the result page. */
function payloadOf(html: string): any {
  const m = html.match(/var payload = (.*);/);
  assert.ok(m, 'result page embeds a postMessage payload');
  return JSON.parse(m![1]);
}

// ── Google ───────────────────────────────────────────────────────────────────

test('google callback: provider error maps to service-less gmail-type message', async () => {
  const { res, out } = fakeRes();
  await handleGoogleOAuthCallback(fakeReq({ error: 'access_denied' }), res);
  assert.deepEqual(payloadOf(out.html), {
    type: 'gmail-oauth-callback',
    success: false,
    error: 'access_denied',
  });
});

test('google callback: invalid state is rejected without a service tag', async () => {
  const { res, out } = fakeRes();
  await handleGoogleOAuthCallback(fakeReq({ code: 'c0de', state: 'not-a-real-state' }), res);
  assert.deepEqual(payloadOf(out.html), {
    type: 'gmail-oauth-callback',
    success: false,
    error: 'Invalid or expired state. Please try again.',
  });
});

test('google callback: happy path stores the token and notifies the right widget', async () => {
  storedTokens.length = 0;
  const calls = mockFetch(
    () => jsonResponse(true, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
    () => jsonResponse(true, { email: 'alice@example.com' }),
  );

  const state = generateGoogleOAuthState('gdrive', 'alice', 'agent-1', null);
  const { res, out } = fakeRes();
  await handleGoogleOAuthCallback(fakeReq({ code: 'c0de', state }), res);

  assert.deepEqual(payloadOf(out.html), {
    type: 'gdrive-oauth-callback',
    success: true,
    error: null,
    email: 'alice@example.com',
    service: 'gdrive',
  });

  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  const exchangeBody = new URLSearchParams(calls[0].init.body);
  assert.equal(exchangeBody.get('redirect_uri'), 'https://team.example.test/api/google/oauth-redirect');
  assert.equal(exchangeBody.get('grant_type'), 'authorization_code');

  assert.equal(storedTokens.length, 1);
  assert.equal(storedTokens[0].provider, 'gdrive');
  assert.equal(storedTokens[0].scopeType, 'agent');
  assert.equal(storedTokens[0].scopeId, 'agent-1');
  assert.equal(storedTokens[0].accessToken, 'at-1');
  assert.deepEqual(storedTokens[0].meta, { email: 'alice@example.com' });
});

test('google callback: failed exchange reports the provider error description', async () => {
  mockFetch(() => jsonResponse(false, { error: 'invalid_grant', error_description: 'Bad code' }));
  const state = generateGoogleOAuthState('gmail', 'alice');
  const { res, out } = fakeRes();
  await handleGoogleOAuthCallback(fakeReq({ code: 'c0de', state }), res);
  assert.deepEqual(payloadOf(out.html), {
    type: 'gmail-oauth-callback',
    success: false,
    error: 'Token exchange failed: Bad code',
    service: 'gmail',
  });
});

// ── Microsoft ────────────────────────────────────────────────────────────────

test('microsoft callback: missing code is tagged with the peeked service', async () => {
  const state = generateMicrosoftOAuthState('onedrive', 'bob');
  const { res, out } = fakeRes();
  await handleMicrosoftOAuthCallback(fakeReq({ state }), res);
  assert.deepEqual(payloadOf(out.html), {
    type: 'microsoft-oauth-callback',
    success: false,
    error: 'Missing code or state parameter',
    service: 'onedrive',
  });
});

test('microsoft callback: invalid state carries NO service field (popup-only error)', async () => {
  const { res, out } = fakeRes();
  await handleMicrosoftOAuthCallback(fakeReq({ code: 'c0de', state: 'tampered' }), res);
  assert.deepEqual(payloadOf(out.html), {
    type: 'microsoft-oauth-callback',
    success: false,
    error: 'Invalid or expired state. Please try again.',
  });
});

test('microsoft callback: consumer-flow happy path exchanges on /consumers/ and stores consumerFlow meta', async () => {
  storedTokens.length = 0;
  const calls = mockFetch(
    () => jsonResponse(true, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    () => jsonResponse(true, { mail: 'bob@hotmail.com' }),
  );

  const state = generateMicrosoftOAuthState('onedrive', 'bob', null, null, true);
  const { res, out } = fakeRes();
  await handleMicrosoftOAuthCallback(fakeReq({ code: 'c0de', state }), res);

  assert.deepEqual(payloadOf(out.html), {
    type: 'microsoft-oauth-callback',
    success: true,
    error: null,
    service: 'onedrive',
    email: 'bob@hotmail.com',
  });

  assert.equal(calls[0].url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
  assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/me');

  assert.equal(storedTokens.length, 1);
  assert.equal(storedTokens[0].provider, 'onedrive');
  assert.equal(storedTokens[0].scopeType, 'user');
  assert.equal(storedTokens[0].scopeId, 'bob');
  assert.deepEqual(storedTokens[0].meta, { email: 'bob@hotmail.com', consumerFlow: true });
});
