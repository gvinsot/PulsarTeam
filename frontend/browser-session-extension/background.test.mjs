import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
const cookie = {
  name: 'li_at',
  value: 'synthetic-session',
  domain: '.linkedin.com',
  path: '/',
  httpOnly: true,
  session: true,
  sameSite: 'no_restriction',
  hostOnly: false,
};

async function background(t, options = {}) {
  const pair = {
    version: 1,
    requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    scope: 'board:selected',
    expiresAt: Date.now() + 600_000,
    site: 'https://www.linkedin.com',
    appOrigin: 'https://pulsar.test',
    appTabId: 1,
    appDocumentId: 'original-app-document',
    sourceTabId: 2,
    grantedOrigins: ['https://www.linkedin.com/*', 'https://linkedin.com/*'],
    grantedCookies: true,
  };
  const state = {
    pair,
    imports: [],
    activated: [],
    removedPermissions: [],
    clearedAlarms: [],
    cookieReads: 0,
  };
  let listener;
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: callback => (listener = callback) },
      onStartup: { addListener() {} },
    },
    storage: {
      session: {
        get: async () => ({ pair: state.pair }),
        set: async value => Object.assign(state, value),
        remove: async () => {
          state.pair = undefined;
        },
      },
    },
    alarms: {
      create: async () => {},
      clear: async name => state.clearedAlarms.push(name),
      onAlarm: { addListener() {} },
    },
    permissions: {
      contains: async () => options.permissions !== false,
      remove: async permissions => state.removedPermissions.push(permissions),
    },
    tabs: {
      get: async id => ({ id, url: `${pair.site}/feed/`, incognito: false }),
      update: async id => state.activated.push(id),
      onRemoved: { addListener() {} },
    },
    cookies: {
      getAllCookieStores: async () => [{ id: 'default', tabIds: [pair.sourceTabId] }],
      getAll: async () => {
        state.cookieReads += 1;
        return options.cookies || [cookie];
      },
    },
    scripting: {
      executeScript: async execution => {
        if (execution.args?.length === 2) {
          state.imports.push(structuredClone(execution.args));
          if (options.importError) throw options.importError;
          return [{ result: options.importResult || 'success' }];
        }
        if (options.destinationError) throw options.destinationError;
        return [
          {
            documentId: pair.appDocumentId,
            result: {
              request: { ...pair, ...options.destination },
              url: `${pair.appOrigin}/boards/selected`,
            },
          },
        ];
      },
    },
  };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
  await import(`./background.js?test=${++instance}`);
  const send = message =>
    new Promise(resolve => {
      const result = listener(
        message,
        { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') },
        resolve
      );
      assert.equal(result, true, 'background keeps the reply channel open');
    });
  return {
    chrome,
    state,
    transfer: () => send({ type: 'transfer', tabId: pair.sourceTabId }),
  };
}

test('same-value cookies on the parent and selected host transfer once, then release the pair', async t => {
  const { transfer, state } = await background(t, {
    cookies: [cookie, { ...cookie, domain: 'www.linkedin.com', hostOnly: true }],
  });
  assert.deepEqual(await transfer(), { result: { ok: true } });
  assert.equal(state.imports.length, 1);
  const [destination, storage] = state.imports[0];
  assert.equal(destination.appDocumentId, 'original-app-document');
  assert.equal(storage.cookies.length, 1);
  assert.equal(storage.cookies[0].value, cookie.value);
  assert.equal(storage.cookies[0].httpOnly, true);
  assert.equal('domain' in storage.cookies[0], false);
  assert.equal(state.pair, undefined);
  assert.deepEqual(state.clearedAlarms, ['pair-expiry']);
  assert.deepEqual(state.activated, [1]);
  assert.ok(state.removedPermissions.some(value => value.permissions?.includes('cookies')));
});

test('conflicting cookie values are explained without forwarding credentials or importing them', async t => {
  const { transfer, state } = await background(t, {
    cookies: [
      cookie,
      { ...cookie, domain: 'www.linkedin.com', hostOnly: true, value: 'other-session-secret' },
    ],
  });
  const response = await transfer();
  assert.equal(response.code, 'AMBIGUOUS_COOKIES');
  assert.match(response.error, /cookies/i);
  assert.match(response.error, /ambiguous|different|conflict|incompatible/i);
  assert.doesNotMatch(response.error, /synthetic-session|other-session-secret/);
  assert.equal(state.imports.length, 0);
});

test('a disappeared PulsarTeam document has an actionable destination diagnostic', async t => {
  const { transfer, state } = await background(t, {
    destinationError: new Error('No document original-app-document: secret-page-data'),
  });
  const response = await transfer();
  assert.equal(response.code, 'APP_UNAVAILABLE');
  assert.match(response.error, /PulsarTeam/);
  assert.match(response.error, /tab|request|destination/i);
  assert.doesNotMatch(response.error, /secret-page-data|original-app-document/);
  assert.equal(state.cookieReads, 0);
  assert.equal(state.imports.length, 0);
});

test('a replaced pairing request is rejected before cookies are collected', async t => {
  const { transfer, state } = await background(t, {
    destination: { requestId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  });
  const response = await transfer();
  assert.equal(response.code, 'REQUEST_CHANGED');
  assert.match(response.error, /changed|replaced/i);
  assert.match(response.error, /PulsarTeam|request|destination/i);
  assert.equal(state.cookieReads, 0);
  assert.equal(state.imports.length, 0);
});

test('revoked cookie permissions are diagnosed before collecting the session', async t => {
  const { transfer, state } = await background(t, { permissions: false });
  const response = await transfer();
  assert.equal(response.code, 'PERMISSIONS_REQUIRED');
  assert.match(response.error, /permission|access/i);
  assert.equal(state.cookieReads, 0);
  assert.equal(state.imports.length, 0);
});

test('an import error points to PulsarTeam and releases the pair to prevent a second import', async t => {
  const { transfer, state } = await background(t, { importResult: 'error' });
  const response = await transfer();
  assert.equal(response.code, 'IMPORT_FAILED');
  assert.match(response.error, /PulsarTeam/i);
  assert.match(response.error, /check/i);
  assert.equal(state.pair, undefined);
  assert.deepEqual(state.activated, [1]);
  assert.equal(state.imports.length, 1);
  assert.ok((await transfer()).error);
  assert.equal(state.imports.length, 1);
});

test('an interrupted import cannot be replayed when its outcome is unknown', async t => {
  const { transfer, state } = await background(t, {
    importError: new Error('Document unloaded after dispatch: private-test-credential'),
  });
  const response = await transfer();
  assert.equal(response.code, 'TRANSFER_UNCONFIRMED');
  assert.match(response.error, /PulsarTeam/i);
  assert.doesNotMatch(JSON.stringify(response), /private-test-credential|Document unloaded/);
  assert.equal(state.pair, undefined);
  assert.deepEqual(state.activated, []);
  assert.deepEqual(state.clearedAlarms, ['pair-expiry']);
  assert.equal(state.imports.length, 1);
  assert.equal((await transfer()).code, 'PAIR_MISSING');
  assert.equal(state.imports.length, 1);
});

test('a changed destination and a missing acknowledgement have distinct diagnostics', async t => {
  for (const [importResult, expectedCode] of [
    ['changed', 'REQUEST_CHANGED'],
    ['timeout', 'TRANSFER_UNCONFIRMED'],
  ]) {
    await t.test(importResult, async t => {
      const { transfer, state } = await background(t, { importResult });
      const response = await transfer();
      assert.equal(response.code, expectedCode);
      assert.match(response.error, /PulsarTeam/);
      assert.equal(state.pair, undefined);
      assert.deepEqual(state.activated, []);
      assert.equal(state.imports.length, 1);
    });
  }
});

test('a cookie collection failure stays private and does not lock later transfers', async t => {
  const { chrome, transfer, state } = await background(t);
  const collect = chrome.cookies.getAll;
  chrome.cookies.getAll = async () => {
    throw new Error('Cookie backend crashed: li_at=private-test-credential');
  };
  const response = await transfer();
  assert.equal(response.code, 'COOKIE_ACCESS_FAILED');
  assert.equal(typeof response.error, 'string');
  assert.ok(response.error.length > 0);
  assert.doesNotMatch(JSON.stringify(response), /private-test-credential|Cookie backend crashed/);
  assert.equal(state.imports.length, 0);
  chrome.cookies.getAll = collect;
  assert.deepEqual(await transfer(), { result: { ok: true } });
  assert.equal(state.imports.length, 1);
});

test('an unexpected browser exception is reduced to a fixed message without leaking secrets', async t => {
  const { chrome, transfer, state } = await background(t);
  chrome.cookies.getAllCookieStores = async () => {
    throw new Error('Browser internals: private-test-credential');
  };
  const response = await transfer();
  assert.equal(response.code, 'UNEXPECTED');
  assert.match(response.error, /unexpected/i);
  assert.doesNotMatch(JSON.stringify(response), /private-test-credential|Browser internals/);
  assert.equal(state.imports.length, 0);
});
