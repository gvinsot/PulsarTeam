import test from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations, type Migration } from '../database/migrations.js';
import type { Queryable } from '../database/baseSchema.js';

function makePool() {
  const applied = new Map<string, string>();
  const queries: Array<{ sql: string; params?: any[] }> = [];

  const client = {
    async query(sql: string, params?: any[]) {
      queries.push({ sql, params });
      if (sql.includes('SELECT id, checksum FROM schema_migrations')) {
        return { rows: [...applied.entries()].map(([id, checksum]) => ({ id, checksum })) };
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        applied.set(params?.[0], params?.[2]);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };

  // runMigrations takes the caller's session, not a Pool: the advisory lock and
  // the per-migration transactions are only coherent on ONE connection.
  //
  // The double is cast rather than made to satisfy `Queryable` structurally:
  // that would mean returning a full pg `QueryResult` (command, rowCount,
  // oid, fields) from every branch, none of which the code under test reads.
  return { queries, applied, client: client as unknown as Queryable };
}

function migration(id: string, fingerprint: string, sql: string): Migration {
  return {
    id,
    name: id,
    fingerprint,
    up: async db => {
      await db.query(sql);
    },
  };
}

test('runMigrations applies new migrations once and records checksums', async () => {
  const { client, queries, applied } = makePool();
  const migrations = [
    migration('001_first', 'first-v1', 'ALTER TEST first'),
    migration('002_second', 'second-v1', 'ALTER TEST second'),
  ];

  await runMigrations(client, migrations);
  await runMigrations(client, migrations);

  assert.equal(applied.size, 2);
  assert.equal(queries.filter(q => q.sql === 'ALTER TEST first').length, 1);
  assert.equal(queries.filter(q => q.sql === 'ALTER TEST second').length, 1);
  assert.equal(queries.filter(q => q.sql === 'BEGIN').length, 2);
  assert.equal(queries.filter(q => q.sql === 'COMMIT').length, 2);
});

test('runMigrations rejects checksum drift on applied migrations', async () => {
  const { client } = makePool();

  await runMigrations(client, [migration('001_first', 'first-v1', 'ALTER TEST first')]);

  await assert.rejects(
    () => runMigrations(client, [migration('001_first', 'first-v2', 'ALTER TEST changed')]),
    /checksum changed/
  );
});

// Regression guard for the outage of 2026-08-30.
//
// runMigrations used to take the Pool and call `pool.connect()` itself. When
// initDatabase started running the whole bootstrap on one dedicated connection,
// it passed that CLIENT through — and pg answers `.connect()` on an already
// connected client with "Client has already been connected. You cannot reuse a
// client.". Every boot attempt failed, the API came up with no database, and a
// fallback login handed out legacy tokens the current frontend cannot use.
//
// Nothing caught it: the suite only ever fed this function a double. So the
// double now REFUSES to be connected, which is exactly what a real PoolClient
// does.
test('runMigrations never connects: it uses the session it is given', async () => {
  const { client } = makePool();
  const noReconnect = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return () => {
          throw new Error('Client has already been connected. You cannot reuse a client.');
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  await runMigrations(noReconnect, [migration('001_first', 'first-v1', 'ALTER TEST first')]);
});
