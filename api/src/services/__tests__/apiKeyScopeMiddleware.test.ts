/**
 * `requireApiKeyScope` — the guard on /api/mcp/admin and /api/mcp/management.
 *
 * Three properties are load-bearing, and each has a failure mode that would be
 * invisible without a test:
 *
 *  1. THE LADDER IS ONE-WAY. An `admin` key opens a `management` endpoint; a
 *     `management` key never opens an `admin` one. Getting the comparison
 *     backwards would hand every management key the agent, board, project and
 *     workflow mutation tools.
 *
 *  2. A LEGACY KEY IS REFUSED. The old ownerless instance-wide key still works
 *     on /api/swarm/* so integrations do not break, but it names nobody — there
 *     is no tenant to run these tools in. Accepting it "for compatibility"
 *     would reinstate exactly the unscoped access this surface replaces.
 *
 *  3. CLAIMS ARE READ LIVE, NEVER BAKED INTO THE KEY. The key carries an owner
 *     id and nothing else; the role comes from a fresh database read on every
 *     request. That is what makes a demotion or a deletion take effect on the
 *     next call instead of at the next key rotation.
 *
 *  4. `insert` IS OFF THE LADDER. An insert key opens the insert surface and
 *     nothing else; no ladder key — not even admin — opens the insert surface.
 *     And the owner's edit access to the key's board is re-proved live.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// ── The key store, faked at the resolve boundary ────────────────────────────
type Resolved = {
  id: string;
  userId: string | null;
  scope: string | null;
  boardId: string | null;
  legacy: boolean;
};

const KEYS: Record<string, Resolved> = {
  'key-admin': { id: 'k1', userId: 'user-a', scope: 'admin', boardId: null, legacy: false },
  'key-management': {
    id: 'k2',
    userId: 'user-a',
    scope: 'management',
    boardId: null,
    legacy: false,
  },
  'key-orphan': { id: 'k3', userId: 'user-gone', scope: 'admin', boardId: null, legacy: false },
  'key-legacy': { id: 'k4', userId: null, scope: null, boardId: null, legacy: true },
  'key-insert': {
    id: 'k5',
    userId: 'user-a',
    scope: 'insert',
    boardId: 'board-own',
    legacy: false,
  },
  'key-insert-shared': {
    id: 'k6',
    userId: 'user-a',
    scope: 'insert',
    boardId: 'board-shared',
    legacy: false,
  },
};

const touched: string[] = [];
let resolveThrows = false;

// The real ladder is imported, not re-implemented: if SCOPE_RANK ever changes,
// these tests follow it rather than silently disagreeing with production.
const { scopeSatisfies } = await import('../apiKeyManager.js');

mock.module('../../services/apiKeyManager.js', {
  namedExports: {
    resolveApiKey: async (key: string) => {
      if (resolveThrows) throw new Error('database down');
      return KEYS[key] || null;
    },
    scopeSatisfies,
    touchApiKey: async (id: string) => {
      touched.push(id);
    },
    validateApiKey: async (key: string) => !!KEYS[key]?.legacy,
  },
});

// The live re-read. `user-a` is an admin today; the demotion test moves them.
const USERS: Record<string, any> = {
  'user-a': { id: 'user-a', username: 'alice', role: 'admin' },
};

// The boards the insert keys are bound to. `checkBoardAccess` itself is real —
// only the rows it reads are faked. `SHARES` is what the unshare test edits.
const BOARDS: Record<string, any> = {
  'board-own': { id: 'board-own', name: 'Own', user_id: 'user-a' },
  'board-shared': { id: 'board-shared', name: 'Shared', user_id: 'user-b' },
};
const SHARES: Record<string, string | undefined> = { 'board-shared': 'edit' };

mock.module('../../services/database.js', {
  namedExports: {
    getUserById: async (id: string) => USERS[id] || null,
    getBoardById: async (id: string) => BOARDS[id] || null,
    getBoardShare: async (boardId: string) =>
      SHARES[boardId] ? { board_id: boardId, permission: SHARES[boardId] } : null,
    getProjectById: async () => null,
    hasProjectBoardAccess: async () => false,
  },
});

const { requireApiKeyScope, authenticateApiKey } = await import('../../middleware/apiKeyAuth.js');

/** Minimal Express doubles: record the status and body, and whether next ran. */
function exchange(authorization?: string) {
  const req: any = { headers: authorization ? { authorization } : {} };
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  let nexted = false;
  const next = () => {
    nexted = true;
  };
  return { req, res, next, called: () => nexted };
}

async function call(scope: 'admin' | 'management' | 'insert', authorization?: string) {
  const ex = exchange(authorization);
  await requireApiKeyScope(scope)(ex.req, ex.res, ex.next);
  return { ...ex, passed: ex.called() };
}

// ── 1. The ladder ───────────────────────────────────────────────────────────

test('an admin key opens both surfaces', async () => {
  for (const scope of ['admin', 'management'] as const) {
    const { passed, req } = await call(scope, 'Bearer key-admin');
    assert.equal(passed, true, `admin key must open the ${scope} surface`);
    assert.equal(req.apiKey.scope, 'admin');
  }
});

test('a management key opens management and is REFUSED on admin', async () => {
  const ok = await call('management', 'Bearer key-management');
  assert.equal(ok.passed, true);

  const denied = await call('admin', 'Bearer key-management');
  assert.equal(denied.passed, false, 'the ladder must not run downhill');
  assert.equal(denied.res.statusCode, 403);
  assert.match(denied.res.body.error, /scope "management" does not grant "admin"/);
});

// ── 2. Legacy keys ──────────────────────────────────────────────────────────

test('a legacy key is refused on every scoped endpoint', async () => {
  for (const scope of ['admin', 'management'] as const) {
    const { passed, res } = await call(scope, 'Bearer key-legacy');
    assert.equal(passed, false, `the ownerless key must not open ${scope}`);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /scoped API key/i);
  }
});

test('a legacy key still passes authenticateApiKey, which guards /api/swarm/*', async () => {
  // The compatibility half of the same decision: existing integrations keep
  // working on the surface they were built for.
  const ex = exchange('Bearer key-legacy');
  await authenticateApiKey(ex.req, ex.res, ex.next);
  assert.equal(ex.called(), true);
  // …and it attaches no identity, which is precisely why it is refused above.
  assert.equal(ex.req.user, undefined);
});

// ── 3. Live claims ──────────────────────────────────────────────────────────

test('the owner role is re-read on every request, never taken from the key', async () => {
  USERS['user-a'].role = 'admin';
  const first = await call('admin', 'Bearer key-admin');
  assert.equal(first.req.user.role, 'admin');

  // Same key, same scope — the owner is demoted between the two calls.
  USERS['user-a'].role = 'basic';
  const second = await call('admin', 'Bearer key-admin');
  assert.equal(second.passed, true, 'the key itself is still valid');
  assert.equal(
    second.req.user.role,
    'basic',
    'a demotion must restrict the key on its very next use, not at the next rotation'
  );

  USERS['user-a'].role = 'admin';
});

test('a key whose owner was deleted stops working immediately', async () => {
  const { passed, res } = await call('admin', 'Bearer key-orphan');
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /owner no longer exists/i);
});

test('the published req.user is the shape every authorization helper expects', async () => {
  const { req } = await call('admin', 'Bearer key-admin');
  assert.deepEqual(req.user, {
    userId: 'user-a',
    username: 'alice',
    role: 'admin',
    // No cookie was sent, so there is no ambient authority for CSRF to protect.
    csrf: '',
  });
});

// ── 4. Insert keys ──────────────────────────────────────────────────────────

test('an insert key opens the insert surface and publishes its board', async () => {
  const { passed, req } = await call('insert', 'Bearer key-insert');
  assert.equal(passed, true);
  assert.deepEqual(req.apiKey, {
    id: 'k5',
    scope: 'insert',
    boardId: 'board-own',
    allowedColumns: undefined,
  });
  assert.equal(req.user.userId, 'user-a');
});

test('an insert key opens NOTHING on the ladder', async () => {
  for (const scope of ['management', 'admin'] as const) {
    const { passed, res } = await call(scope, 'Bearer key-insert');
    assert.equal(passed, false, `an insert key must not open ${scope}`);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /scope "insert" does not grant/);
  }
});

test('no ladder key opens the insert surface — not even admin', async () => {
  // The insert surface takes its board from the key; a ladder key has none.
  for (const key of ['key-admin', 'key-management']) {
    const { passed, res } = await call('insert', `Bearer ${key}`);
    assert.equal(passed, false, `${key} must not open the insert surface`);
    assert.equal(res.statusCode, 403);
  }
  const legacy = await call('insert', 'Bearer key-legacy');
  assert.equal(legacy.passed, false);
});

test('an insert key stops working as soon as its owner loses edit on the board', async () => {
  // The owner is NOT an admin here: an admin reaches every board by role.
  USERS['user-a'].role = 'advanced';
  try {
    SHARES['board-shared'] = 'edit';
    assert.equal((await call('insert', 'Bearer key-insert-shared')).passed, true);

    SHARES['board-shared'] = 'read';
    const demoted = await call('insert', 'Bearer key-insert-shared');
    assert.equal(demoted.passed, false, 'a read-only share cannot insert');
    assert.equal(demoted.res.statusCode, 403);
    assert.match(demoted.res.body.error, /can no longer edit/);

    SHARES['board-shared'] = undefined;
    const unshared = await call('insert', 'Bearer key-insert-shared');
    assert.equal(unshared.passed, false, 'an unshared board cannot be inserted into');

    touched.length = 0;
    await call('insert', 'Bearer key-insert-shared');
    assert.deepEqual(touched, [], 'a key refused for its board must not look used');
  } finally {
    USERS['user-a'].role = 'admin';
    SHARES['board-shared'] = 'edit';
  }
});

// ── Presentation and failure modes ──────────────────────────────────────────

test('a missing or malformed Authorization header is a 401, not a 403', async () => {
  const none = await call('admin');
  assert.equal(none.res.statusCode, 401);

  const wrong = await call('admin', 'Basic key-admin');
  assert.equal(wrong.res.statusCode, 401);
  assert.equal(wrong.passed, false);
});

test('an unknown key is refused without saying which half was wrong', async () => {
  const { passed, res } = await call('admin', 'Bearer key-does-not-exist');
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Invalid API key');
});

test('a database failure answers 503, never falls open', async () => {
  resolveThrows = true;
  try {
    const { passed, res } = await call('admin', 'Bearer key-admin');
    assert.equal(passed, false, 'an unavailable auth backend must not admit the request');
    assert.equal(res.statusCode, 503);
  } finally {
    resolveThrows = false;
  }
});

test('last_used_at is stamped for an accepted key and for no other', async () => {
  touched.length = 0;
  await call('admin', 'Bearer key-admin');
  assert.deepEqual(touched, ['k1']);

  touched.length = 0;
  await call('admin', 'Bearer key-management'); // wrong rung
  await call('admin', 'Bearer key-legacy'); // ownerless
  await call('admin', 'Bearer nope'); // unknown
  assert.deepEqual(touched, [], 'a refused key must not look "recently used"');
});

test('the guard is named with the scope it demands, so the route inventory sees it', () => {
  // Express keeps only the function reference: without this name, the
  // authorization ratchet in routeInventory.test.ts is blind to the guard and
  // an `admin` mount could be downgraded to `management` unnoticed.
  assert.equal(requireApiKeyScope('admin').name, 'requireApiKeyScope(admin)');
  assert.equal(requireApiKeyScope('management').name, 'requireApiKeyScope(management)');
  assert.equal(requireApiKeyScope('insert').name, 'requireApiKeyScope(insert)');
});
