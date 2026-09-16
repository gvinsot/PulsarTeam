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
 * line is cosmetic, a leaked token is not. Two consequences of that stance are
 * worth spelling out, because both were live bypasses:
 *
 *   • A quoted value is consumed WHOLE — spaces, punctuation and backslash
 *     escapes included. Stopping at the first space left `password="hunter two"`
 *     as `password="[redacted] two"`, and a value quoted with apostrophes
 *     (`API_TOKEN='…'`, `{'password': '…'}`) was not matched at all.
 *   • Key material whose delimiters were cut off is still key material. The PEM
 *     rule needs BEGIN *and* END, so a block truncated by a capture window, a
 *     line limit or a ring-buffer eviction slipped through as readable base64.
 *     Surviving half-delimiters and undelimited key bodies are handled
 *     separately, and callers can ask (via `findTruncatedSecret`) whether the
 *     text carried such a fragment at all.
 */

export const REDACTED = '[redacted]';

// The *name* half of an assignment: a token whose name says it holds a secret.
const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth[_-]?key)[A-Za-z0-9_.-]*';

// The *value* half. Quoted forms (shell, JSON, Python dict, JS template) are
// matched to their closing quote so spaces and escaped quotes stay inside the
// secret; an unterminated quote deliberately runs to end of line rather than
// leaving the remainder readable. The bare form stops at whitespace or a
// statement separator, as before.
const SECRET_VALUE =
  '(?:"(?:\\\\.|[^"\\\\\\r\\n])*"?' +
  "|'(?:\\\\.|[^'\\\\\\r\\n])*'?" +
  '|`(?:\\\\.|[^`\\\\\\r\\n])*`?' +
  '|[^\\s,;]+)';

const RULES: Array<[RegExp, string]> = [
  // PEM blocks — the whole body, not line by line. Fragments that lost a
  // delimiter are handled below, after this rule has taken every COMPLETE
  // block out of the way.
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
  [
    new RegExp(`\\b(authorization|proxy-authorization)(\\s*[:=]\\s*)${SECRET_VALUE}`, 'gi'),
    `$1$2${REDACTED}`,
  ],
  // KEY=value / "key": "value" / {'key': 'value'} where the *name* says it is
  // a secret. The leading and trailing quote groups let the name itself be
  // quoted (JSON, Python dicts) instead of only the value.
  [
    new RegExp(`(['"]?)\\b(${SECRET_NAME})(['"]?\\s*[:=]\\s*)${SECRET_VALUE}`, 'gi'),
    `$1$2$3${REDACTED}`,
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

// ── Truncated key material ─────────────────────────────────────────────────
//
// Terminal text reaches us already shortened: tmux renders a bounded pane, the
// broker keeps a ring buffer, and the history capture keeps a tail. Any of
// those can cut a PEM block's header away and leave its body — perfectly
// readable key material that the paired BEGIN…END rule cannot see.

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
// One line of an encoded key body: base64 or base64url, no spaces, long.
const KEY_BODY_LINE = /^[A-Za-z0-9+/=_-]{20,}$/;
// How many consecutive body-shaped lines make a run key material rather than
// coincidence (hashes, ids, a short base64 blob).
const KEY_BODY_MIN_LINES = 8;

/**
 * Mask around a PEM delimiter left without its counterpart. Complete blocks are
 * already gone by the time this runs, so a surviving footer means the body
 * above it was cut from a key, and a surviving header means the body below it
 * is one.
 */
function maskOrphanDelimiters(text: string): [string, string | null] {
  let out = text;
  let reason: string | null = null;
  const end = PEM_END.exec(out);
  if (end) {
    out = REDACTED + out.slice(end.index + end[0].length);
    reason = 'private-key footer with no header in the captured text';
  }
  const begin = PEM_BEGIN.exec(out);
  if (begin) {
    out = out.slice(0, begin.index) + REDACTED;
    reason = 'private-key header with no footer in the captured text';
  }
  return [out, reason];
}

/**
 * Mask runs of encoded-key-looking lines that carry no delimiter at all — the
 * middle of a key, which no marker-based rule can recognise.
 */
function maskUndelimitedBodies(text: string): [string, string | null] {
  let reason: string | null = null;
  const out: string[] = [];
  let run: string[] = [];

  const flush = () => {
    if (run.length >= KEY_BODY_MIN_LINES) {
      out.push(REDACTED);
      reason = 'encoded key body with no delimiters in the captured text';
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of text.split('\n')) {
    if (KEY_BODY_LINE.test(line.trim())) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return [out.join('\n'), reason];
}

/**
 * Return `[scrubbedText, truncatedSecretReason]`.
 *
 * The reason is non-null when the text carried key material whose extent could
 * not be determined from the text itself (a half-delimited or undelimited PEM
 * body). It is masked either way; the reason lets a caller that cannot vouch
 * for its own input — a bounded terminal capture — withhold the text entirely
 * instead of trusting a heuristic with a private key.
 */
export function scrub(text: string): [string, string | null] {
  if (!text) return [text, null];
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  const [withoutOrphans, orphanReason] = maskOrphanDelimiters(out);
  const [withoutBodies, bodyReason] = maskUndelimitedBodies(withoutOrphans);
  return [withoutBodies, orphanReason || bodyReason];
}

/** Return `text` with every credential-looking substring masked. */
export function redactSecrets(text: string): string {
  return scrub(text)[0];
}

/** Why `text` carries key material that cannot be bounded, or null. */
export function findTruncatedSecret(text: string): string | null {
  return scrub(text)[1];
}
