/**
 * Symmetric encryption-at-rest helpers (AES-256-GCM).
 *
 * Wire format: `enc:v1:<base64(iv | authTag | ciphertext)>`
 *   - iv:        12 bytes (GCM standard)
 *   - authTag:   16 bytes
 *   - ciphertext: variable length
 *
 * The `enc:v1:` prefix lets callers detect already-encrypted values, keeping
 * writes idempotent.
 *
 * The master key is derived from the `ENCRYPTION_KEY` secret (Docker secret or
 * env var) via HKDF-SHA256 → 32 bytes. Operators MUST set a strong value
 * (>=32 hex chars / 16 bytes of entropy). In production the boot-time check in
 * `secrets.ts` aborts startup if it is missing or known-default.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { readSecret } from '../secrets.js';

export const ENCRYPTION_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_INFO = Buffer.from('pulsarteam-credentials-v1');
const HKDF_SALT = Buffer.from('pulsarteam-static-salt-v1');

let cachedKey: Buffer | null = null;

/**
 * Derive (and cache) the AES-256 key from the `ENCRYPTION_KEY` secret.
 * Uses HKDF-SHA256 so even short operator values yield a uniform 256-bit key.
 *
 * Throws if no key is configured — callers that hit this in production have a
 * misconfigured deployment; callers in dev get a clear actionable error.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = readSecret('ENCRYPTION_KEY');
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set — required to encrypt/decrypt credentials at rest. ' +
      'Generate one with `openssl rand -hex 32` and configure it as a Docker secret.'
    );
  }

  const ikm = Buffer.from(raw, 'utf-8');
  const derived = hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, KEY_LENGTH);
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/** Reset the key cache. Call after rotating ENCRYPTION_KEY in-place. */
export function resetCryptoKeyCache(): void {
  cachedKey = null;
}

/** True if the value matches our wire format (best-effort detection). */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

/**
 * Encrypt a UTF-8 string. Returns the wire-format encoded ciphertext.
 * If the value is already encrypted, returns it unchanged (idempotent).
 * Empty strings are returned unchanged — there's nothing to protect.
 */
export function encryptString(plaintext: string): string {
  if (plaintext === '' || plaintext == null) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ciphertext]);
  return ENCRYPTION_PREFIX + payload.toString('base64');
}

/**
 * Decrypt a wire-format value. Throws if the value is malformed, the auth tag
 * fails, or the key is wrong.
 */
export function decryptString(value: string): string {
  if (!isEncrypted(value)) {
    throw new Error('Value is not in the expected encrypted format');
  }

  const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64');
  if (payload.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted payload too short');
  }

  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);

  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf-8');
}

/**
 * Decrypt a stored value. Returns null/undefined/empty inputs unchanged
 * (nullable columns); any other value must be in the wire format or this
 * throws.
 */
export function tryDecrypt<T extends string | null | undefined>(value: T): T {
  if (value == null || value === '') return value;
  try {
    return decryptString(value as string) as T;
  } catch (err) {
    // Surface the failure rather than silently returning ciphertext — callers
    // would otherwise hand an unusable token to upstream APIs.
    throw new Error(`Failed to decrypt stored value: ${(err as Error).message}`);
  }
}

/**
 * Encrypt the named string fields of an object in-place-ish (returns a shallow
 * clone). Non-string / empty / already-encrypted values are left alone.
 *
 * Intended for JSONB blobs where only a subset of fields are secrets — e.g.
 * `mcp_servers.data.apiKey`, `llm_configs.data.apiKey`.
 */
export function encryptFields<T extends Record<string, any>>(obj: T, fields: readonly string[]): T {
  if (!obj || typeof obj !== 'object') return obj;
  const out: Record<string, any> = { ...obj };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v !== '' && !isEncrypted(v)) {
      out[f] = encryptString(v);
    }
  }
  return out as T;
}

/**
 * Decrypt the named string fields of an object (returns a shallow clone).
 * Non-string / empty fields are skipped (encryptFields skips them on write);
 * non-empty strings must be in the wire format or this throws.
 */
export function decryptFields<T extends Record<string, any>>(obj: T, fields: readonly string[]): T {
  if (!obj || typeof obj !== 'object') return obj;
  const out: Record<string, any> = { ...obj };
  for (const f of fields) {
    const v = out[f];
    if (typeof v !== 'string' || v === '') continue;
    if (!isEncrypted(v)) {
      throw new Error(`Field "${f}" is not in the expected encrypted format`);
    }
    try {
      out[f] = decryptString(v);
    } catch {
      // Leave the encrypted value in place; downstream code will fail loudly
      // when it tries to use it, which is preferable to silent fallthrough.
      // Tolerates rows written with a different ENCRYPTION_KEY by a sibling
      // deployment sharing the same database.
    }
  }
  return out as T;
}

/**
 * Constant-time string comparison. Use whenever comparing secrets (API keys,
 * tokens, signatures) to avoid timing side-channels.
 * Returns false for length mismatches without revealing where they differ.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Generate a cryptographically random hex string (default 32 bytes / 64 hex chars). */
export function generateSecret(byteLength: number = 32): string {
  return randomBytes(byteLength).toString('hex');
}
