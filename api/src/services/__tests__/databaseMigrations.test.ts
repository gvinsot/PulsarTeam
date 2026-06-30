import test from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations, type Migration } from '../database/migrations.js';

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

  return {
    queries,
    applied,
    pool: {
      async connect() {
        return client;
      },
    },
  };
}

function migration(id: string, fingerprint: string, sql: string): Migration {
  return {
    id,
    name: id,
    fingerprint,
    up: async (db) => {
      await db.query(sql);
    },
  };
}

test('runMigrations applies new migrations once and records checksums', async () => {
  const { pool, queries, applied } = makePool();
  const migrations = [
    migration('001_first', 'first-v1', 'ALTER TEST first'),
    migration('002_second', 'second-v1', 'ALTER TEST second'),
  ];

  await runMigrations(pool, migrations);
  await runMigrations(pool, migrations);

  assert.equal(applied.size, 2);
  assert.equal(queries.filter(q => q.sql === 'ALTER TEST first').length, 1);
  assert.equal(queries.filter(q => q.sql === 'ALTER TEST second').length, 1);
  assert.equal(queries.filter(q => q.sql === 'BEGIN').length, 2);
  assert.equal(queries.filter(q => q.sql === 'COMMIT').length, 2);
});

test('runMigrations rejects checksum drift on applied migrations', async () => {
  const { pool } = makePool();

  await runMigrations(pool, [migration('001_first', 'first-v1', 'ALTER TEST first')]);

  await assert.rejects(
    () => runMigrations(pool, [migration('001_first', 'first-v2', 'ALTER TEST changed')]),
    /checksum changed/
  );
});
