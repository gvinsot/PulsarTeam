import { getPool } from './connection.js';
import { encryptFields, decryptFields } from '../../lib/crypto.js';
import { errorMessage } from '../../lib/errors.js';

/**
 * Factory for the (id, data JSONB, created_at, updated_at) document tables that
 * share identical CRUD: getAll / getById / save (upsert) / remove (delete).
 *
 * The table name is a closed literal per call site (no injection surface).
 * Optional secretFields enable at-rest encryption of the named fields via
 * crypto.ts. Methods close over (table, opts) — never `this` — so they can be
 * detached and re-exported under the module's existing names.
 *
 * `T` is the document type the table holds. It appears only in return
 * positions, so every call site names it explicitly
 * (`createJsonDocStore<Skill>('skills', …)`) — that one annotation is what
 * gives `getAll()` / `getById()` a real element type instead of `any[]`, all
 * the way out to the manager that caches the rows.
 */
export function createJsonDocStore<T extends Record<string, unknown>>(
  table: string,
  opts: {
    secretFields?: readonly string[];
    orderBy?: string;
    label?: string;
    labelPlural?: string;
  } = {}
) {
  const orderBy = opts.orderBy || 'created_at';
  const label = opts.label || 'document';
  const labelPlural = opts.labelPlural || 'documents';
  // Shape-preserving, like encryptFields/decryptFields themselves: the doc
  // goes in and comes back with the same keys, only the named secret fields
  // re-written. Generic rather than `Record<string, unknown>` so a caller's
  // own document type survives the round trip instead of collapsing.
  const dec = <T extends Record<string, unknown>>(d: T) =>
    opts.secretFields ? decryptFields(d, opts.secretFields) : d;
  const enc = <T extends Record<string, unknown>>(d: T) =>
    opts.secretFields ? encryptFields(d, opts.secretFields) : d;

  return {
    async getAll() {
      const pool = getPool();
      if (!pool) return [];
      try {
        const result = await pool.query<{ data: T }>(
          `SELECT data FROM ${table} ORDER BY ${orderBy}`
        );
        return result.rows.map(row => dec(row.data));
      } catch (err) {
        console.error(`Failed to load ${labelPlural}:`, errorMessage(err));
        return [];
      }
    },

    async getById(id: string): Promise<T | null> {
      const pool = getPool();
      if (!pool) return null;
      try {
        const result = await pool.query<{ data: T }>(`SELECT data FROM ${table} WHERE id = $1`, [
          id,
        ]);
        const d = result.rows[0]?.data;
        return d ? dec(d) : null;
      } catch (err) {
        console.error(`Failed to get ${label}:`, errorMessage(err));
        return null;
      }
    },

    // Only the id is read here — the rest of the document is serialized whole
    // into the JSONB column, so the store stays agnostic about its shape.
    async save(doc: { id: string }) {
      const pool = getPool();
      if (!pool) return;
      try {
        await pool.query(
          `INSERT INTO ${table} (id, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
          [doc.id, JSON.stringify(enc(doc))]
        );
      } catch (err) {
        console.error(`Failed to save ${label}:`, errorMessage(err));
      }
    },

    async remove(id: string) {
      const pool = getPool();
      if (!pool) return false;
      try {
        const result = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
      } catch (err) {
        console.error(`Failed to delete ${label}:`, errorMessage(err));
        return false;
      }
    },
  };
}
