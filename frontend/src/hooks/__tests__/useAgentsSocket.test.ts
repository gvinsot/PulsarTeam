import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { WsEvents } from '../../socketEvents.js';

// Exercise the actual socket handlers and functional state updates without a
// DOM. Effects only clear thinking; stream lifecycle is owned by the handlers.
const cells: { value: any }[] = [];
const handlers = new Map<string, (payload: any) => void>();
const sent: string[] = [];
const socket = {
  connected: true,
  on: (event: string, handler: (payload: any) => void) => handlers.set(event, handler),
  off: (event: string) => handlers.delete(event),
  emit: (event: string) => sent.push(event),
};
mock.module('react', {
  namedExports: {
    useState(initial: unknown) {
      const cell = { value: initial };
      cells.push(cell);
      return [
        initial,
        (value: any) => {
          cell.value = typeof value === 'function' ? value(cell.value) : value;
        },
      ];
    },
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (fn: unknown) => fn,
    useEffect() {},
  },
});
mock.module(new URL('../../socket.ts', import.meta.url).href, {
  namedExports: { connectSocket: () => socket, getSocket: () => socket },
});
const { useAgentsSocket } = await import('../useAgentsSocket.js');
const emit = (event: string, payload: unknown) => handlers.get(event)!(payload);

test('idle with a lost END reconciles and releases the stale chat buffer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cells.length = sent.length = 0;
  const hook = useAgentsSocket({ current: () => {} });
  t.after(hook.teardown);
  hook.initSocket();
  assert.equal(sent.at(-1), WsEvents.REQ_STREAM_STATE);
  emit(WsEvents.AGENTS_LIST, [{ id: 'a', status: 'busy' }]);
  emit(WsEvents.STREAM_START, { agentId: 'a' });
  emit(WsEvents.STREAM_CHUNK, { agentId: 'a', chunk: 'Incomplete report' });
  emit(WsEvents.AGENT_STATUS, { id: 'a', status: 'idle' });
  t.mock.timers.tick(1_000);
  assert.equal(sent.at(-1), WsEvents.REQ_STREAM_STATE);
  assert.equal(cells[2].value.a, 'Incomplete report');
  emit(WsEvents.STREAM_RESUME, { streams: [] });
  assert.equal(cells[2].value.a, undefined);
  assert.equal(sent.at(-1), WsEvents.REQ_REFRESH);
});

test('a duplicate agent update still completes cleanup after END', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cells.length = sent.length = 0;
  const hook = useAgentsSocket({ current: () => {} });
  t.after(hook.teardown);
  hook.initSocket();
  const agent = { id: 'a', status: 'idle' };
  emit(WsEvents.AGENTS_LIST, [agent]);
  emit(WsEvents.STREAM_START, { agentId: 'a' });
  emit(WsEvents.STREAM_CHUNK, { agentId: 'a', chunk: 'Complete report' });
  emit(WsEvents.AGENT_UPDATED, agent);
  emit(WsEvents.STREAM_END, { agentId: 'a' });
  emit(WsEvents.AGENT_UPDATED, agent);
  assert.equal(cells[2].value.a, undefined);
});

test('a capped server snapshot preserves an intact local transcript', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cells.length = sent.length = 0;
  const hook = useAgentsSocket({ current: () => {} });
  t.after(hook.teardown);
  hook.initSocket();
  emit(WsEvents.STREAM_START, { agentId: 'a' });
  const full = 'Beginning\n' + 'x'.repeat(210_000);
  emit(WsEvents.STREAM_CHUNK, { agentId: 'a', chunk: full });
  emit(WsEvents.STREAM_RESUME, { streams: [{ agentId: 'a', buffer: '…' + full.slice(-199_999) }] });
  assert.equal(cells[2].value.a, full);
});
