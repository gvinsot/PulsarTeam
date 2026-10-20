// ── Web capture (LLM API web_search) ─────────────────────────────────────────
//
// The pages behind a web_search answer are recorded from the Web Browser MCP
// tool calls themselves, never from what the model wrote. These tests pin the
// rules: what counts as a page (search results, and crawls of URLs a previous
// search returned — an injected URL does not count), the entry shape, the
// global dedupe / 100 cap, per-agent isolation, and that the hook in
// mcpManager costs nothing and never fails a tool call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  WEB_CAPTURE_META_KEY,
  beginWebToolCall,
  browserWebMeta,
  normalizeUrl,
  rememberWebMeta,
  startWebCapture,
  toConversationToolEntries,
  trackWebToolCall,
  type WebToolExecution,
} from '../webCapture.js';
import { MCPManager } from '../mcpManager.js';
import { MCPClient } from '../mcpClient.js';
import { createBrowserMcpServer } from '../browserMcp.js';

const BROWSER = 'mcp-browser';

/** A shaped tool result (mcpManager._shape) carrying `response` as web meta. */
function shaped(response: unknown, success = true) {
  const result = { success, result: 'text', images: undefined, raw: [] };
  rememberWebMeta(result, browserWebMeta(response));
  return result;
}

/** Run one tool call through the capture hook, as mcpManager does. */
async function call(agentId: string, tool: string, args: unknown, response: unknown, ok = true) {
  const webCall = beginWebToolCall(agentId, BROWSER, tool, args);
  return trackWebToolCall(webCall, Promise.resolve(shaped(response, ok)));
}

const search = (...urls: string[]) => ({
  content: '# Search Results',
  results: urls.map((url, i) => ({ url, title: `Title ${i}` })),
});

test('normalizeUrl drops fragment and trailing slash, lowercases host, refuses non-http(s)', () => {
  assert.equal(normalizeUrl('https://Example.COM/a/b/#frag'), 'https://example.com/a/b');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('http://example.com/a?q=1#x'), 'http://example.com/a?q=1');
  assert.equal(normalizeUrl('ftp://example.com/'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('//duckduckgo.com/l/?uddg=x'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('search_web results are pages; one entry per call with the query as arguments', async () => {
  const capture = startWebCapture('a-search');
  await call(
    'a-search',
    'search_web',
    { query: 'mistral', extra: 'dropped' },
    {
      content: 'md',
      results: [
        { url: 'https://mistral.ai/', title: 'Mistral AI' },
        { url: 'https://docs.mistral.ai/api', title: 7 },
        { url: 'javascript:alert(1)', title: 'bad' },
        { title: 'no url' },
        'garbage',
      ],
    }
  );
  const executions = capture.stop();
  assert.deepEqual(executions, [
    {
      name: 'web_search',
      tool: 'search_web',
      arguments: '{"query":"mistral"}',
      pages: [
        { url: 'https://mistral.ai/', title: 'Mistral AI' },
        { url: 'https://docs.mistral.ai/api', title: '' },
      ],
    },
  ]);
});

test('a crawl counts only for a URL an earlier search returned (anti-injection)', async () => {
  const capture = startWebCapture('a-inject');
  await call('a-inject', 'search_web', { query: 'q' }, search('https://good.example/article/'));
  // Same page, normalized differently: fragment, no trailing slash, host case.
  await call(
    'a-inject',
    'crawl',
    { url: 'https://GOOD.example/article#top' },
    { url: 'https://GOOD.example/article#top', content: 'page', title: 'Good article' }
  );
  // A URL the model read in a page, never returned by a search.
  await call(
    'a-inject',
    'crawl',
    { url: 'https://evil.example/' },
    { url: 'https://evil.example/', content: 'page' }
  );
  const executions = capture.stop();
  const [, good, evil] = executions;
  assert.deepEqual(good.pages, [
    { url: 'https://GOOD.example/article#top', title: 'Good article' },
  ]);
  assert.deepEqual(evil.pages, [], 'injected URL is not a consulted page');
  assert.equal(evil.arguments, '{}', 'nor kept as arguments');
  const listed = JSON.stringify(toConversationToolEntries(executions));
  assert.ok(!listed.includes('evil.example'), 'and never reaches the conversation');
});

test('a crawl started before the search returned does not count', async () => {
  const capture = startWebCapture('a-race');
  const crawl = beginWebToolCall('a-race', BROWSER, 'crawl', { url: 'https://x.example/' });
  await call('a-race', 'search_web', { query: 'q' }, search('https://x.example/'));
  crawl?.finish(shaped({ url: 'https://x.example/', content: 'page' }));
  const [crawlEntry, searchEntry] = capture.stop();
  assert.deepEqual(crawlEntry.pages, [], 'entries stay in call order; the early crawl has no page');
  assert.equal(searchEntry.pages.length, 1);
});

test('failed calls and legacy shapes give an entry with no pages, never a guess', async () => {
  const capture = startWebCapture('a-fail');
  await call(
    'a-fail',
    'search_web',
    { query: 'q' },
    search('https://a.example/', 'https://b.example/')
  );
  // Failed crawl (FastAPI error) — no page even though the URL is known.
  await call('a-fail', 'crawl', { url: 'https://a.example/' }, { error: 'status=500' });
  await call(
    'a-fail',
    'crawl',
    { url: 'https://a.example/' },
    { url: 'https://a.example/', error: 'x' }
  );
  // Legacy crawl response without "url": the requested URL is not reused.
  await call('a-fail', 'crawl', { url: 'https://a.example/' }, { content: 'page' });
  // MCP-level failure (isError).
  await call(
    'a-fail',
    'extract',
    { url: 'https://a.example/' },
    { url: 'https://a.example/' },
    false
  );
  // Legacy search without "results": the Markdown is never parsed.
  await call('a-fail', 'search_web', { query: 'legacy' }, { content: '[A](https://c.example/)' });
  // A call that throws.
  const thrown = beginWebToolCall('a-fail', BROWSER, 'get_links', { url: 'https://a.example/' });
  await assert.rejects(trackWebToolCall(thrown, Promise.reject(new Error('boom'))), /boom/);
  const executions = capture.stop();
  assert.equal(executions.length, 7);
  assert.deepEqual(
    executions.slice(1).map(e => e.pages),
    [[], [], [], [], [], []]
  );
});

test('crawl_many, extract and get_links pages follow the same rule', async () => {
  const capture = startWebCapture('a-many');
  await call(
    'a-many',
    'search_web',
    { query: 'q' },
    search('https://a.example/', 'https://b.example/x')
  );
  await call(
    'a-many',
    'crawl_many',
    { urls: ['https://a.example/', 'https://b.example/x', 'https://c.example/'] },
    {
      pages: [
        { url: 'https://a.example/', content: 'A' },
        { url: 'https://b.example/x', error: 'timeout' },
        { url: 'https://c.example/', content: 'C' },
      ],
    }
  );
  await call(
    'a-many',
    'extract',
    { url: 'https://b.example/x/', instruction: 'i' },
    { url: 'https://b.example/x/', content: '{}' }
  );
  await call(
    'a-many',
    'get_links',
    { url: 'https://a.example' },
    { url: 'https://a.example', links: {} }
  );
  const [, many, extract, links] = capture.stop();
  assert.deepEqual(many.pages, [{ url: 'https://a.example/', title: '' }]);
  assert.deepEqual(extract.pages, [{ url: 'https://b.example/x/', title: '' }]);
  assert.deepEqual(links.pages, [{ url: 'https://a.example', title: '' }]);
});

test('toConversationToolEntries: one entry per web tool call in call order, URLs deduped across entries', () => {
  const executions: WebToolExecution[] = [
    {
      name: 'web_search',
      tool: 'search_web',
      arguments: '{"query":"a"}',
      pages: [
        { url: 'https://a.example/', title: 'A' },
        { url: 'https://b.example/', title: 'B' },
        { url: 'https://A.example/#dup', title: 'A again' },
      ],
    },
    {
      name: 'web_search',
      tool: 'crawl',
      arguments: '{}',
      pages: [{ url: 'https://a.example', title: '' }],
    },
    {
      name: 'web_search',
      tool: 'search_web',
      arguments: '{"query":"c"}',
      pages: [
        { url: 'https://c.example/', title: 'C' },
        { url: 'https://b.example', title: 'B again' },
      ],
    },
  ];
  assert.deepEqual(toConversationToolEntries(executions), [
    {
      object: 'entry',
      type: 'tool.execution',
      name: 'web_search',
      arguments: '{"query":"a"}',
      info: {
        result: [
          { url: 'https://a.example/', title: 'A' },
          { url: 'https://b.example/', title: 'B' },
        ],
      },
    },
    // The crawl keeps its entry (counted as a search by the client), with no
    // arguments and no page: its URL is already listed above.
    {
      object: 'entry',
      type: 'tool.execution',
      name: 'web_search',
      arguments: '{}',
      info: { result: [] },
    },
    {
      object: 'entry',
      type: 'tool.execution',
      name: 'web_search',
      arguments: '{"query":"c"}',
      info: { result: [{ url: 'https://c.example/', title: 'C' }] },
    },
  ]);
  assert.deepEqual(toConversationToolEntries([]), []);
});

test('toConversationToolEntries reports at most 100 pages in total', () => {
  const pages = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://${prefix}.example/${i}`, title: '' }));
  const entries = toConversationToolEntries([
    { name: 'web_search', tool: 'search_web', arguments: '{}', pages: pages('a', 70) },
    { name: 'web_search', tool: 'search_web', arguments: '{}', pages: pages('b', 70) },
    { name: 'web_search', tool: 'search_web', arguments: '{}', pages: pages('c', 5) },
  ]);
  assert.equal(entries.length, 3, 'every entry is kept');
  assert.deepEqual(
    entries.map(e => e.info.result.length),
    [70, 30, 0]
  );
});

test('captures are isolated per agent and nothing is recorded without one', async () => {
  assert.equal(beginWebToolCall('nobody', BROWSER, 'search_web', {}), null);
  const p = Promise.resolve(1);
  assert.equal(trackWebToolCall(null, p), p, 'no capture: the very same promise');

  const a = startWebCapture('iso-a');
  const b = startWebCapture('iso-b');
  await call('iso-a', 'search_web', { query: 'a' }, search('https://a.example/'));
  await call(
    'iso-b',
    'crawl',
    { url: 'https://a.example/' },
    { url: 'https://a.example/', content: 'x' }
  );
  const fromA = a.stop();
  const fromB = b.stop();
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  assert.deepEqual(fromB[0].pages, [], "agent A's search does not vouch for agent B's crawl");

  // Stopped: no more recording, stop() is idempotent.
  assert.equal(beginWebToolCall('iso-a', BROWSER, 'search_web', {}), null);
  assert.deepEqual(a.stop(), fromA);
});

test('only Web Browser tools of the mcp-browser server are captured', () => {
  const capture = startWebCapture('a-scope');
  assert.equal(beginWebToolCall('a-scope', 'other-server', 'search_web', {}), null);
  assert.equal(beginWebToolCall('a-scope', BROWSER, 'screenshot', {}), null);
  assert.equal(capture.stop().length, 0);
});

test('a new capture replaces the previous one; late results of the old one are dropped', async () => {
  const first = startWebCapture('a-replace');
  const late = beginWebToolCall('a-replace', BROWSER, 'search_web', { query: 'old' });
  const second = startWebCapture('a-replace');
  late?.finish(shaped(search('https://old.example/')));
  await call('a-replace', 'search_web', { query: 'new' }, search('https://new.example/'));
  const old = first.stop();
  assert.equal(old.length, 1);
  assert.deepEqual(old[0].pages, [], 'finished after being replaced: not recorded');
  const current = second.stop();
  assert.deepEqual(
    current.map(e => e.arguments),
    ['{"query":"new"}']
  );
  // Stopping the replaced capture did not end the current one's registration.
  assert.equal(beginWebToolCall('a-replace', BROWSER, 'search_web', {}), null);
});

test('the hook never throws into the tool call', async () => {
  const capture = startWebCapture('a-safe');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const webCall = beginWebToolCall('a-safe', BROWSER, 'search_web', circular);
  assert.ok(webCall);
  for (const bad of [undefined, null, 42, 'x', [], { success: true }]) {
    assert.doesNotThrow(() => webCall.finish(bad));
  }
  const weird = { success: true };
  rememberWebMeta(weird, { [WEB_CAPTURE_META_KEY]: { results: 'not an array' } });
  assert.doesNotThrow(() => webCall.finish(weird));
  const hostile = {
    get [WEB_CAPTURE_META_KEY]() {
      throw new Error('getter');
    },
  };
  assert.doesNotThrow(() => rememberWebMeta({}, hostile));
  const [entry] = capture.stop();
  assert.equal(entry.arguments, '{}', 'unserializable arguments fall back to {}');
  assert.deepEqual(entry.pages, []);
});

test('browserWebMeta projects URLs, titles and success flags, never content', () => {
  assert.equal(browserWebMeta({ content: 'md' }), undefined, 'legacy search: no _meta');
  assert.equal(browserWebMeta(null), undefined);
  assert.equal(browserWebMeta({ error: 'x' }), undefined);
  assert.deepEqual(browserWebMeta({ url: 'https://a.example/', content: 'long page' }), {
    [WEB_CAPTURE_META_KEY]: { url: 'https://a.example/', ok: true },
  });
  assert.deepEqual(
    browserWebMeta({
      pages: [{ url: 'https://a.example/', content: 'A' }, { url: 'u', error: 'e' }, {}],
    }),
    {
      [WEB_CAPTURE_META_KEY]: {
        pages: [
          { url: 'https://a.example/', ok: true },
          { url: 'u', ok: false },
        ],
      },
    }
  );
  assert.deepEqual(browserWebMeta({ content: 'md', results: [] }), {
    [WEB_CAPTURE_META_KEY]: { results: [] },
  });
});

// ── End to end: browserMcp tool → MCP protocol → MCPClient → mcpManager hook ──

async function browserManager() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createBrowserMcpServer().connect(serverTransport);
  const sdkClient = new Client({ name: 'test', version: '1.0.0' });
  await sdkClient.connect(clientTransport);
  const mcpClient = new MCPClient('test');
  mcpClient.client = sdkClient;
  const manager = new MCPManager();
  manager.servers.set(BROWSER, {
    id: BROWSER,
    name: 'Web Browser',
    url: '__internal__browser',
    status: 'connected',
  });
  manager.clients.set(BROWSER, mcpClient);
  return { manager, close: () => sdkClient.close() };
}

test('mcpManager records Web Browser pages end to end, agent output unchanged', async t => {
  const responses: Record<string, unknown> = {
    '/search_web': {
      content: '# Search Results for: q\n\nmarkdown',
      results: [{ url: 'https://1.1.1.1/page', title: 'One' }],
    },
    '/crawl': { url: 'https://1.1.1.1/page', content: 'page markdown' },
  };
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    return new Response(JSON.stringify(responses[path] ?? { error: 'unknown' }), { status: 200 });
  });
  const { manager, close } = await browserManager();
  try {
    // Without a capture: today's behavior.
    const plain = await manager.callToolByNameForAgent(
      'Web Browser',
      'search_web',
      { query: 'q' },
      'e2e'
    );
    assert.equal(plain.success, true);
    assert.equal(plain.result, '# Search Results for: q\n\nmarkdown');
    assert.deepEqual(Object.keys(plain).sort(), ['images', 'raw', 'result', 'success']);
    assert.deepEqual(plain.raw, [{ type: 'text', text: '# Search Results for: q\n\nmarkdown' }]);

    const capture = startWebCapture('e2e');
    const searched = await manager.callToolByNameForAgent(
      'Web Browser',
      'search_web',
      { query: 'q' },
      'e2e'
    );
    assert.deepEqual(searched, plain, 'the agent sees exactly the same result');
    const crawled = await manager.callToolByNameForAgent(
      'Web Browser',
      'crawl',
      { url: 'https://1.1.1.1/page' },
      'e2e'
    );
    assert.equal(crawled.result, 'page markdown');
    // Another agent's calls do not land in this capture.
    await manager.callToolByNameForAgent('Web Browser', 'search_web', { query: 'q' }, 'other');
    const executions = capture.stop();
    assert.deepEqual(executions, [
      {
        name: 'web_search',
        tool: 'search_web',
        arguments: '{"query":"q"}',
        pages: [{ url: 'https://1.1.1.1/page', title: 'One' }],
      },
      {
        name: 'web_search',
        tool: 'crawl',
        arguments: '{}',
        pages: [{ url: 'https://1.1.1.1/page', title: '' }],
      },
    ]);
  } finally {
    await close();
  }
});

test('a failing Web Browser call under capture rejects exactly as without', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('down', { status: 502 }));
  const { manager, close } = await browserManager();
  try {
    const capture = startWebCapture('e2e-fail');
    const result = await manager.callToolByNameForAgent(
      'Web Browser',
      'search_web',
      { query: 'q' },
      'e2e-fail'
    );
    assert.equal(result.success, false);
    assert.match(result.result, /mcp-browser 502/);
    const [entry] = capture.stop();
    assert.deepEqual(entry.pages, []);
  } finally {
    await close();
  }
});
