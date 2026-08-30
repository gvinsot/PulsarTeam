import type { Pool, PoolConfig } from 'pg';

// The pool is installed by initDatabase() in schema.ts and torn back down
// to null when the connection is lost, so every consumer has to cope with its
// absence — hence the explicit `Pool | null` rather than an inferred type. The
// annotation is what makes the `if (!pool) return ...` guard scattered across
// src/services/database/ actually narrow under strictNullChecks.
let pool: Pool | null = null;
let _dbConnected = false;

/**
 * Connections this replica is allowed to open against Postgres.
 *
 * Sizing, so the next person changing it knows what it is balanced against:
 *  - Two API replicas share one Postgres cluster in practice — the prod stack
 *    and the qa stack (devops/docker-compose.swarm.yml, `team-api` is
 *    `replicas: 1` in each, both attached to `postgresqlcluster_internal`), so
 *    the deployed ceiling is 2 × POOL_MAX = 40 backends. That leaves headroom
 *    under a stock `max_connections = 100` (minus `superuser_reserved`) for the
 *    cluster's other clients and for psql/maintenance sessions.
 *  - It must comfortably exceed MAX_CONCURRENT_TASK_LOCKS (6, database/locks.ts):
 *    those connections are checked out of THIS pool and held for the whole
 *    duration of a run_agent chain — minutes. At the pg default of 10 that left
 *    4 connections for all HTTP traffic; at 20 it leaves 14.
 * Raise the two together, and check the server's max_connections first.
 */
export const POOL_MAX = 20;

/**
 * Explicit pool tuning, spread into `new Pool()` alongside the connectionString.
 *
 * `new Pool({ connectionString })` on its own inherits pg's defaults, and the
 * important one is a trap: `connectionTimeoutMillis` defaults to 0, meaning
 * WAIT FOREVER for a free connection. Under pool exhaustion a request did not
 * fail — it hung, and the HTTP request hung with it, with no timeout anywhere
 * to end it. Every value below is therefore set on purpose:
 *
 *  - connectionTimeoutMillis: bound that wait. 10s is longer than any healthy
 *    checkout and short enough that a caller gets an error (and the client a
 *    5xx) instead of a socket that never answers.
 *  - idleTimeoutMillis: 30s, above pg's 10s default. The workflow tick polls on
 *    a short period, so a 10s idle reaper churns connections it is about to
 *    need again; 30s keeps a warm set without holding backends indefinitely.
 *  - statement_timeout: server-side cap, the only one Postgres itself enforces.
 *    Without it a single runaway query pins a pooled connection until someone
 *    kills the backend. 30s is far above normal API queries. Schema bootstrap
 *    legitimately exceeds it and opts out explicitly — see schema.ts.
 *  - keepAlive: lock connections sit idle-but-checked-out for minutes while a
 *    run_agent chain runs. Across the Swarm overlay network a silently dropped
 *    TCP session would only surface as an error at release time; TCP keepalives
 *    make the break visible (and let pool.on('error') handle it) instead.
 *  - application_name: several stacks share the cluster, so pg_stat_activity is
 *    where the connection budget above gets audited. Tag who is who.
 */
export const POOL_OPTIONS: Readonly<PoolConfig> = {
  max: POOL_MAX,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: `pulsarteam-api${process.env.APP_ENVIRONMENT ? `-${process.env.APP_ENVIRONMENT}` : ''}`,
};

export function getPool(): Pool | null {
  return pool;
}

export function setPool(p: Pool | null) {
  pool = p;
}

export function isDatabaseConnected(): boolean {
  return _dbConnected;
}

export function setDatabaseConnected(value: boolean) {
  _dbConnected = value;
}
