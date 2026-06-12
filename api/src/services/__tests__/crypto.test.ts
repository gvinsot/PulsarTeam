/**
 * Tests for the at-rest encryption helpers (lib/crypto.ts).
 *
 * Covers: roundtrip, idempotency, tampering detection (auth tag failure),
 * key rotation cache reset, JSONB field helpers, and constant-time compare.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';

// Configure ENCRYPTION_KEY before importing the module under test — getKey()
// caches the derived key on first use.
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');

const {
  encryptString,
  decryptString,
  isEncrypted,
  tryDecrypt,
  encryptFields,
  decryptFields,
  constantTimeEquals,
  resetCryptoKeyCache,
  ENCRYPTION_PREFIX,
} = await import('../../lib/crypto.js');

test('encryptString → decryptString roundtrip preserves UTF-8 plaintext', () => {
  const plaintext = 'sk-ant-api03-abcdef-éàü€-🔒';
  const ct = encryptString(plaintext);
  assert.notEqual(ct, plaintext);
  assert.ok(ct.startsWith(ENCRYPTION_PREFIX));
  assert.equal(decryptString(ct), plaintext);
});

test('encryptString produces different ciphertext for the same plaintext (random IV)', () => {
  const a = encryptString('same-secret');
  const b = encryptString('same-secret');
  assert.notEqual(a, b);
  assert.equal(decryptString(a), 'same-secret');
  assert.equal(decryptString(b), 'same-secret');
});

test('encryptString is idempotent — already-encrypted values pass through unchanged', () => {
  const ct = encryptString('plain');
  const reEncrypted = encryptString(ct);
  assert.equal(reEncrypted, ct);
});

test('tryDecrypt rejects plaintext values and passes through null/empty', () => {
  assert.throws(() => tryDecrypt('plain-value'), /Failed to decrypt stored value/);
  assert.equal(tryDecrypt(null), null);
  assert.equal(tryDecrypt(''), '');
});

test('tryDecrypt decrypts wire-format values', () => {
  const ct = encryptString('secret-token');
  assert.equal(tryDecrypt(ct), 'secret-token');
});

test('decryptString rejects tampered ciphertext (auth tag failure)', () => {
  const ct = encryptString('do-not-tamper');
  // Flip a byte inside the ciphertext portion
  const payload = Buffer.from(ct.slice(ENCRYPTION_PREFIX.length), 'base64');
  payload[payload.length - 1] ^= 0x01;
  const tampered = ENCRYPTION_PREFIX + payload.toString('base64');
  assert.throws(() => decryptString(tampered));
});

test('decryptString rejects truncated payload', () => {
  assert.throws(() => decryptString(`${ENCRYPTION_PREFIX}AAAA`));
});

test('decryptString rejects values without the wire-format prefix', () => {
  assert.throws(() => decryptString('plaintext'), /not in the expected encrypted format/);
});

test('isEncrypted detects wire-format values', () => {
  assert.equal(isEncrypted(encryptString('x')), true);
  assert.equal(isEncrypted('plain'), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(123), false);
});

test('encryptFields/decryptFields roundtrip on JSONB blobs', () => {
  const config = { id: 'llm-1', name: 'Anthropic', apiKey: 'sk-ant-secret', model: 'claude' };
  const enc = encryptFields(config, ['apiKey']);
  assert.equal(enc.name, 'Anthropic');
  assert.equal(enc.model, 'claude');
  assert.notEqual(enc.apiKey, 'sk-ant-secret');
  assert.ok(isEncrypted(enc.apiKey));
  const dec = decryptFields(enc, ['apiKey']);
  assert.equal(dec.apiKey, 'sk-ant-secret');
});

test('encryptFields skips empty / already-encrypted / non-string values', () => {
  const obj = { apiKey: '', token: encryptString('already'), num: 42 } as any;
  const enc = encryptFields(obj, ['apiKey', 'token', 'num']);
  assert.equal(enc.apiKey, '');
  assert.equal(enc.token, obj.token); // unchanged
  assert.equal(enc.num, 42);
});

test('decryptFields rejects non-encrypted string values, skips empty/non-string', () => {
  assert.throws(() => decryptFields({ apiKey: 'plain-secret' }, ['apiKey']), /not in the expected encrypted format/);
  const out = decryptFields({ apiKey: '', num: 42 } as any, ['apiKey', 'num']);
  assert.equal(out.apiKey, '');
  assert.equal(out.num, 42);
});

test('key rotation: resetCryptoKeyCache + new ENCRYPTION_KEY yields different output', () => {
  const ct1 = encryptString('rotation-test');
  // Rotate key in place (operator-driven)
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  resetCryptoKeyCache();
  // Old ciphertext must fail to decrypt under the new key
  assert.throws(() => decryptString(ct1));
  // New encryptions still roundtrip
  const ct2 = encryptString('rotation-test');
  assert.equal(decryptString(ct2), 'rotation-test');
});

test('constantTimeEquals: equal strings → true, differing strings → false, length mismatch → false', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abd'), false);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
  assert.equal(constantTimeEquals('', ''), true);
});
