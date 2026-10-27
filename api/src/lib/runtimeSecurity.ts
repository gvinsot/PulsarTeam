/**
 * Runtime security checks for the Node.js process itself.
 *
 * CVE-2026-111497 ("Node2Shell"): out-of-bounds write in the Brotli decoder
 * bundled with Node.js, reachable whenever the process decompresses attacker
 * controlled Brotli data — notably `fetch()` responses from untrusted servers
 * (undici decodes `Content-Encoding: br` transparently) and `node:zlib`.
 * Fixed in 22.23.4, 24.22.1 and 26.12.1; every other line is end of life.
 */
import type { RequestHandler } from 'express';

type Version = [number, number, number];

/** First patched release for each supported major line. */
const PATCHED_RELEASES: Record<number, Version> = {
  22: [22, 23, 4],
  24: [24, 22, 1],
  26: [26, 12, 1],
};

function parseVersion(version: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * True when `version` carries the Node2Shell fix. Majors above the newest known
 * line are assumed patched (they branch off a fixed tree); unknown or EOL
 * majors (≤21, 23, 25) are not.
 */
export function isBrotliPatchedNodeVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major] = parsed;
  const newestMajor = Math.max(...Object.keys(PATCHED_RELEASES).map(Number));
  if (major > newestMajor) return true;
  const minimum = PATCHED_RELEASES[major];
  if (!minimum) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== minimum[i]) return parsed[i] > minimum[i];
  }
  return true;
}

/**
 * Refuse to start a production server on a runtime vulnerable to
 * CVE-2026-111497; elsewhere only warn so local tooling keeps working.
 */
export function assertPatchedRuntime(
  version: string = process.version,
  isProduction: boolean = process.env.NODE_ENV === 'production'
): void {
  if (isBrotliPatchedNodeVersion(version)) return;
  const message =
    `Node.js ${version} is vulnerable to CVE-2026-111497 (Node2Shell, Brotli RCE). ` +
    'Upgrade to 22.23.4, 24.22.1, 26.12.1 or later.';
  if (isProduction) throw new Error(message);
  console.warn(`[security] ${message}`);
}

/**
 * Reject Brotli-encoded request bodies. body-parser 1.x already answers 415 for
 * `br`, but body-parser 2.x / Express 5 decode it by default — this keeps the
 * inbound path closed regardless of the parser version.
 */
export const rejectBrotliRequestBodies: RequestHandler = (req, res, next) => {
  const encoding = req.headers['content-encoding'];
  if (encoding && /(^|,)\s*br\s*(,|$)/i.test(encoding)) {
    res.status(415).json({ error: 'Unsupported Content-Encoding: br' });
    return;
  }
  next();
};
