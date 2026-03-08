import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('server CSP allows Google Fonts and OpenAI realtime connections', async () => {
  const source = await readFile(new URL('../../index.js', import.meta.url), 'utf8');

  assert.match(source, /style-src 'self' 'unsafe-inline' https:\\/\\/fonts\\.googleapis\\.com/);
  assert.match(source, /style-src-elem 'self' 'unsafe-inline' https:\\/\\/fonts\\.googleapis\\.com/);
  assert.match(source, /font-src 'self' data: https:\\/\\/fonts\\.gstatic\\.com/);
  assert.match(source, /connect-src 'self' wss: ws: https:\\/\\/api\\.openai\\.com/);
});

test('client nginx CSP allows Google Fonts and OpenAI realtime connections', async () => {
  const source = await readFile(new URL('../../../../client/nginx.conf', import.meta.url), 'utf8');

  assert.match(source, /style-src 'self' 'unsafe-inline' https:\\/\\/fonts\\.googleapis\\.com/);
  assert.match(source, /style-src-elem 'self' 'unsafe-inline' https:\\/\\/fonts\\.googleapis\\.com/);
  assert.match(source, /font-src 'self' data: https:\\/\\/fonts\\.gstatic\\.com/);
  assert.match(source, /connect-src 'self' ws: wss: https:\\/\\/api\\.openai\\.com/);
});