import type { Pool } from 'pg';

// The pool is installed by initializeDatabase() in schema.ts and torn back down
// to null when the connection is lost, so every consumer has to cope with its
// absence — hence the explicit `Pool | null` rather than an inferred type. The
// annotation is what makes the `if (!pool) return ...` guard scattered across
// src/services/database/ actually narrow under strictNullChecks.
let pool: Pool | null = null;
let _dbConnected = false;

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
