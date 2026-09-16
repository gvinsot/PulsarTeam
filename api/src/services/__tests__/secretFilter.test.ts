// Every credential below is synthetic — invented for the test, never a real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findTruncatedSecret, redactSecrets } from '../secretFilter.js';

/** A synthetic PEM block. The body lines are invented markers, never a key. */
function pem(bodyLines: number, opts: { header?: boolean; footer?: boolean } = {}): string {
  const { header = true, footer = true } = opts;
  const lines = Array.from(
    { length: bodyLines },
    (_, i) => `SYNTHETIC_KEY_BODY_${String(i).padStart(3, '0')}`
  );
  if (header) lines.unshift('-----BEGIN PRIVATE KEY-----');
  if (footer) lines.push('-----END PRIVATE KEY-----');
  return lines.join('\n');
}

const LEAKS: Array<[string, string]> = [
  ['Authorization: Bearer SYNTHETIC0123456789abcdef', 'SYNTHETIC0123456789abcdef'],
  ["curl -H 'authorization: token SYNTHETICtoken123456'", 'SYNTHETICtoken123456'],
  ['Open https://example.invalid/device?user_code=SYNTH-0000&state=xyz', 'SYNTH-0000'],
  ['callback https://example.invalid/cb?code=SYNTHETICAUTHCODE', 'SYNTHETICAUTHCODE'],
  ['git remote: https://user:SYNTHETICpass@example.invalid/repo.git', 'SYNTHETICpass'],
  ['export GITHUB_TOKEN=ghp_SYNTHETIC0000000000000000000000', 'ghp_SYNTHETIC'],
  ['{"api_key": "SYNTHETIC-key-value"}', 'SYNTHETIC-key-value'],
  ['ANTHROPIC_API_KEY=sk-ant-SYNTHETIC0123456789', 'sk-ant-SYNTHETIC'],
  ['slack hook xoxb-SYNTHETIC-0000-abcdef', 'xoxb-SYNTHETIC'],
  ['aws key AKIASYNTHETIC00000AA', 'AKIASYNTHETIC00000AA'],
  ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU5USEVUSUMifQ.SYNTHETICsig', 'SYNTHETICsig'],
  [
    '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETICBODY\n-----END RSA PRIVATE KEY-----',
    'SYNTHETICBODY',
  ],
];

for (const [text, leak] of LEAKS) {
  test(`credentials are masked: ${leak}`, () => {
    const cleaned = redactSecrets(text);
    assert.ok(!cleaned.includes(leak), cleaned);
    assert.match(cleaned, /\[redacted\]/);
  });
}

test('ordinary output stays readable', () => {
  const text =
    'Tests passed (42 assertions)\nPushed 3 commits to origin/main\nsee https://example.invalid/pr/7';
  assert.equal(redactSecrets(text), text);
});

test('empty input is returned unchanged', () => {
  assert.equal(redactSecrets(''), '');
});

// ── Quoted values: consumed whole, whatever the quote style ────────────────
//
// The assignment rule used to accept only an optional DOUBLE quote and to stop
// the value at the first space, which left three bypasses open. These mirror
// the Python cases one for one — the two filters must not drift.

const QUOTED: Array<[string, string]> = [
  // Single-quoted shell assignment: previously not matched at all.
  ["API_TOKEN='SYNTHETIC_VALUE_123456'", 'SYNTHETIC_VALUE_123456'],
  ["export api_key='SYNTHETIC_VALUE_123456'", 'SYNTHETIC_VALUE_123456'],
  // Quoted NAME as well as value (Python dict / JSON).
  ["{'password': 'SYNTHETIC_VALUE_123456'}", 'SYNTHETIC_VALUE_123456'],
  ['{"client_secret": "SYNTHETIC_VALUE_123456"}', 'SYNTHETIC_VALUE_123456'],
  // Values containing spaces: previously only the first word was masked.
  ['password="SYNTHETIC FIRST SECOND"', 'FIRST'],
  ["password='SYNTHETIC FIRST SECOND'", 'SECOND'],
  ["PASSWORD = 'SYNTHETIC FIRST SECOND'", 'FIRST'],
  // Escaped quote inside the value must not end it early.
  ['{"password": "SYNTHETIC\\" STILL SECRET"}', 'STILL'],
  // Backtick (JS template / shell substitution).
  ['const token = `SYNTHETIC FIRST SECOND`', 'FIRST'],
  // An unterminated quote runs to end of line rather than leaking the rest.
  ['password="SYNTHETIC FIRST SECOND', 'SECOND'],
];

for (const [text, leak] of QUOTED) {
  test(`quoted values are consumed whole: ${text}`, () => {
    const cleaned = redactSecrets(text);
    assert.ok(!cleaned.includes(leak), cleaned);
    assert.match(cleaned, /\[redacted\]/);
  });
}

test('quoted value masking stops at the closing quote', () => {
  // Over-redaction is fine; swallowing the rest of the line is not.
  const cleaned = redactSecrets('{"password": "SYNTHETIC VALUE", "host": "db.example.invalid"}');
  assert.ok(!cleaned.includes('SYNTHETIC'), cleaned);
  assert.ok(cleaned.includes('db.example.invalid'), cleaned);
});

// ── Truncated private keys ─────────────────────────────────────────────────
//
// A PEM block reaches the filter already cut: tmux renders a bounded pane, the
// broker keeps a ring buffer, the history capture keeps a tail. The paired
// BEGIN…END rule sees none of those fragments.

test('a complete PEM block is masked and not flagged', () => {
  const text = pem(65);
  assert.ok(!redactSecrets(text).includes('SYNTHETIC_KEY_BODY'));
  assert.equal(findTruncatedSecret(text), null);
});

const FRAGMENTS: Array<[string, string, string]> = [
  // Line-limit truncation: the last 60 lines keep the footer, lose the header.
  ['line limit', pem(65).split('\n').slice(-60).join('\n'), 'footer'],
  // Ring-buffer eviction / pane too short: header kept, footer never seen.
  ['evicted tail', pem(65).split('\n').slice(0, 30).join('\n'), 'header'],
  // Both delimiters gone — the middle of a key.
  ['no delimiters', pem(40, { header: false, footer: false }), 'no delimiters'],
];

for (const [label, text, reasonFragment] of FRAGMENTS) {
  test(`truncated PEM fragment is masked and flagged: ${label}`, () => {
    assert.ok(text.includes('SYNTHETIC_KEY_BODY')); // really is readable input
    assert.ok(!redactSecrets(text).includes('SYNTHETIC_KEY_BODY'), redactSecrets(text));
    const reason = findTruncatedSecret(text);
    assert.ok(reason && reason.includes(reasonFragment), String(reason));
  });
}

test('surrounding output survives a truncated key', () => {
  const text = `Deploy finished\n${pem(65).split('\n').slice(-60).join('\n')}`;
  assert.ok(!redactSecrets(text).includes('SYNTHETIC_KEY_BODY'));
});

test('short base64 runs are not treated as key material', () => {
  // Eight lines is the threshold; a couple of hashes must stay readable.
  const text = 'abc123def456abc123def456\ndeadbeefdeadbeefdeadbeef0000';
  assert.equal(redactSecrets(text), text);
  assert.equal(findTruncatedSecret(text), null);
});
