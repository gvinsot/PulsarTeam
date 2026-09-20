import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

let instance = 0;

async function popup(t, options = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id))
      elements.set(id, { hidden: true, disabled: false, textContent: '', checked: false });
    return elements.get(id);
  };
  const state = { closed: false, messages: [] };
  const chrome = {
    tabs: { query: async () => [{ id: 2 }] },
    permissions: { contains: async () => true },
    runtime: {
      sendMessage: async message => {
        state.messages.push(message);
        if (message.type === 'inspect') {
          if (options.inspectError) return options.inspectError;
          return {
            result: {
              mode: 'share',
              pair: {
                site: 'https://www.linkedin.com',
                appOrigin: 'https://pulsar.test',
                scope: 'board:selected',
              },
            },
          };
        }
        return options.action ? options.action(message) : { result: { ok: true } };
      },
    },
  };
  const original = {
    chrome: globalThis.chrome,
    document: globalThis.document,
    window: globalThis.window,
  };
  globalThis.chrome = chrome;
  globalThis.document = { getElementById: element };
  globalThis.window = {
    close() {
      state.closed = true;
    },
  };
  t.after(() => Object.assign(globalThis, original));
  await import(`./popup.js?test=${++instance}`);
  await setImmediate();
  return { chrome, state, element };
}

test('opening the popup preserves the actionable diagnostic returned by the background', async t => {
  const diagnostic =
    'The request expired after ten minutes. Cancel it and reconnect in PulsarTeam.';
  const { element, state } = await popup(t, {
    inspectError: { error: diagnostic, code: 'PAIR_EXPIRED' },
  });
  assert.equal(element('status').textContent, diagnostic);
  assert.equal(element('action').hidden, true);
  assert.equal(state.closed, false);
});

test('a failed transfer displays its safe diagnostic and permits a deliberate retry', async t => {
  const diagnostic =
    'Permission to access cookies or websites was revoked. Cancel pairing and start again, allowing the requested permissions.';
  let attempts = 0;
  const { element, state } = await popup(t, {
    action: () =>
      ++attempts === 1
        ? { error: diagnostic, code: 'PERMISSIONS_REQUIRED' }
        : { result: { ok: true } },
  });
  element('local-storage').checked = true;
  await element('action').onclick();
  assert.equal(element('status').textContent, diagnostic);
  assert.equal(element('action').disabled, false);
  assert.equal(state.closed, false);
  assert.deepEqual(state.messages.at(-1), {
    type: 'transfer',
    tabId: 2,
    includeLocalStorage: true,
  });
  await element('action').onclick();
  assert.equal(state.closed, true);
});

test('an unexpected browser failure cannot expose its raw exception in the popup', async t => {
  const { element, state } = await popup(t, {
    action: () => {
      throw new Error('Transport failed: li_at=private-test-credential');
    },
  });
  await element('action').onclick();
  assert.ok(element('status').textContent.length > 0);
  assert.doesNotMatch(element('status').textContent, /private-test-credential|Transport failed/);
  assert.equal(element('action').disabled, false);
  assert.equal(state.closed, false);
});

test('an unrecognized background error cannot insert arbitrary text into the popup', async t => {
  const { element } = await popup(t, {
    inspectError: { error: 'Unknown error: private-test-credential', code: 'UNRECOGNIZED' },
  });
  assert.match(element('status').textContent, /unexpected/i);
  assert.doesNotMatch(element('status').textContent, /private-test-credential|Unknown error/);
});
