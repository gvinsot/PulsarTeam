import { httpsOrigin, validateRequest, sessionCookies, permissionOrigins } from './core.mjs';

// Only pairing metadata goes into storage.session. Credentials stay transient.
let transferring = false;
async function requestFromTab(tabId, documentId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) },
    func: () => {
      const nodes = document.querySelectorAll('[data-pulsar-browser-request]');
      if (nodes.length !== 1) return null;
      return {
        request: JSON.parse(nodes[0].getAttribute('data-pulsar-browser-request')),
        url: location.href,
      };
    },
  });
  if (!result?.result)
    throw new Error('Préparez une connexion dans le plugin PulsarTeam, dans cet onglet.');
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
      throw new Error('Demande expirée. Annulez puis reconnectez dans PulsarTeam.');
    }
    const tab = await chrome.tabs.get(tabId);
    if (tabId === pair.sourceTabId && httpsOrigin(tab.url) === pair.site) {
      return { mode: 'share', pair };
    }
    return { mode: 'waiting', pair };
  }
  return { mode: 'start', pair: await requestFromTab(tabId) };
}

async function begin(message) {
  const { pair: existing } = await chrome.storage.session.get('pair');
  if (existing) throw new Error('Annulez la connexion précédente avant de recommencer.');
  // Re-read the original document after the native permission prompt.
  const pair = await requestFromTab(message.pair.appTabId, message.pair.appDocumentId);
  if (
    pair.requestId !== message.pair.requestId ||
    pair.site !== message.pair.site ||
    pair.appOrigin !== message.pair.appOrigin ||
    pair.scope !== message.pair.scope
  ) {
    throw new Error('La demande a changé. Recommencez.');
  }
  const permissions = {
    permissions: ['cookies'],
    origins: permissionOrigins(pair.site, pair.appOrigin),
  };
  if (!(await chrome.permissions.contains(permissions)))
    throw new Error('Autorisation du navigateur manquante.');
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
  if (transferring) throw new Error('Un transfert est déjà en cours.');
  transferring = true;
  let pair;
  try {
    ({ pair } = await chrome.storage.session.get('pair'));
    if (!pair || pair.sourceTabId !== message.tabId || pair.expiresAt <= Date.now()) {
      throw new Error('Onglet incorrect ou demande expirée.');
    }
    const source = await chrome.tabs.get(pair.sourceTabId);
    if (source.incognito || httpsOrigin(source.url) !== pair.site) {
      throw new Error('Revenez dans l’onglet du site choisi après la connexion.');
    }
    const destination = await requestFromTab(pair.appTabId, pair.appDocumentId);
    if (
      destination.requestId !== pair.requestId ||
      destination.site !== pair.site ||
      destination.scope !== pair.scope ||
      destination.appOrigin !== pair.appOrigin
    ) {
      throw new Error('La destination PulsarTeam a changé. Recommencez.');
    }
    const stores = (await chrome.cookies.getAllCookieStores()).filter(s =>
      s.tabIds.includes(source.id)
    );
    if (stores.length !== 1) throw new Error('Impossible d’identifier le profil de cet onglet.');
    // Read only cookies that would be sent to the home/current page of this site.
    const root = await chrome.cookies.getAll({ url: pair.site + '/', storeId: stores[0].id });
    const current = await chrome.cookies.getAll({ url: source.url, storeId: stores[0].id });
    const unique = new Map(
      [...root, ...current].map(c => [
        JSON.stringify([c.name, c.domain, c.path, c.partitionKey || null]),
        c,
      ])
    );
    const cookies = sessionCookies([...unique.values()], pair.site);
    let localStorage = [];
    if (message.includeLocalStorage === true) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: source.id },
        func: origin => {
          if (location.origin !== origin) throw new Error('Site changed');
          return Object.entries(window.localStorage).map(([name, value]) => ({ name, value }));
        },
        args: [pair.site],
      });
      localStorage = result.result;
    }
    let storage = { cookies, localStorage };
    if ((!cookies.length && !localStorage.length) || JSON.stringify(storage).length > 500_000) {
      throw new Error(
        'Session vide ou trop volumineuse. Connectez-vous au site avant de transférer.'
      );
    }
    const [response] = await chrome.scripting.executeScript({
      target: { tabId: pair.appTabId, documentIds: [pair.appDocumentId] },
      func: async (expected, storage) => {
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
            detail: { requestId: expected.requestId, storage },
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
      args: [pair, storage],
    });
    storage = null;
    // Success or uncertain outcome must be checked in the app, never auto-retried.
    await release(pair);
    await chrome.tabs.update(pair.appTabId, { active: true });
    if (response?.result !== 'success')
      throw new Error('Vérifiez le résultat du transfert dans PulsarTeam.');
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
      case 'cancel': {
        if (transferring) throw new Error('Attendez la fin du transfert.');
        const { pair } = await chrome.storage.session.get('pair');
        await release(pair);
        return { ok: true };
      }
      default:
        throw new Error('Commande inconnue.');
    }
  };
  run()
    .then(result => respond({ result }))
    .catch(() => {
      // Browser exceptions may contain page data. Never forward or log them.
      respond({
        error:
          'Opération impossible. Vérifiez le site, les permissions et la demande dans PulsarTeam, puis recommencez.',
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
