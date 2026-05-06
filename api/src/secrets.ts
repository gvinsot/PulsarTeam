/**
 * Read Docker Swarm secrets directly from /run/secrets/<NAME>.
 *
 * The deployment system mounts every env var matching `*_SECRET`, `*_KEY`,
 * `*_TOKEN`, or `*_PASSWORD` as a file under `/run/secrets/`. Code that needs
 * those values calls `readSecret("JWT_SECRET")` instead of touching
 * `process.env` — that way the secret never has to transit through
 * environment variables, where it would be visible to anything with access
 * to /proc/<pid>/environ or to `docker inspect`.
 *
 * For local development (no /run/secrets directory), the helper falls back
 * transparently to the env var of the same name, then to the supplied default.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SECRETS_DIR = '/run/secrets';
const cache = new Map<string, string>();

export function readSecret(name: string, fallback: string = ''): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  try {
    const value = readFileSync(join(SECRETS_DIR, name), 'utf-8').replace(/\n+$/, '');
    cache.set(name, value);
    return value;
  } catch {
    return process.env[name] ?? fallback;
  }
}

/** Returns undefined when the secret is unset (instead of empty string). */
export function readSecretOptional(name: string): string | undefined {
  const v = readSecret(name, '');
  return v === '' ? undefined : v;
}

/** Drop one or all cached values (use after a secret has been rotated in-place). */
export function invalidateSecret(name?: string): void {
  if (name === undefined) cache.clear();
  else cache.delete(name);
}
