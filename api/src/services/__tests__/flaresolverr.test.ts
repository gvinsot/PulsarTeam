import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { solveCloudflare } from '../flaresolverr.js';
import { navigateBrowser } from '../authBrowser.js';

// A public IP literal: assertPublicUrl then needs no DNS.
const ORIGIN = 'https://93.184.215.14';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/133.0.0.0 Safari/537.36';
const SOLVED = {
  status: 'ok',
  solution: {
    url: `${ORIGIN}/`,
    userAgent: UA,
    cookies: [
      { name: 'cf_clearance', value: 'solved', expiry: 1893456000, domain: '.site' },
      { name: 'session', value: 'someone-else', domain: '.site' },
      { name: '__cf_bm', value: 'bm' },
      { name: 'cf_clearance', value: 'duplicate' },
    ],
  },
};

function stubFetch(routes: Record<string, (body: any) => unknown>) {
  const calls: { url: string; body: any }[] = [];
  const stub = mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    calls.push({ url: String(url), body });
    const handler = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    assert.ok(handler, `unexpected fetch ${String(url)}`);
    return new Response(JSON.stringify(handler[1](body)), { status: 200 });
  });
  return { calls, restore: () => stub.mock.restore() };
}

test('solver is asked for the site root only and returns Cloudflare cookies only', async () => {
  delete process.env.FLARESOLVERR_URL;
  assert.equal(await solveCloudflare(ORIGIN), null);
  process.env.FLARESOLVERR_URL = 'http://flaresolverr:8191/v1';
  const net = stubFetch({ 'http://flaresolverr': () => SOLVED });
  try {
    assert.deepEqual(await solveCloudflare(ORIGIN), {
      userAgent: UA,
      cookies: [
        { name: 'cf_clearance', value: 'solved', expires: 1893456000 },
        { name: '__cf_bm', value: 'bm', expires: -1 },
      ],
    });
    assert.deepEqual(net.calls[0].body, {
      cmd: 'request.get',
      url: `${ORIGIN}/`,
      maxTimeout: 60_000,
    });
    assert.equal(await solveCloudflare('https://10.0.0.1'), null, 'private origin');
    assert.equal(net.calls.length, 1, 'a private origin never reaches the solver');
  } finally {
    net.restore();
  }
  for (const answer of [
    { status: 'error', message: 'timeout' },
    { ...SOLVED, solution: { ...SOLVED.solution, url: 'https://elsewhere.test/' } },
    { ...SOLVED, solution: { ...SOLVED.solution, cookies: [{ name: '__cf_bm', value: 'x' }] } },
  ]) {
    const other = stubFetch({ 'http://flaresolverr': () => answer });
    try {
      assert.equal(await solveCloudflare(ORIGIN), null);
    } finally {
      other.restore();
    }
  }
});

test('a challenged navigation is cleared once, then reported when unsolved', async () => {
  process.env.AUTH_BROWSER_KEY = 'test-browser-key-with-at-least-32-characters';
  process.env.FLARESOLVERR_URL = 'http://flaresolverr:8191/v1';
  const url = `${ORIGIN}/private/page?x=1`;
  const net = stubFetch({
    'http://mcp-auth-browser': body =>
      body.operation === 'navigate' ? { challenge: true } : { title: 'Private page' },
    'http://flaresolverr': () => SOLVED,
  });
  try {
    const page = await navigateBrowser<{ title?: string }>({ type: 'agent', id: 'a' }, url);
    assert.equal(page.title, 'Private page');
    const [, solver, clearance] = net.calls;
    assert.equal(solver.body.url, `${ORIGIN}/`, 'the path never reaches the solver');
    assert.equal(clearance.body.operation, 'clearance');
    assert.equal(clearance.body.url, url);
    assert.equal(clearance.body.user_agent, UA);
    assert.deepEqual(
      clearance.body.cookies.map((c: { name: string }) => c.name),
      ['cf_clearance', '__cf_bm']
    );
  } finally {
    net.restore();
  }
  const unsolved = stubFetch({
    'http://mcp-auth-browser': () => ({ challenge: true }),
    'http://flaresolverr': () => ({ status: 'error' }),
  });
  try {
    const page = await navigateBrowser({ type: 'agent', id: 'a' }, url);
    assert.equal(page.challenge, true);
    assert.equal(unsolved.calls.filter(c => c.body.operation === 'clearance').length, 0);
  } finally {
    unsolved.restore();
  }
});
