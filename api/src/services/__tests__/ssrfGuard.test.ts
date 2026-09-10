// ── The SSRF guard ───────────────────────────────────────────────────────────
//
// assertPublicUrl is what stands between an agent-chosen URL and the internal
// network this API shares with postgres, the runners and mcp-browser. The URLs
// it judges are not typed by an operator — they come out of whatever an agent
// last read — so the interesting cases here are the ones that LOOK public.
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertPublicUrl, isPrivateIPv4, isPrivateIPv6 } from '../../lib/ssrfGuard.js';

async function rejects(url: string, why: string) {
  await assert.rejects(() => assertPublicUrl(url), new RegExp(why, 'i'), `should refuse ${url}`);
}

test('literal private IPv4 targets are refused', async () => {
  for (const url of [
    'http://127.0.0.1:3001/api/health',
    'http://10.0.0.5/',
    'http://192.168.1.50/',
    'http://172.16.0.1/',
    'http://100.64.0.1/', // CGNAT — not covered by "is private" in most libs
    'http://0.0.0.0/',
  ]) {
    await rejects(url, 'private address');
  }
});

test('the cloud metadata endpoint is refused', async () => {
  // The single most valuable SSRF target on a hosted deployment.
  await rejects('http://169.254.169.254/latest/meta-data/', 'private address');
});

test('IPv6 loopback is refused despite the brackets', async () => {
  // URL.hostname keeps the brackets on an IPv6 literal, which net.isIP does not
  // recognise. Before unbracket() this was rejected only because the DNS lookup
  // of the literal string "[::1]" happened to fail.
  await rejects('http://[::1]:3001/', 'private address');
  await rejects('http://[fd00::1]/', 'private address');
  await rejects('http://[::ffff:127.0.0.1]/', 'private address');
});

test('non-http schemes are refused', async () => {
  await rejects('file:///etc/passwd', 'http');
  await rejects('gopher://127.0.0.1:3001/', 'http');
  // WHATWG normalises `http:///x` to `http://x/` — the empty authority is not
  // preserved. It is still refused, just as an unresolvable host rather than a
  // missing one; what matters is that it never reaches a fetch.
  await rejects('http:///nohost', 'could not be resolved');
});

test('unresolvable hosts fail closed', async () => {
  // Not "unknown, therefore fine": a resolver that answers differently at
  // connect time would otherwise pick the target.
  await rejects('http://this-host-does-not-exist.invalid/', 'could not be resolved');
});

test('a public address is allowed', async () => {
  // Literal, so the test needs no DNS and cannot flake offline.
  await assert.doesNotReject(() => assertPublicUrl('https://93.184.216.34/'));
  await assert.doesNotReject(() => assertPublicUrl('http://8.8.8.8/'));
});

test('unparseable addresses read as private, never as public', () => {
  // Fail-closed is the whole contract of these two predicates.
  assert.equal(isPrivateIPv4('not-an-ip'), true);
  assert.equal(isPrivateIPv4('999.1.1.1'), true);
  assert.equal(isPrivateIPv4('10.1'), true);
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('fe80::1'), true);
  // ...and a genuinely public one still reads as public.
  assert.equal(isPrivateIPv4('93.184.216.34'), false);
});
