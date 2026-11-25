import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRouteHarness } from './helpers/routeHarness.js';

process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.AUTH_BROWSER_KEY = randomBytes(32).toString('hex');
process.env.APP_ENVIRONMENT = 'prod';
const rows = new Map<string, { session_key: string; ciphertext: string }>();
let available = true;
mock.module('../database/connection.js', {
  namedExports: {
    getPool: () =>
      available
        ? {
            query: async (sql: string, args: string[]) => {
              const [env, key, ciphertext] = args;
              if (sql.startsWith('INSERT'))
                rows.set(`${env}/${key}`, { session_key: key, ciphertext });
              if (sql.startsWith('DELETE')) rows.delete(`${env}/${key}`);
              return {
                rows: sql.startsWith('SELECT')
                  ? [...rows.entries()].filter(([k]) => k.startsWith(env + '/')).map(([, v]) => v)
                  : [],
              };
            },
          }
        : null,
  },
});
const { authBrowserSessionRoutes } = await import('../../routes/authBrowserSessions.js');
const { decryptString } = await import('../../lib/crypto.js');
const harness = createRouteHarness(authBrowserSessionRoutes());
const headers = { authorization: `Bearer ${process.env.AUTH_BROWSER_KEY}` };
const snapshot = {
  version: 1,
  key: 'board:test@site.test',
  id: randomUUID(),
  controller: 'alice',
  origin: 'https://site.test',
  phase: 'ready',
  created: Date.now() / 1000,
  used: Date.now() / 1000,
  url: 'https://site.test/feed',
  user_agent: '',
  storage: { cookies: [{ name: 'sid', value: 'synthetic-secret' }], origins: [] },
};

test('dedicated service authentication, encrypted persistence, environment isolation and revocation', async () => {
  for (const authorization of ['', 'Bearer user-jwt', 'Bearer ' + 'x'.repeat(64)]) {
    assert.equal((await harness.get('/', { headers: { authorization } })).status, 403);
    assert.equal((await harness.put('/', snapshot, { headers: { authorization } })).status, 403);
    assert.equal(
      (await harness.del('/', { body: { key: snapshot.key }, headers: { authorization } })).status,
      403
    );
  }
  assert.equal(rows.size, 0);
  assert.equal((await harness.put('/', snapshot, { headers })).status, 204);
  const row = [...rows.values()][0];
  assert.ok(row.ciphertext.startsWith('enc:v1:'));
  assert.ok(!row.ciphertext.includes('synthetic-secret'));
  assert.deepEqual(JSON.parse(decryptString(row.ciphertext)), snapshot);
  const response = await harness.get('/', { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { sessions: [snapshot] });
  process.env.APP_ENVIRONMENT = 'qa';
  assert.deepEqual(await (await harness.get('/', { headers })).json(), { sessions: [] });
  await harness.del('/', { headers, body: { key: snapshot.key } });
  assert.equal(rows.size, 1);
  process.env.APP_ENVIRONMENT = '';
  assert.equal((await harness.get('/', { headers })).status, 503);
  process.env.APP_ENVIRONMENT = 'prod';
  available = false;
  assert.equal((await harness.get('/', { headers })).status, 503);
  assert.equal((await harness.del('/', { headers, body: { key: snapshot.key } })).status, 503);
  available = true;
  const bad = { ...snapshot, phase: 'importing' };
  assert.equal((await harness.put('/', bad, { headers })).status, 400);
  row.ciphertext = 'enc:v1:tampered';
  const corrupt = await harness.get('/', { headers });
  assert.equal(corrupt.status, 503);
  assert.ok(!(await corrupt.text()).includes('synthetic-secret'));
  assert.equal((await harness.del('/', { headers, body: { key: snapshot.key } })).status, 204);
  assert.equal(rows.size, 0);
});
