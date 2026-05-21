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

// Docker Swarm mounts each secret at /run/secrets/<full-secret-name>. Our stacks
// are named `<env>-pulsarteam` (e.g. `qa-pulsarteam`, `prod-pulsarteam`) or just
// `pulsarteam` when no env is pinned, so secrets show up as
// `/run/secrets/qa-pulsarteam_JWT_SECRET` etc. We try the bare name first (dev /
// `target:` alias) and fall back to the stack-prefixed name.
function stackPrefix(): string {
  const env = process.env.APP_ENVIRONMENT?.trim();
  return env ? `${env}-pulsarteam_` : 'pulsarteam_';
}

export function readSecret(name: string, fallback: string = ''): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  for (const candidate of [name, stackPrefix() + name]) {
    try {
      const value = readFileSync(join(SECRETS_DIR, candidate), 'utf-8').replace(/\n+$/, '');
      cache.set(name, value);
      return value;
    } catch {
      // try next candidate
    }
  }
  return process.env[name] ?? fallback;
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

// Known placeholder values that ship in docker-compose.yml / .env.example for local
// development. Their presence in production means the operator forgot to override
// the secret — we refuse to start rather than expose a publicly-known value.
const KNOWN_DEFAULT_VALUES = new Set<string>([
  'change-me-to-a-random-string',
  'change-me-in-production',
  'changeme',
  'change-me',
  'pulsarteam',
  'swarm2026',
  'admin',
  'password',
  'secret',
]);

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isWeakSecret(value: string, minLength: number): boolean {
  if (!value) return true;
  if (value.length < minLength) return true;
  // Catches deploy tools that store an unsubstituted `${VAR:?...}` template
  // as the secret value instead of failing the deployment.
  if (/^\$\{[^}]+\}$/.test(value)) return true;
  return KNOWN_DEFAULT_VALUES.has(value.toLowerCase());
}

/**
 * Fail-fast validation of secrets that MUST be provided in production. Called once
 * at startup. In dev (NODE_ENV !== 'production') we only warn, so contributors can
 * run `docker-compose up` without configuring every secret.
 *
 * Required production secrets (fatal if missing/weak/unsubstituted):
 *   - JWT_SECRET (>=32 chars, not a known placeholder)
 *   - CODER_API_KEY (>=16 chars — runner ↔ team-api authentication)
 *   - ADMIN_PASSWORD is checked separately in ensureAdminSeeded() (only when seeding)
 *
 * Recommended (warn if weak in prod, ignore in dev):
 *   - ENCRYPTION_KEY
 */
export function validateProductionSecrets(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  const jwt = readSecret('JWT_SECRET');
  if (isWeakSecret(jwt, 32)) {
    errors.push(
      'JWT_SECRET is missing, too short (<32 chars), or set to a known default placeholder. ' +
      'Generate a random value (e.g. `openssl rand -hex 48`) and set it as a Docker secret.'
    );
  }

  const coderKey = readSecret('CODER_API_KEY');
  if (isWeakSecret(coderKey, 16)) {
    errors.push(
      'CODER_API_KEY is missing, too short (<16 chars), or set to a known default placeholder. ' +
      'Generate a random value (e.g. `openssl rand -hex 32`) and set it as a Docker secret. ' +
      'Runner services authenticate API calls with this key — without it, every /v1/chat/completions request fails with 403.'
    );
  }

  const encKey = readSecret('ENCRYPTION_KEY');
  if (isWeakSecret(encKey, 32)) {
    warnings.push(
      'ENCRYPTION_KEY is missing, too short (<32 chars), or a known default. ' +
      'Required to encrypt OAuth tokens, LLM API keys, and MCP credentials at rest. ' +
      'Generate one with `openssl rand -hex 32` and configure it as a Docker secret.'
    );
  }

  if (errors.length === 0 && warnings.length === 0) return;

  const banner = '='.repeat(72);

  if (isProduction()) {
    // In production, every issue is fatal so an operator can't accidentally ship
    // a system with a publicly-known JWT signing key or runner API key.
    const all = [...errors, ...warnings];
    console.error('');
    console.error(banner);
    console.error('  FATAL: insecure secret configuration detected (NODE_ENV=production)');
    for (const e of all) console.error(`  - ${e}`);
    console.error(banner);
    console.error('');
    process.exit(1);
  }

  // Dev: warn but keep going.
  console.warn('');
  console.warn(banner);
  console.warn('  WARNING: weak/default secrets detected (dev mode)');
  for (const e of errors) console.warn(`  - ${e}`);
  for (const w of warnings) console.warn(`  - ${w}`);
  console.warn(banner);
  console.warn('');
}
