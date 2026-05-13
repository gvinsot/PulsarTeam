import test from 'node:test';
import assert from 'node:assert/strict';
import { getGoogleOAuthConfig } from '../googleOAuthConfig.js';

const KEYS = [
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URI',
  'GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REDIRECT_URI',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
];

function reset() {
  for (const k of KEYS) delete process.env[k];
}

test('returns null when nothing is configured', () => {
  reset();
  assert.equal(getGoogleOAuthConfig('gmail'), null);
  assert.equal(getGoogleOAuthConfig('gdrive'), null);
});

test('Drive falls back to Gmail credentials and derives redirect from /gmail-callback.html', () => {
  reset();
  process.env.GMAIL_CLIENT_ID = 'cid';
  process.env.GMAIL_CLIENT_SECRET = 'secret';
  process.env.GMAIL_REDIRECT_URI = 'https://example.com/gmail-callback.html';

  const cfg = getGoogleOAuthConfig('gdrive');
  assert.ok(cfg);
  assert.equal(cfg!.clientId, 'cid');
  assert.equal(cfg!.clientSecret, 'secret');
  assert.equal(cfg!.redirectUri, 'https://example.com/gdrive-callback.html');
});

test('Drive derives redirect from Gmail /api/gmail/oauth-redirect path', () => {
  reset();
  process.env.GMAIL_CLIENT_ID = 'cid';
  process.env.GMAIL_CLIENT_SECRET = 'secret';
  process.env.GMAIL_REDIRECT_URI = 'https://example.com/api/gmail/oauth-redirect';

  const cfg = getGoogleOAuthConfig('gdrive');
  assert.equal(cfg!.redirectUri, 'https://example.com/api/gdrive/oauth-redirect');
});

test('Gmail derives redirect from Drive when only Drive is configured', () => {
  reset();
  process.env.GDRIVE_CLIENT_ID = 'cid';
  process.env.GDRIVE_CLIENT_SECRET = 'secret';
  process.env.GDRIVE_REDIRECT_URI = 'https://example.com/gdrive-callback.html';

  const cfg = getGoogleOAuthConfig('gmail');
  assert.equal(cfg!.redirectUri, 'https://example.com/gmail-callback.html');
});

test('shared GOOGLE_* credentials are used when no service-specific values exist', () => {
  reset();
  process.env.GOOGLE_CLIENT_ID = 'shared-cid';
  process.env.GOOGLE_CLIENT_SECRET = 'shared-secret';
  process.env.GMAIL_REDIRECT_URI = 'https://example.com/gmail-callback.html';

  const cfg = getGoogleOAuthConfig('gdrive');
  assert.equal(cfg!.clientId, 'shared-cid');
  assert.equal(cfg!.clientSecret, 'shared-secret');
  assert.equal(cfg!.redirectUri, 'https://example.com/gdrive-callback.html');
});

test('service-specific values take precedence over shared and over the other service', () => {
  reset();
  process.env.GMAIL_CLIENT_ID = 'gmail-cid';
  process.env.GMAIL_CLIENT_SECRET = 'gmail-secret';
  process.env.GMAIL_REDIRECT_URI = 'https://example.com/gmail-callback.html';
  process.env.GDRIVE_CLIENT_ID = 'drive-cid';
  process.env.GDRIVE_CLIENT_SECRET = 'drive-secret';
  process.env.GDRIVE_REDIRECT_URI = 'https://example.com/gdrive-callback.html';
  process.env.GOOGLE_CLIENT_ID = 'shared-cid';

  const drive = getGoogleOAuthConfig('gdrive');
  assert.equal(drive!.clientId, 'drive-cid');
  assert.equal(drive!.clientSecret, 'drive-secret');
  assert.equal(drive!.redirectUri, 'https://example.com/gdrive-callback.html');

  const gmail = getGoogleOAuthConfig('gmail');
  assert.equal(gmail!.clientId, 'gmail-cid');
});

test('returns null when redirect URI cannot be derived (unknown path)', () => {
  reset();
  process.env.GMAIL_CLIENT_ID = 'cid';
  process.env.GMAIL_CLIENT_SECRET = 'secret';
  process.env.GMAIL_REDIRECT_URI = 'https://example.com/some-other-path';

  assert.equal(getGoogleOAuthConfig('gdrive'), null);
});
