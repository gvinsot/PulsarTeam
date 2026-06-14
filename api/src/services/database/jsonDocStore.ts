import { getPool } from './connection.js';
import { encryptFields, decryptFields } from '../../lib/crypto.js';

/**
 * Factory for the (id, data JSONB, created_at, updated_at) document tables that
 * share identical CRUD: getAll / getById / save (upsert) / remove (delete).
 *
 * The table name is a closed literal per call site (no injection surface).
 * Optional secretFields enable at-rest encryption of the named fields via
 * crypto.ts. Methods close over (table, opts) — never `this` — so they can be
 * detached and re-exported under the module's existing names.
 */
export function createJsonDocStore(
  table: string,
  opts: { secretFields?: readonly string[]; orderBy?: string; label?: string; labelPlural?: string } = {}
) {
  const orderBy = opts.orderBy || 'created_at';
  const label = opts.label || 'document';
  const labelPlural = opts.labelPlural || 'documents';
  const dec = (d) => (opts.secretFields ? decryptFields(d, opts.secretFields) : d);
  const enc = (d) => (opts.secretFields ? encryptFields(d, opts.secretFields) : d);

  return {
    async getAll() {
      const pool = getPool();
      if (!pool) return [];
      try {
        const result = await pool.query(`SELECT data FROM ${table} ORDER BY ${orderBy}`);
        return result.rows.map(row => dec(row.data));
      } catch (err: any) {
        console.error(`Failed to load ${labelPlural}:`, err.message);
        return [];
      }
    },

    async getById(id) {
      const pool = getPool();
      if (!pool) return null;
      try {
        const result = await pool.query(`SELECT data FROM ${table} WHERE id = $1`, [id]);
        const d = result.rows[0]?.data;
        return d ? dec(d) : null;
      } catch (err: any) {
        console.error(`Failed to get ${label}:`, err.message);
        return null;
      }
    },

    async save(doc) {
      const pool = getPool();
      if (!pool) return;
      try {
        await pool.query(
          `INSERT INTO ${table} (id, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
          [doc.id, JSON.stringify(enc(doc))]
        );
      } catch (err: any) {
        console.error(`Failed to save ${label}:`, err.message);
      }
    },

    async remove(id) {
      const pool = getPool();
      if (!pool) return false;
      try {
        const result = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        return result.rowCount > 0;
      } catch (err: any) {
        console.error(`Failed to delete ${label}:`, err.message);
        return false;
      }
    },
  };
}
