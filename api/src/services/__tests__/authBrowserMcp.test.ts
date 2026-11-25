import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const uploads: Array<{ scope: unknown; params: unknown; filename: string; bytes: string }> = [];
mock.module('../authBrowserUpload.js', {
  namedExports: {
    publicBrowserUpload: async () => {
      throw new Error('unexpected external source');
    },
    uploadBrowserFile: async (
      scope: unknown,
      params: unknown,
      file: { filename: string; body: ReadableStream<Uint8Array> }
    ) => {
      uploads.push({
        scope,
        params,
        filename: file.filename,
        bytes: await new Response(file.body).text(),
      });
      return { actionPerformed: true };
    },
  },
});

const calls: Array<{ scope: unknown; operation: string; params?: unknown }> = [];
const targets: Array<string | undefined> = [];
let failure: Error | undefined;
mock.module('../authBrowser.js', {
  namedExports: {
    resolveBrowserTarget: async (_agent: unknown, _board: unknown, site?: string) => {
      targets.push(site);
      return { scope: { type: 'board', id: 'selected' }, site: 'https://site.test' };
    },
    sharedBrowserSites: async () => [
      {
        scope: { type: 'board', id: 'selected' },
        status: {
          site: 'https://site.test',
          sessionId: 'existing-session',
          connected: true,
          canRead: true,
          canControl: false,
        },
      },
    ],
    browserCommand: async (scope: unknown, operation: string, params: unknown) => {
      calls.push({ scope, operation, params });
      if (failure) throw failure;
      if (operation === 'pdf')
        return {
          pdf: Buffer.from('%PDF-1.4').toString('base64'),
          url: 'https://site.test/invoice',
          title: 'Invoice 42',
        };
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
    'browser_click',
    'browser_fill',
    'browser_navigate',
    'browser_press',
    'browser_read',
    'browser_save_pdf',
    'browser_screenshot',
    'browser_scroll',
    'browser_select',
    'browser_status',
    'browser_upload',
    'browser_upload_sources',
  ]);
  const result = JSON.parse((await call('browser_status')).content[0].text);
  assert.equal(result.browserLocation, 'server');
  assert.equal(result.sites.length, 1);
  assert.equal(result.sites[0].site, 'https://site.test');
  assert.equal(result.sites[0].canRead, true);
  assert.equal('canControl' in result.sites[0], false);
});

test('agent actions retain the selected session and warn against blind retries', async () => {
  calls.length = 0;
  const target = { by: 'role', value: 'button', name: 'Publish' };
  await call('browser_click', { site: 'https://site.test', target });
  assert.deepEqual(calls.at(-1), {
    scope: { type: 'board', id: 'selected' },
    operation: 'agent_click',
    params: { target, site: 'https://site.test' },
  });
  failure = new Error('Timed out');
  try {
    const result = await call('browser_click', { target });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /may have taken effect/);
    assert.equal(calls.length, 2, 'never retries the click');
  } finally {
    failure = undefined;
  }
});

test('uploads resolve bytes only on the current task, never an agent-named task or path', async () => {
  let current: string | null = 'current-task';
  const reads: string[][] = [];
  const uploadServer = createAuthBrowserMcpServer(
    { agentId: 'agent', boardId: null },
    {
      currentTaskId: async () => current,
      attach: async () => {
        throw new Error('unused');
      },
      list: async () => [{ attachment_id: 'video', filename: '12-vache.mp4', size: 5 }],
      read: async (taskId, id) => {
        reads.push([taskId, id]);
        return id === 'video' ? { filename: '12-vache.mp4', data: Buffer.from('video') } : null;
      },
    }
  );
  const client = new Client({ name: 'upload-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await uploadServer.connect(serverTransport);
  await client.connect(clientTransport);
  const invoke = (args: Record<string, unknown>) =>
    client.callTool({ name: 'browser_upload', arguments: args });
  const target = { by: 'css', value: 'input[type=file]' };
  try {
    uploads.length = 0;
    assert.equal((await invoke({ target, attachment_id: 'video' })).isError, undefined);
    assert.deepEqual(reads, [['current-task', 'video']]);
    assert.equal(uploads[0].bytes, 'video');
    assert.equal(uploads[0].filename, '12-vache.mp4');
    assert.equal((await invoke({ target, attachment_id: 'other-task-file' })).isError, true);
    assert.equal(
      (await invoke({ target, attachment_id: 'video', source_url: 'https://example.com/video' }))
        .isError,
      true
    );
    assert.equal((await invoke({ target })).isError, true);
    current = null;
    assert.equal((await invoke({ target, attachment_id: 'video' })).isError, true);
    assert.equal(uploads.length, 1);
  } finally {
    await client.close();
    await uploadServer.close();
  }
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
      { format: 'text', site: 'https://site.test' },
    ]
  );
  const shot = await call('browser_screenshot', { full_page: true });
  assert.equal(calls.at(-1)?.operation, 'screenshot');
  assert.deepEqual(calls.at(-1)?.params, {
    full_page: true,
    section: undefined,
    site: 'https://site.test',
  });
  await call('browser_screenshot', { full_page: true, section: 3 });
  assert.deepEqual(calls.at(-1)?.params, {
    full_page: true,
    section: 3,
    site: 'https://site.test',
  });
  assert.deepEqual(shot.content[0], { type: 'image', data: 'aGk=', mimeType: 'image/jpeg' });
  const page = JSON.parse(shot.content[1].text);
  assert.equal(page.url, 'https://site.test/feed');
  assert.equal('image' in page, false);
});

test('a PDF is attached to the agent current task only, never without one', async () => {
  const attached: any[] = [];
  let current: string | null = 'task-7';
  const withTask: any = createAuthBrowserMcpServer(
    { agentId: 'agent', boardId: null },
    {
      currentTaskId: async (agentId: string) => (agentId === 'agent' ? current : null),
      attach: async (input: any) => {
        attached.push(input);
        return { id: 'att-1', filename: input.filename, size: input.data.length };
      },
    }
  );
  const save = (args = {}) => {
    const tool = withTask._registeredTools.browser_save_pdf;
    return (tool.handler || tool.callback)(args, {});
  };
  calls.length = 0;
  const result = JSON.parse((await save({ media: 'print' })).content[0].text);
  assert.deepEqual(calls.at(-1)?.params, { media: 'print', site: 'https://site.test' });
  assert.equal(attached[0].taskId, 'task-7');
  assert.equal(attached[0].filename, 'Invoice 42.pdf');
  assert.equal(attached[0].data.toString(), '%PDF-1.4');
  assert.deepEqual(result, {
    taskId: 'task-7',
    attachmentId: 'att-1',
    filename: 'Invoice 42.pdf',
    size: 8,
    url: 'https://site.test/invoice',
  });
  await save({ filename: 'releve.PDF' });
  assert.equal(attached[1].filename, 'releve.pdf');

  current = null;
  calls.length = 0;
  const refused = await save();
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /No current task/);
  assert.equal(calls.length, 0, 'no PDF is rendered without a task to hold it');
  const noAgent = await call('browser_save_pdf');
  assert.equal(noAgent.isError, true);
});

test('the site an agent names (or the navigated URL) picks the website session', async () => {
  targets.length = 0;
  await call('browser_read', { site: 'https://other.test/' });
  await call('browser_scroll', { site: 'https://other.test/', delta: 300 });
  await call('browser_navigate', { url: 'https://third.test/inbox' });
  await call('browser_read');
  assert.deepEqual(targets, [
    'https://other.test/',
    'https://other.test/',
    'https://third.test/inbox',
    undefined,
  ]);
});
