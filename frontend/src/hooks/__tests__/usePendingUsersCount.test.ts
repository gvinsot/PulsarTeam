import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { WsEvents } from '../../socketEvents.js';

// Drive the hook without a DOM: useState cells are observable, effects run
// immediately (their cleanups are collected), and the api module is faked.
const cells: { value: unknown }[] = [];
const cleanups: (() => void)[] = [];
let countAnswer = 3;
let countCalls = 0;
mock.module('react', {
  namedExports: {
    useState(initial: unknown) {
      const cell = { value: initial };
      cells.push(cell);
      return [
        initial,
        (value: unknown) => {
          cell.value = typeof value === 'function' ? value(cell.value) : value;
        },
      ];
    },
    useCallback: (fn: unknown) => fn,
    useEffect(effect: () => void | (() => void)) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
  },
});
mock.module(new URL('../../api.ts', import.meta.url).href, {
  namedExports: {
    api: {
      getPendingUsersCount: async () => {
        countCalls += 1;
        return { count: countAnswer };
      },
    },
  },
});
const { usePendingUsersCount } = await import('../usePendingUsersCount.js');

function fakeSocket() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  return {
    handlers,
    on: (event: string, handler: (payload?: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function reset() {
  cells.length = 0;
  cleanups.length = 0;
  countCalls = 0;
  countAnswer = 3;
}

test('an admin gets the count at load and live from users:pending', async () => {
  reset();
  const socket = fakeSocket();
  usePendingUsersCount(true, socket as never);
  await flush();
  assert.equal(countCalls, 1);
  assert.equal(cells[0].value, 3);

  socket.handlers.get(WsEvents.USERS_PENDING)?.({ count: 5 });
  assert.equal(cells[0].value, 5);

  // Malformed payloads are ignored rather than shown.
  socket.handlers.get(WsEvents.USERS_PENDING)?.({ count: 'many' });
  socket.handlers.get(WsEvents.USERS_PENDING)?.({ count: -1 });
  assert.equal(cells[0].value, 5);

  // A reconnect may have missed events: re-fetch.
  countAnswer = 0;
  socket.handlers.get('connect')?.();
  await flush();
  assert.equal(countCalls, 2);
  assert.equal(cells[0].value, 0);

  cleanups.forEach(fn => fn());
  assert.equal(socket.handlers.size, 0);
});

test('a non-admin neither fetches nor listens', async () => {
  reset();
  const socket = fakeSocket();
  usePendingUsersCount(false, socket as never);
  await flush();
  assert.equal(countCalls, 0);
  assert.equal(socket.handlers.size, 0);
  assert.equal(cells[0].value, 0);
});

test('without a socket yet, the count is still fetched', async () => {
  reset();
  usePendingUsersCount(true, null);
  await flush();
  assert.equal(countCalls, 1);
  assert.equal(cells[0].value, 3);
});
