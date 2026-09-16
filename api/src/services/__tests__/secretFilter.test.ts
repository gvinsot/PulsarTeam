// Every credential below is synthetic — invented for the test, never a real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../secretFilter.js';

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
