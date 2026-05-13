import test from 'node:test';
import assert from 'node:assert/strict';
import { getGoogleOAuthConfig, GOOGLE_PLUGIN_REDIRECT_PATH } from '../googleOAuthConfig.js';

const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

function reset() {
  for (const k of KEYS) delete process.env[k];
}

test('returns null when nothing is configured', () => {
  reset();
  assert.equal(getGoogleOAuthConfig(), null);
});

test('returns config when both GOOGLE_* env vars are set', () => {
  reset();
  process.env.GOOGLE_CLIENT_ID = 'shared-id';
  process.env.GOOGLE_CLIENT_SECRET = 'shared-secret';

  const cfg = getGoogleOAuthConfig();
  assert.ok(cfg);
  assert.equal(cfg!.clientId, 'shared-id');
  assert.equal(cfg!.clientSecret, 'shared-secret');
});

test('returns null when client secret is missing', () => {
  reset();
  process.env.GOOGLE_CLIENT_ID = 'id';
  // missing client secret
  assert.equal(getGoogleOAuthConfig(), null);
});

test('exposes the plugin redirect path constant', () => {
  // Plugin auth-URL builders and the dispatcher both rely on this path being
  // a stable string — drift between them would make Google reject the token
  // exchange with redirect_uri_mismatch.
  assert.equal(GOOGLE_PLUGIN_REDIRECT_PATH, '/api/google/oauth-redirect');
});
