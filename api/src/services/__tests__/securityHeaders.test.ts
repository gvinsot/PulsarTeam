import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('server index sets restrictive CSP with required connect/style sources', () => {
  const source = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

  assert.ok(source.includes('Content-Security-Policy'));
  assert.ok(
    source.includes(
      "connect-src 'self' wss: ws: https://api.openai.com https://accounts.google.com https://oauth2.googleapis.com https://github.com https://api.github.com https://fonts.googleapis.com https://fonts.gstatic.com"
    )
  );
  assert.ok(source.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"));
});
