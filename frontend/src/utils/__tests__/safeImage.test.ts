import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSafeImageMediaType, openImageInNewTab, safeImageDataUrl } from '../safeImage';

const PNG_B64 = 'iVBORw0KGgo=';

test('normalizeSafeImageMediaType only accepts raster image types', () => {
  assert.equal(normalizeSafeImageMediaType('image/png'), 'image/png');
  assert.equal(normalizeSafeImageMediaType(' IMAGE/JPEG '), 'image/jpeg');
  assert.equal(normalizeSafeImageMediaType('text/html'), null);
  assert.equal(normalizeSafeImageMediaType('image/svg+xml'), null);
  assert.equal(normalizeSafeImageMediaType('image/png;base64,PHNjcmlwdD4=#'), null);
  assert.equal(normalizeSafeImageMediaType(undefined), null);
});

test('safeImageDataUrl builds data URLs only for safe images', () => {
  assert.equal(
    safeImageDataUrl({ mediaType: 'image/png', data: PNG_B64 }),
    `data:image/png;base64,${PNG_B64}`
  );
  assert.equal(
    safeImageDataUrl({ mediaType: 'text/html', data: 'PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }),
    null
  );
  assert.equal(safeImageDataUrl({ mediaType: 'image/png', data: 'abc"><script>' }), null);
  assert.equal(safeImageDataUrl({ mediaType: 'image/png', data: '' }), null);
  assert.equal(safeImageDataUrl(null), null);
});

test('safeImageDataUrl validates preview and falls back to mediaType/data', () => {
  const preview = `data:image/webp;base64,${PNG_B64}`;
  assert.equal(safeImageDataUrl({ preview }), preview);
  assert.equal(
    safeImageDataUrl({ preview: 'javascript:alert(1)', mediaType: 'image/png', data: PNG_B64 }),
    `data:image/png;base64,${PNG_B64}`
  );
  assert.equal(safeImageDataUrl({ preview: 'data:text/html;base64,PGgxPg==' }), null);
});

test('openImageInNewTab refuses unsafe types and opens a typed blob for images', () => {
  const opened: unknown[][] = [];
  const created: Blob[] = [];
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevCreate = URL.createObjectURL;
  g.window = { open: (...args: unknown[]) => opened.push(args) };
  URL.createObjectURL = (b: Blob) => {
    created.push(b);
    return 'blob:test';
  };
  const prevSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
  try {
    assert.equal(openImageInNewTab({ mediaType: 'text/html', data: 'PGgxPg==' }), false);
    assert.equal(opened.length, 0);
    assert.equal(openImageInNewTab({ mediaType: 'image/png', data: PNG_B64 }), true);
    assert.deepEqual(opened, [['blob:test', '_blank', 'noopener,noreferrer']]);
    assert.equal(created[0].type, 'image/png');
  } finally {
    g.window = prevWindow;
    URL.createObjectURL = prevCreate;
    globalThis.setTimeout = prevSetTimeout;
  }
});
