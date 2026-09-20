import {
  httpsOrigin,
  validateRequest,
  sessionCookies,
  permissionOrigins,
  transferUrl,
} from './core.mjs';
import { ExtensionError, safeErrorMessage } from './errors.mjs';

// Only pairing metadata goes into storage.session. Credentials stay transient.
let transferring = false;
async function requestFromTab(tabId, documentId) {
  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) },
      func: () => {
        const nodes = document.querySelectorAll('[data-pulsar-browser-request]');
        if (!nodes.length) return { error: 'REQUEST_MISSING' };
        if (nodes.length !== 1) return { error: 'REQUEST_MULTIPLE' };
        try {
          return {
            request: JSON.parse(nodes[0].getAttribute('data-pulsar-browser-request')),
            url: location.href,
          };
        } catch {
          return { error: 'REQUEST_INVALID' };
        }
      },
    });
  } catch {
    throw new ExtensionError('APP_UNAVAILABLE');
  }
  if (!result?.result) throw new ExtensionError('REQUEST_MISSING');
  if (result.result.error) throw new ExtensionError(result.result.error);
  return {
    ...validateRequest(result.result.request, result.result.url),
    appTabId: tabId,
    appDocumentId: result.documentId,
  };
}

async function release(pair) {
  await chrome.storage.session.remove('pair');
  await chrome.alarms.clear('pair-expiry');
  if (pair?.grantedOrigins?.length) {
    await chrome.permissions.remove({ origins: pair.grantedOrigins });
  }
  if (pair?.grantedCookies) await chrome.permissions.remove({ permissions: ['cookies'] });
}

async function inspect(tabId) {
  const { pair } = await chrome.storage.session.get('pair');
  if (pair) {
    if (pair.expiresAt <= Date.now()) {
      await release(pair);
      throw new ExtensionError('PAIR_EXPIRED');
    }
    const tab = await chrome.tabs.get(tabId);
    if (tabId === pair.sourceTabId) {
      let currentOrigin;
      try {
        currentOrigin = httpsOrigin(tab.url);
      } catch {
        // Never expose an authentication callback's full URL in the popup.
      }
      if (currentOrigin === pair.site) return { mode: 'share', pair };
      return { mode: 'site_changed', pair, currentOrigin };
    }
    return { mode: 'waiting', pair };
  }
  return { mode: 'start', pair: await requestFromTab(tabId) };
}

async function returnToTab(restart) {
  if (transferring) throw new ExtensionError('TRANSFER_BUSY');
  const { pair } = await chrome.storage.session.get('pair');
  if (!pair) throw new ExtensionError('PAIR_MISSING');
  try {
    const tab = await chrome.tabs.update(restart ? pair.appTabId : pair.sourceTabId, {
      active: true,
    });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    throw new ExtensionError(restart ? 'APP_UNAVAILABLE' : 'SOURCE_UNAVAILABLE');
  }
  if (restart) await release(pair);
  return { ok: true };
}

async function begin(message) {
  const { pair: existing } = await chrome.storage.session.get('pair');
  if (existing) throw new ExtensionError('PAIR_EXISTS');
  // Re-read the original document after the native permission prompt.
  const pair = await requestFromTab(message.pair.appTabId, message.pair.appDocumentId);
  if (
    pair.requestId !== message.pair.requestId ||
    pair.site !== message.pair.site ||
    pair.appOrigin !== message.pair.appOrigin ||
    pair.scope !== message.pair.scope
  ) {
    throw new ExtensionError('REQUEST_CHANGED');
  }
  const permissions = {
    permissions: ['cookies'],
    origins: permissionOrigins(pair.site, pair.appOrigin),
  };
  if (!(await chrome.permissions.contains(permissions)))
    throw new ExtensionError('PERMISSIONS_REQUIRED');
  const source = await chrome.tabs.create({ url: pair.site, active: false });
  const stored = {
    ...pair,
    sourceTabId: source.id,
    grantedOrigins: message.grantedOrigins.filter(o => permissions.origins.includes(o)),
    grantedCookies: message.grantedCookies === true,
  };
  await chrome.storage.session.set({ pair: stored });
  await chrome.alarms.create('pair-expiry', { when: pair.expiresAt });
  await chrome.tabs.update(source.id, { active: true });
  return { ok: true };
}

async function transfer(message) {
  if (transferring) throw new ExtensionError('TRANSFER_BUSY');
  transferring = true;
  let pair;
  try {
    ({ pair } = await chrome.storage.session.get('pair'));
    if (!pair) throw new ExtensionError('PAIR_MISSING');
    if (pair.expiresAt <= Date.now()) throw new ExtensionError('PAIR_EXPIRED');
    if (pair.sourceTabId !== message.tabId) throw new ExtensionError('SOURCE_CHANGED');
    if (
      !(await chrome.permissions.contains({
        permissions: ['cookies'],
        origins: permissionOrigins(pair.site, pair.appOrigin),
      }))
    )
      throw new ExtensionError('PERMISSIONS_REQUIRED');
    let source;
    try {
      source = await chrome.tabs.get(pair.sourceTabId);
    } catch {
      throw new ExtensionError('SOURCE_UNAVAILABLE');
    }
    if (source.incognito || httpsOrigin(source.url) !== pair.site) {
      throw new ExtensionError('SOURCE_CHANGED');
    }
    const startUrl = transferUrl(source.url, pair.site);
    const destination = await requestFromTab(pair.appTabId, pair.appDocumentId);
    if (
      destination.requestId !== pair.requestId ||
      destination.site !== pair.site ||
      destination.scope !== pair.scope ||
      destination.appOrigin !== pair.appOrigin
    ) {
      throw new ExtensionError('REQUEST_CHANGED');
    }
    const stores = (await chrome.cookies.getAllCookieStores()).filter(s =>
      s.tabIds.includes(source.id)
    );
    if (stores.length !== 1) throw new ExtensionError('COOKIE_STORE_UNAVAILABLE');
    // Read only cookies that would be sent to the home/current page of this site.
    let root, current;
    try {
      root = await chrome.cookies.getAll({ url: pair.site + '/', storeId: stores[0].id });
      current = await chrome.cookies.getAll({ url: source.url, storeId: stores[0].id });
    } catch {
      throw new ExtensionError('COOKIE_ACCESS_FAILED');
    }
    const unique = new Map(
      [...root, ...current].map(c => [
        JSON.stringify([c.name, c.domain, c.path, c.partitionKey || null]),
        c,
      ])
    );
    const cookies = sessionCookies([...unique.values()], pair.site);
    let localStorage = [];
    if (message.includeLocalStorage === true) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: source.id },
          func: origin => {
            if (location.origin !== origin) return null;
            return Object.entries(window.localStorage).map(([name, value]) => ({ name, value }));
          },
          args: [pair.site],
        });
        localStorage = result?.result;
      } catch {
        throw new ExtensionError('STORAGE_UNAVAILABLE');
      }
      if (!Array.isArray(localStorage)) throw new ExtensionError('STORAGE_UNAVAILABLE');
    }
    let storage = { cookies, localStorage };
    if (!cookies.length && !localStorage.length) throw new ExtensionError('SESSION_EMPTY');
    if (new TextEncoder().encode(JSON.stringify(storage)).length > 500_000)
      throw new ExtensionError('SESSION_TOO_LARGE');
    let response;
    try {
      [response] = await chrome.scripting.executeScript({
        target: { tabId: pair.appTabId, documentIds: [pair.appDocumentId] },
        func: async (expected, storage, url) => {
          if (location.origin !== expected.appOrigin) return 'changed';
          const nodes = document.querySelectorAll('[data-pulsar-browser-request]');
          if (nodes.length !== 1) return 'changed';
          const node = nodes[0];
          const request = JSON.parse(node.getAttribute('data-pulsar-browser-request'));
          if (
            request.requestId !== expected.requestId ||
            request.site !== expected.site ||
            request.scope !== expected.scope ||
            request.expiresAt <= Date.now()
          )
            return 'changed';
          delete node.dataset.result;
          // Same-origin app tab sends using its own authenticated API/CSRF client.
          // No cookies in DOM attributes, extension messages, URLs or files.
          node.dispatchEvent(
            new CustomEvent('pulsar:browser-import', {
              detail: { requestId: expected.requestId, storage, url },
            })
          );
          // Release the credential reference while waiting for the app's acknowledgement.
          // eslint-disable-next-line no-useless-assignment
          storage = null;
          const deadline = Date.now() + 65_000;
          while (!node.dataset.result && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          return node.dataset.result || 'timeout';
        },
        args: [pair, storage, startUrl],
      });
    } catch {
      throw new ExtensionError('TRANSFER_UNCONFIRMED');
    } finally {
      storage = null;
      // Success or uncertain outcome must be checked in the app, never auto-retried.
      await release(pair);
      // Switching tabs closes the popup: only do so when the app has a result
      // to show. Keep uncertain-outcome diagnostics visible in the popup.
      if (response?.result === 'success' || response?.result === 'error')
        await chrome.tabs.update(pair.appTabId, { active: true }).catch(() => {});
    }
    if (response?.result === 'changed') throw new ExtensionError('REQUEST_CHANGED');
    if (response?.result === 'error') throw new ExtensionError('IMPORT_FAILED');
    if (response?.result !== 'success') throw new ExtensionError('TRANSFER_UNCONFIRMED');
    return { ok: true };
  } finally {
    transferring = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only this extension's popup can initiate a transfer; no content/external listener.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  const run = async () => {
    switch (message.type) {
      case 'inspect':
        return inspect(message.tabId);
      case 'begin':
        return begin(message);
      case 'transfer':
        return transfer(message);
      case 'return_to_website':
        return returnToTab(false);
      case 'restart':
        return returnToTab(true);
      case 'cancel': {
        if (transferring) throw new ExtensionError('TRANSFER_BUSY');
        const { pair } = await chrome.storage.session.get('pair');
        await release(pair);
        return { ok: true };
      }
      default:
        throw new ExtensionError('UNEXPECTED');
    }
  };
  run()
    .then(result => respond({ result }))
    .catch(error => {
      // Browser exceptions may contain page data. Never forward or log them.
      respond({
        error: safeErrorMessage(error),
        code: error instanceof ExtensionError ? error.code : 'UNEXPECTED',
      });
    });
  return true;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'pair-expiry' || transferring) return;
  const { pair } = await chrome.storage.session.get('pair');
  if (pair && pair.expiresAt <= Date.now()) await release(pair);
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const { pair } = await chrome.storage.session.get('pair');
  if (!transferring && pair && [pair.appTabId, pair.sourceTabId].includes(tabId))
    await release(pair);
});
chrome.runtime.onStartup.addListener(async () => {
  // Optional grants persist across restarts; pairing metadata deliberately doesn't.
  const permissions = await chrome.permissions.getAll();
  if (permissions.origins?.length)
    await chrome.permissions.remove({ origins: permissions.origins });
  if (permissions.permissions?.includes('cookies'))
    await chrome.permissions.remove({ permissions: ['cookies'] });
});
