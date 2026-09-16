/**
 * Credential scrubbing for text captured from an agent terminal.
 *
 * The runner already redacts what it sends (`runner-service/src/secret_filter.py`);
 * this is the second layer, applied before anything is persisted into task
 * history or broadcast over `task:updated`. It matters because a runner can be
 * older than the API, or reached through a provider that never went through the
 * broker at all.
 *
 * The rules mirror the Python ones and deliberately over-redact: a mangled log
 * line is cosmetic, a leaked token is not.
 */

export const REDACTED = '[redacted]';

const RULES: Array<[RegExp, string]> = [
  // PEM blocks — the whole body, not line by line.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Authentication parameters in a URL or query string: ?code=…, &token=…
  [
    /([?&#;](?:access_token|refresh_token|id_token|session_token|token|code|api[_-]?key|apikey|client_secret|secret|password|passwd|pwd|auth|authorization|credential|sig|signature|state|user_code|device_code)=)[^\s&#"'<>]+/gi,
    `$1${REDACTED}`,
  ],
  // Credentials embedded in a URL authority: https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
  // HTTP auth headers and their CLI equivalents: Bearer …, Basic …, token …
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._\-~+/=]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(authorization|proxy-authorization)(\s*[:=]\s*)\S+/gi, `$1$2${REDACTED}`],
  // KEY=value / "key": "value" where the *name* says it is a secret.
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth[_-]?key)[A-Za-z0-9_.-]*)("?\s*[:=]\s*"?)[^\s"',;]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Well-known token shapes, for text that carries no name at all.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  // JWTs (header.payload.signature)
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
];

/** Return `text` with every credential-looking substring masked. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
