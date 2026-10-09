import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const calls: Array<{ scope: unknown; operation: string; params?: unknown }> = [];
let failure: Error | undefined;
mock.module('../authBrowser.js', {
  namedExports: {
    resolveBrowserScope: async () => ({ type: 'board', id: 'selected' }),
    browserCommand: async (scope: unknown, operation: string, params: unknown) => {
      calls.push({ scope, operation, params });
      if (failure) throw failure;
      if (operation === 'screenshot')
        return {
          image: 'aGk=',
          mimeType: 'image/jpeg',
          url: 'https://site.test/feed',
          title: 'Feed',
          settled: true,
        };
      return { sessionId: 'existing-session', connected: true, canRead: true, canControl: false };
    },
    navigateBrowser: async (scope: unknown, url: string, _solve: unknown, read = {}) => {
      calls.push({ scope, operation: 'navigate', params: { url, ...read } });
      if (failure) throw failure;
      return { url, text: 'Private page' };
    },
    UNSOLVED_CHALLENGE: 'Unsolved challenge',
  },
});
const { createAuthBrowserMcpServer } = await import('../authBrowserMcp.js');
const server: any = createAuthBrowserMcpServer({ agentId: 'agent', boardId: null });
const call = (name: string, args = {}) => {
  const tool = server._registeredTools[name];
  return (tool.handler || tool.callback)(args, {});
};

test('MCP exposes only existing server session tools and separates agent access from human control', async () => {
  assert.deepEqual(Object.keys(server._registeredTools).sort(), [
    'browser_navigate',
    'browser_read',
    'browser_screenshot',
    'browser_scroll',
    'browser_status',
  ]);
  const result = JSON.parse((await call('browser_status')).content[0].text);
  assert.equal(result.browserLocation, 'server');
  assert.equal(result.canRead, true);
  assert.equal(result.sessionId, 'existing-session');
  assert.equal('canControl' in result, false);
});

test('navigation reuses the resolved scope and a rendering error cannot trigger a new connection', async () => {
  calls.length = 0;
  await call('browser_navigate', { url: 'https://site.test/feed' });
  assert.deepEqual(calls, [
    {
      scope: { type: 'board', id: 'selected' },
      operation: 'navigate',
      params: { url: 'https://site.test/feed' },
    },
  ]);
  calls.length = 0;
  failure = new Error('The server browser did not render readable page content.');
  try {
    const result = await call('browser_read');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /server browser/);
    assert.deepEqual(
      calls.map(c => c.operation),
      ['read']
    );
  } finally {
    failure = undefined;
  }
});

test('read options reach the worker and a screenshot is returned as image content', async () => {
  calls.length = 0;
  await call('browser_navigate', {
    url: 'https://site.test/form',
    format: 'aria',
    wait_for: 'Total',
    wait_ms: 12000,
  });
  await call('browser_read', { format: 'text' });
  assert.deepEqual(
    calls.map(c => c.params),
    [
      { url: 'https://site.test/form', format: 'aria', wait_for: 'Total', wait_ms: 12000 },
      { format: 'text' },
    ]
  );
  const shot = await call('browser_screenshot', { full_page: true });
  assert.equal(calls.at(-1)?.operation, 'screenshot');
  assert.deepEqual(calls.at(-1)?.params, { full_page: true });
  assert.deepEqual(shot.content[0], { type: 'image', data: 'aGk=', mimeType: 'image/jpeg' });
  const page = JSON.parse(shot.content[1].text);
  assert.equal(page.url, 'https://site.test/feed');
  assert.equal('image' in page, false);
});
