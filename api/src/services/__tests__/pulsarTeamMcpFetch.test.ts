import test from 'node:test';
import assert from 'node:assert/strict';
import { PULSAR_TEAM_MCP_SERVERS } from '../../data/pulsarTeamMcp.js';
import { scopedMcpFetch } from '../pulsarTeamMcpFetch.js';
import { remoteMcpFetch } from '../remoteMcpFetch.js';

test('only canonical API-key surfaces can use the local transport', async t => {
  const requests: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response('{}');
  });
  for (const server of PULSAR_TEAM_MCP_SERVERS) {
    await scopedMcpFetch(server)(server.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer scoped-key' },
      body: '{}',
    });
    const request = requests.at(-1)!;
    assert.equal(request.url, server.url);
    assert.equal(new Headers(request.init?.headers).get('Authorization'), 'Bearer scoped-key');
    assert.equal(request.init?.redirect, 'manual');
    await assert.rejects(scopedMcpFetch(server)(server.url + '/other'), /Unexpected/);
    assert.equal(scopedMcpFetch({ ...server, url: 'http://127.0.0.1/admin' }), remoteMcpFetch);
    assert.equal(scopedMcpFetch({ ...server, id: 'custom' }), remoteMcpFetch);
    assert.equal(scopedMcpFetch({ ...server, remoteAuth: 'oauth' }), remoteMcpFetch);
  }
  assert.equal(requests.length, 3);
});

test('the local transport rejects redirects without forwarding credentials', async t => {
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 302, headers: { Location: 'https://attacker.example' } })
  );
  const server = PULSAR_TEAM_MCP_SERVERS[0];
  await assert.rejects(scopedMcpFetch(server)(server.url), /redirects/);
  assert.equal(fetchMock.mock.callCount(), 1);
});
