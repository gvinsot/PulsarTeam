import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCorsOptions,
  getCorsOrigins,
  isOriginAllowed,
  logRejectedOrigin,
  validateCorsConfig,
  _resetRejectionLogCache,
} from '../../middleware/corsConfig.js';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) before[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('getCorsOrigins parses a comma-separated list and trims whitespace', () => {
  withEnv({ CORS_ORIGINS: 'https://a.example.com, https://b.example.com ,https://c.example.com' }, () => {
    assert.deepEqual(getCorsOrigins(), [
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });
});

test('getCorsOrigins falls back to localhost defaults when CORS_ORIGINS is unset', () => {
  withEnv({ CORS_ORIGINS: undefined, NODE_ENV: 'development' }, () => {
    const o = getCorsOrigins();
    assert.ok(o.includes('http://localhost:5173'));
    assert.ok(o.includes('http://localhost:3000'));
  });
});

test('isOriginAllowed permits requests with no Origin header (server-to-server)', () => {
  assert.equal(isOriginAllowed(undefined, ['https://app.example.com']), true);
  assert.equal(isOriginAllowed('', ['https://app.example.com']), true);
});

test('isOriginAllowed accepts an exact match in the allow-list', () => {
  assert.equal(isOriginAllowed('https://app.example.com', ['https://app.example.com']), true);
});

test('isOriginAllowed rejects an origin not in the allow-list', () => {
  assert.equal(isOriginAllowed('https://evil.example.com', ['https://app.example.com']), false);
});

test('isOriginAllowed is case-sensitive on host (RFC 6454 origins are normalised lower-case)', () => {
  // We do not lowercase user-supplied config; values must match exactly. This
  // documents the behaviour so an operator knows to set lowercase origins.
  assert.equal(isOriginAllowed('https://APP.example.com', ['https://app.example.com']), false);
});

test('buildCorsOptions origin callback allows listed origin', () => {
  const opts = buildCorsOptions(['https://app.example.com']);
  const origin = opts.origin as (o: string | undefined, cb: (e: Error | null, allow?: boolean) => void) => void;
  origin('https://app.example.com', (err, allow) => {
    assert.equal(err, null);
    assert.equal(allow, true);
  });
});

test('buildCorsOptions origin callback rejects unlisted origin without throwing', () => {
  _resetRejectionLogCache();
  const opts = buildCorsOptions(['https://app.example.com']);
  const origin = opts.origin as (o: string | undefined, cb: (e: Error | null, allow?: boolean) => void) => void;
  origin('https://evil.example.com', (err, allow) => {
    // The cors package convention: signal "no CORS headers" with (null, false),
    // not by passing an Error. Errors would short-circuit the request entirely.
    assert.equal(err, null);
    assert.equal(allow, false);
  });
});

test('buildCorsOptions enables credentials (the whole point of an explicit allow-list)', () => {
  const opts = buildCorsOptions(['https://app.example.com']);
  assert.equal(opts.credentials, true);
});

test('logRejectedOrigin deduplicates within a one-minute window', () => {
  _resetRejectionLogCache();
  const captured: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { captured.push(String(msg)); };
  try {
    logRejectedOrigin('https://noisy.example.com', 'http');
    logRejectedOrigin('https://noisy.example.com', 'http');
    logRejectedOrigin('https://noisy.example.com', 'http');
  } finally {
    console.warn = orig;
  }
  assert.equal(captured.length, 1, 'expected only one warning for repeated rejections');
  assert.match(captured[0], /noisy\.example\.com/);
});

test('logRejectedOrigin emits separate entries for distinct origins', () => {
  _resetRejectionLogCache();
  const captured: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: any) => { captured.push(String(msg)); };
  try {
    logRejectedOrigin('https://a.example.com', 'http');
    logRejectedOrigin('https://b.example.com', 'ws');
  } finally {
    console.warn = orig;
  }
  assert.equal(captured.length, 2);
  assert.ok(captured.some(c => /a\.example\.com/.test(c) && /http/.test(c)));
  assert.ok(captured.some(c => /b\.example\.com/.test(c) && /ws/.test(c)));
});

test('validateCorsConfig in dev only warns on wildcard, does not exit', () => {
  withEnv({ CORS_ORIGINS: '*', NODE_ENV: 'development' }, () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: any) => { warned.push(String(msg)); };
    try {
      // Should not throw / not call process.exit.
      validateCorsConfig();
    } finally {
      console.warn = orig;
    }
    const joined = warned.join('\n');
    assert.match(joined, /wildcard/i);
  });
});

test('validateCorsConfig in dev warns on invalid origin entry', () => {
  withEnv({ CORS_ORIGINS: 'not-a-url,https://ok.example.com', NODE_ENV: 'development' }, () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: any) => { warned.push(String(msg)); };
    try {
      validateCorsConfig();
    } finally {
      console.warn = orig;
    }
    assert.match(warned.join('\n'), /not-a-url/);
  });
});

test('validateCorsConfig in dev rejects origin with a path', () => {
  withEnv({ CORS_ORIGINS: 'https://ok.example.com/admin', NODE_ENV: 'development' }, () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: any) => { warned.push(String(msg)); };
    try {
      validateCorsConfig();
    } finally {
      console.warn = orig;
    }
    assert.match(warned.join('\n'), /ok\.example\.com\/admin/);
  });
});

test('validateCorsConfig in dev passes silently for a clean allow-list', () => {
  withEnv({ CORS_ORIGINS: 'https://app.example.com,http://localhost:5173', NODE_ENV: 'development' }, () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: any) => { warned.push(String(msg)); };
    try {
      validateCorsConfig();
    } finally {
      console.warn = orig;
    }
    assert.equal(warned.length, 0);
  });
});

test('validateCorsConfig in production exits when CORS_ORIGINS is unset', () => {
  withEnv({ CORS_ORIGINS: undefined, NODE_ENV: 'production' }, () => {
    let exitCode: number | undefined;
    const origExit = process.exit;
    const errored: string[] = [];
    const origErr = console.error;
    console.error = (msg?: any) => { errored.push(String(msg)); };
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit_called__');
    }) as typeof process.exit;
    try {
      assert.throws(() => validateCorsConfig(), /__exit_called__/);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
    assert.match(errored.join('\n'), /CORS_ORIGINS is unset or empty in production/);
  });
});

test('validateCorsConfig in production exits when CORS_ORIGINS contains "*"', () => {
  withEnv({ CORS_ORIGINS: 'https://app.example.com,*', NODE_ENV: 'production' }, () => {
    let exitCode: number | undefined;
    const origExit = process.exit;
    const errored: string[] = [];
    const origErr = console.error;
    console.error = (msg?: any) => { errored.push(String(msg)); };
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit_called__');
    }) as typeof process.exit;
    try {
      assert.throws(() => validateCorsConfig(), /__exit_called__/);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
    assert.match(errored.join('\n'), /wildcard/i);
    assert.match(errored.join('\n'), /credentials/i);
  });
});

test('validateCorsConfig in production passes for a clean explicit allow-list', () => {
  withEnv({ CORS_ORIGINS: 'https://app.example.com,https://admin.example.com', NODE_ENV: 'production' }, () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = ((_code?: number) => { exitCalled = true; throw new Error('exit'); }) as typeof process.exit;
    try {
      validateCorsConfig();
    } finally {
      process.exit = origExit;
    }
    assert.equal(exitCalled, false);
  });
});
