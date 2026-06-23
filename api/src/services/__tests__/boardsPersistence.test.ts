import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setPool } from '../database/connection.js';
import {
  createBoard,
  deleteBoard,
  getBoardsByUser,
  updateBoard,
} from '../database/boards.js';

afterEach(() => {
  setPool(null);
});

test('board CRUD persists through SQL-backed database helpers', async () => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  setPool({
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql.includes('COALESCE(MAX(position)')) return { rows: [{ next_pos: 4 }] };
      if (sql.includes('INSERT INTO boards')) {
        return { rows: [{ id: 'board-1', user_id: params?.[0], name: params?.[1], position: params?.[4] }] };
      }
      if (sql.includes('UPDATE boards SET')) {
        return { rows: [{ id: params?.[params.length - 1], name: 'Renamed' }] };
      }
      if (sql.includes('DELETE FROM boards')) return { rowCount: 1 };
      return { rows: [] };
    },
  } as any);

  const created = await createBoard('user-1', 'Roadmap', { columns: [{ id: 'todo', label: 'Todo' }] }, {});
  const updated = await updateBoard(created.id, { name: 'Renamed', workflow: { columns: [{ id: 'done', label: 'Done' }] } });
  const deleted = await deleteBoard(created.id);

  assert.equal(created.position, 4);
  assert.equal(updated.name, 'Renamed');
  assert.equal(deleted, true);
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO boards')));
  assert.ok(calls.some(call => call.sql.includes('UPDATE boards SET')));
  assert.ok(calls.some(call => call.sql.includes('DELETE FROM boards')));
});

test('getBoardsByUser reads own, shared, and default boards from the database', async () => {
  let capturedSql = '';
  setPool({
    query: async (sql: string, params?: any[]) => {
      capturedSql = sql;
      assert.deepEqual(params, ['user-1']);
      return {
        rows: [
          { id: 'owned-board', user_id: 'user-1', name: 'Owned', share_permission: null },
          { id: 'shared-board', user_id: 'user-2', name: 'Shared', share_permission: 'edit' },
          { id: 'default-board', user_id: null, name: 'Default', is_default: true, share_permission: 'read' },
        ],
      };
    },
  } as any);

  const boards = await getBoardsByUser('user-1');

  assert.equal(boards.length, 3);
  assert.deepEqual(boards.map((board: any) => board.id), ['owned-board', 'shared-board', 'default-board']);
  assert.match(capturedSql, /b\.user_id = \$1/);
  assert.match(capturedSql, /board_shares/);
  assert.match(capturedSql, /b\.is_default = TRUE/);
  assert.match(capturedSql, /'read' AS share_permission/);
});
