// ── Orphaned agents: the admin reassignment screen, and the two-store trap ───
//
// `ownerId` lives in TWO places. `saveAgent` writes the `agents.owner_id`
// column and the `ownerId` inside the `agents.data` JSONB from the same object,
// but they drift apart on their own: `owner_id` is
// `REFERENCES users(id) ON DELETE SET NULL`, so deleting a user NULLs the
// column and leaves the JSONB pointing at an account that no longer exists.
// Before this screen existed, the read path only ever looked at the JSONB, so
// such an agent still read as owned — and a "fix" applied as
// `UPDATE agents SET owner_id = …` changed nothing the application could see.
//
// These tests are written against that, not against the happy path. The fake
// pool below models the two stores SEPARATELY and projects only the columns a
// SELECT actually names, so a query that forgets `owner_id` fails here the same
// way it fails in production: silently reading the stale JSONB copy.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { setPool } from '../database/connection.js';
import { getAgentById, getAllAgents } from '../database/agents.js';
import { AgentManager } from '../agentManager.js';
import { agentRoutes } from '../../routes/agents.js';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';

interface FakeAgentRow {
  id: string;
  data: Record<string, unknown>;
  owner_id: string | null;
  board_id: string | null;
}

interface FakeUserRow {
  id: string;
  username: string;
  role: string;
}

/** The response shape of GET /api/agents/orphans, as the API contract fixes it. */
interface OrphanAgent {
  id: string;
  name?: string;
  boardId: string | null;
  ownerId: string | null;
  ownerExists: boolean;
  createdAt?: string;
}

/**
 * A stand-in for the `agents` + `users` tables that keeps the JSONB blob and
 * the mirrored columns as distinct values, so a test can desynchronise them the
 * way Postgres does.
 */
class FakeDb {
  agents = new Map<string, FakeAgentRow>();
  users = new Map<string, FakeUserRow>();

  addUser(id: string, role = 'advanced'): FakeUserRow {
    const user = { id, username: id, role };
    this.users.set(id, user);
    return user;
  }

  /** What `ON DELETE SET NULL` does: the column is cleared, the JSONB is not. */
  deleteUser(id: string) {
    this.users.delete(id);
    for (const row of this.agents.values()) {
      if (row.owner_id === id) row.owner_id = null;
    }
  }

  row(id: string): FakeAgentRow {
    const row = this.agents.get(id);
    if (!row) throw new Error(`fake db: no agent ${id}`);
    return row;
  }

  /**
   * Return a row shaped like the SELECT that asked for it. A column the query
   * did not name is ABSENT, not null — that is the whole point: it is how
   * `getAllAgents`' old `SELECT data, board_id` used to hide the owner column.
   */
  project(row: FakeAgentRow, sql: string): Record<string, unknown> {
    const projected: Record<string, unknown> = {
      // Cloned so one reader's fixups cannot heal the stored JSONB for the next.
      data: JSON.parse(JSON.stringify(row.data)),
    };
    if (sql.includes('board_id')) projected.board_id = row.board_id;
    if (sql.includes('owner_id')) projected.owner_id = row.owner_id;
    return projected;
  }

  asPool(): Pool {
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO agents')) {
        const [id, data, ownerId, boardId] = params;
        if (typeof id !== 'string' || typeof data !== 'string') {
          throw new Error('fake db: unexpected saveAgent parameters');
        }
        // The foreign key the real column carries. saveAgent swallows its
        // errors, so a route that skips the existence check would look like it
        // succeeded while the row kept its old owner — reproduced here.
        if (typeof ownerId === 'string' && !this.users.has(ownerId)) {
          throw new Error('insert or update on table "agents" violates foreign key constraint');
        }
        this.agents.set(id, {
          id,
          data: JSON.parse(data),
          owner_id: typeof ownerId === 'string' ? ownerId : null,
          board_id: typeof boardId === 'string' ? boardId : null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM agents WHERE id = $1')) {
        const row = typeof params[0] === 'string' ? this.agents.get(params[0]) : undefined;
        return { rows: row ? [this.project(row, sql)] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('FROM agents ORDER BY created_at')) {
        const rows = [...this.agents.values()].map(row => this.project(row, sql));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM users WHERE id = $1')) {
        const user = typeof params[0] === 'string' ? this.users.get(params[0]) : undefined;
        return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
      }
      if (sql.includes('FROM users ORDER BY created_at')) {
        const rows = [...this.users.values()];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    };
    return { query } as unknown as Pool;
  }
}

const io = {
  emit() {},
  to() {
    return { emit() {} };
  },
};

afterEach(() => {
  setPool(null);
});

/** An admin request against the real agents router, backed by `manager`. */
function adminHarness(manager: AgentManager) {
  return createRouteHarness(
    agentRoutes(manager),
    harnessUser({ userId: 'admin-1', role: 'admin' })
  );
}

async function readOrphans(response: Response): Promise<OrphanAgent[]> {
  const body: unknown = await response.json();
  const agents = (body as { agents?: unknown }).agents;
  assert.ok(Array.isArray(agents), 'orphans response must carry an agents array');
  return agents as OrphanAgent[];
}

// ── The read path ───────────────────────────────────────────────────────────

test('a non-null owner_id column wins over a stale ownerId in the JSONB', async () => {
  const db = new FakeDb();
  db.addUser('user-new');
  db.agents.set('agent-1', {
    id: 'agent-1',
    data: { id: 'agent-1', name: 'Legacy', ownerId: 'user-old', boardId: null },
    owner_id: 'user-new',
    board_id: null,
  });
  setPool(db.asPool());

  const byId = await getAgentById('agent-1');
  const [listed] = await getAllAgents();

  // Both readers must SELECT the column, not just whichever one happened to.
  assert.equal(byId?.ownerId, 'user-new');
  assert.equal(listed.ownerId, 'user-new');
});

test('a JSONB ownerId survives a NULL column, so pre-migration agents stay owned', async () => {
  const db = new FakeDb();
  db.addUser('user-legacy');
  // Written before migration 202601010003 added owner_id: the column is empty
  // and the JSONB copy is the only record of the owner.
  db.agents.set('agent-legacy', {
    id: 'agent-legacy',
    data: { id: 'agent-legacy', name: 'Before the column', ownerId: 'user-legacy', boardId: null },
    owner_id: null,
    board_id: null,
  });
  setPool(db.asPool());

  const agent = await getAgentById('agent-legacy');

  assert.equal(agent?.ownerId, 'user-legacy');
});

// ── GET /orphans ────────────────────────────────────────────────────────────

test('GET /orphans lists ownerless agents and agents whose owner was deleted', async () => {
  const db = new FakeDb();
  db.addUser('admin-1', 'admin');
  db.addUser('user-live');
  db.addUser('user-doomed');
  setPool(db.asPool());

  const manager = new AgentManager(io, null, null, null);
  const owned = await manager.create({ name: 'Owned', ownerId: 'user-live' });
  const ownerless = await manager.create({ name: 'Ownerless' });
  const abandoned = await manager.create({ name: 'Abandoned', ownerId: 'user-doomed' });

  // The owner leaves: the column is NULLed, the JSONB keeps the dead id.
  db.deleteUser('user-doomed');
  assert.equal(db.row(abandoned.id).owner_id, null);
  assert.equal(db.row(abandoned.id).data.ownerId, 'user-doomed');

  const response = await adminHarness(manager).get('/orphans');
  assert.equal(response.status, 200);
  const orphans = await readOrphans(response);

  assert.deepEqual(
    orphans.map(agent => agent.id).sort(),
    [ownerless.id, abandoned.id].sort(),
    'an agent with a live owner must not be listed'
  );
  assert.ok(!orphans.some(agent => agent.id === owned.id));

  const listedOwnerless = orphans.find(agent => agent.id === ownerless.id);
  assert.equal(listedOwnerless?.ownerId, null);
  assert.equal(listedOwnerless?.ownerExists, false);
  assert.equal(listedOwnerless?.name, 'Ownerless');
  assert.equal(listedOwnerless?.boardId, null);
  assert.equal(typeof listedOwnerless?.createdAt, 'string');

  // The point of `ownerExists`: this agent still carries an owner id, it is
  // just a dangling one. The client can tell the two cases apart.
  const listedAbandoned = orphans.find(agent => agent.id === abandoned.id);
  assert.equal(listedAbandoned?.ownerId, 'user-doomed');
  assert.equal(listedAbandoned?.ownerExists, false);
});

test('GET /orphans is matched before GET /:id, not read as an agent named "orphans"', async () => {
  const db = new FakeDb();
  setPool(db.asPool());
  const manager = new AgentManager(io, null, null, null);

  const response = await adminHarness(manager).get('/orphans');

  // Mounted after '/:id' this would 404 through the agent access guard.
  assert.equal(response.status, 200);
  assert.deepEqual(await readOrphans(response), []);
});

test('GET /orphans is admin-only', async () => {
  const db = new FakeDb();
  setPool(db.asPool());
  const manager = new AgentManager(io, null, null, null);

  const response = await createRouteHarness(
    agentRoutes(manager),
    harnessUser({ userId: 'user-live', role: 'advanced' })
  ).get('/orphans');

  assert.equal(response.status, 403);
});

// ── PUT /:id/owner ──────────────────────────────────────────────────────────

test('PUT /:id/owner reassigns through the application path, and the normal read agrees', async () => {
  const db = new FakeDb();
  db.addUser('user-doomed');
  db.addUser('user-rescuer');
  setPool(db.asPool());

  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Abandoned', ownerId: 'user-doomed' });
  db.deleteUser('user-doomed');

  const response = await adminHarness(manager).put(`/${agent.id}/owner`, {
    ownerId: 'user-rescuer',
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.equal((body as { success?: unknown }).success, true);
  assert.equal((body as { agent?: { ownerId?: unknown } }).agent?.ownerId, 'user-rescuer');

  // THE test. A raw `UPDATE agents SET owner_id` passes the column assertion
  // and fails everything below it: the JSONB would still say 'user-doomed',
  // and the in-memory agent every other route reads would never have moved.
  assert.equal(db.row(agent.id).owner_id, 'user-rescuer');
  assert.equal(db.row(agent.id).data.ownerId, 'user-rescuer');

  const reread = await getAgentById(agent.id);
  assert.equal(reread?.ownerId, 'user-rescuer');
  assert.equal(manager.agents.get(agent.id)?.ownerId, 'user-rescuer');

  const orphans = await readOrphans(await adminHarness(manager).get('/orphans'));
  assert.deepEqual(orphans, [], 'a reassigned agent is no longer orphaned');
});

test('PUT /:id/owner refuses an unknown user before writing anything', async () => {
  const db = new FakeDb();
  db.addUser('user-live');
  setPool(db.asPool());

  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Owned', ownerId: 'user-live' });

  const response = await adminHarness(manager).put(`/${agent.id}/owner`, { ownerId: 'ghost' });

  // Without the pre-check the foreign key rejects the INSERT, saveAgent
  // swallows the error, and the in-memory agent claims an owner the database
  // never accepted.
  assert.equal(response.status, 404);
  assert.equal(db.row(agent.id).owner_id, 'user-live');
  assert.equal(manager.agents.get(agent.id)?.ownerId, 'user-live');
});

test('PUT /:id/owner rejects a missing ownerId and an unknown agent', async () => {
  const db = new FakeDb();
  db.addUser('user-live');
  setPool(db.asPool());

  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Owned', ownerId: 'user-live' });
  const harness = adminHarness(manager);

  assert.equal((await harness.put(`/${agent.id}/owner`, {})).status, 400);
  assert.equal((await harness.put(`/${agent.id}/owner`, { ownerId: '  ' })).status, 400);
  assert.equal((await harness.put('/missing-agent/owner', { ownerId: 'user-live' })).status, 404);
});

test('PUT /:id/owner is admin-only', async () => {
  const db = new FakeDb();
  db.addUser('user-live');
  setPool(db.asPool());

  const manager = new AgentManager(io, null, null, null);
  const agent = await manager.create({ name: 'Owned', ownerId: 'user-live' });

  const response = await createRouteHarness(
    agentRoutes(manager),
    harnessUser({ userId: 'user-live', role: 'advanced' })
  ).put(`/${agent.id}/owner`, { ownerId: 'user-live' });

  assert.equal(response.status, 403);
});
