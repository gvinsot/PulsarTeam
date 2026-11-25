import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateRemoteUrl } from '../remoteMcpFetch.js';

let sourceResponse = () => new Response('video-bytes');
const sourceCalls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
const checked: string[] = [];
mock.module('../remoteMcpFetch.js', {
  namedExports: {
    validateRemoteUrl,
    remoteMcpFetch: async (url: unknown, init?: RequestInit) => {
      sourceCalls.push({ url, init });
      return sourceResponse();
    },
  },
});
mock.module('../../lib/ssrfGuard.js', {
  namedExports: {
    assertPublicUrl: async (url: string) => {
      checked.push(url);
    },
  },
});
const { publicBrowserUpload, uploadBrowserFile, BROWSER_UPLOAD_MAX_BYTES } =
  await import('../authBrowserUpload.js');

test('HTTPS upload sources have no credentials and reject private URLs before fetching', async () => {
  for (const url of [
    'file:///etc/passwd',
    'http://example.com/file',
    'https://127.0.0.1/file',
    'https://u:p@example.com/file',
  ]) {
    await assert.rejects(publicBrowserUpload(url));
  }
  assert.equal(sourceCalls.length, 0);
  const file = await publicBrowserUpload('https://example.com/12-vache.mp4');
  assert.equal(file.filename, '12-vache.mp4');
  assert.equal(await new Response(file.body).text(), 'video-bytes');
  assert.deepEqual(checked, ['https://example.com/12-vache.mp4']);
  assert.equal(sourceCalls[0].init?.headers, undefined);
  sourceResponse = () =>
    new Response('too large', {
      headers: { 'content-length': String(BROWSER_UPLOAD_MAX_BYTES + 1) },
    });
  await assert.rejects(publicBrowserUpload('https://example.com/large'), /250 MB/);
});

test('binary upload fixes the worker scope, preserves bytes and hides worker diagnostics', async () => {
  const previous = process.env.AUTH_BROWSER_KEY;
  process.env.AUTH_BROWSER_KEY = 'x'.repeat(32);
  const uploads: Array<{ params: Record<string, unknown>; bytes: string }> = [];
  let fail = false;
  const fetch = mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    if (fail) return new Response('private-token-do-not-leak', { status: 502 });
    const headers = new Headers(options.headers);
    assert.equal(options.redirect, 'error');
    assert.equal(headers.get('authorization'), `Bearer ${'x'.repeat(32)}`);
    uploads.push({
      params: JSON.parse(Buffer.from(headers.get('x-browser-command') || '', 'base64').toString()),
      bytes: await new Response(options.body).text(),
    });
    return Response.json({ actionPerformed: true });
  });
  const file = () => ({
    filename: 'video.mp4',
    body: new Response('exact-video-bytes').body as ReadableStream<Uint8Array>,
  });
  try {
    await uploadBrowserFile(
      { type: 'board', id: 'chosen' },
      { scope: 'board:other', operation: 'start', site: 'https://site.test' },
      file()
    );
    assert.equal(uploads[0].params.scope, 'board:chosen');
    assert.equal(uploads[0].params.operation, 'agent_upload');
    assert.equal(uploads[0].bytes, 'exact-video-bytes');
    fail = true;
    await assert.rejects(
      uploadBrowserFile({ type: 'board', id: 'chosen' }, {}, file()),
      e =>
        e instanceof Error &&
        /not confirmed/.test(e.message) &&
        !e.message.includes('private-token')
    );
  } finally {
    fetch.mock.restore();
    if (previous === undefined) delete process.env.AUTH_BROWSER_KEY;
    else process.env.AUTH_BROWSER_KEY = previous;
  }
});

test('streaming upload enforces the cap even without a content-length', async () => {
  const previous = process.env.AUTH_BROWSER_KEY;
  process.env.AUTH_BROWSER_KEY = 'x'.repeat(32);
  const fetch = mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const reader = new Response(options.body).body?.getReader();
    assert.ok(reader);
    while (!(await reader.read()).done) {
      /* discard bytes without buffering */
    }
    return Response.json({ actionPerformed: true });
  });
  let remaining = 251;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(chunk);
      else controller.close();
    },
  });
  try {
    await assert.rejects(
      uploadBrowserFile({ type: 'agent', id: 'a' }, {}, { filename: 'large.mp4', body }),
      /250 MB/
    );
  } finally {
    fetch.mock.restore();
    if (previous === undefined) delete process.env.AUTH_BROWSER_KEY;
    else process.env.AUTH_BROWSER_KEY = previous;
  }
});
