import { ExtensionError, safeErrorMessage } from './errors.mjs';

const $ = id => document.getElementById(id);
const send = async message => {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error || !response?.result) throw new ExtensionError(response?.code);
  return response.result;
};

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { mode, pair } = await send({ type: 'inspect', tabId: tab.id });
  $('details').hidden = false;
  $('site').textContent = pair.site;
  $('destination').textContent = pair.appOrigin;
  $('scope').textContent = pair.scope;
  $('status').textContent =
    mode === 'start'
      ? 'Allow access to PulsarTeam, the website and its parent domains to read session cookies, then sign in using the tab that opens.'
      : mode === 'share'
        ? 'You sign in on your own computer. The session is shared only with this destination.'
        : 'Sign in using the website tab opened by this extension, then reopen the extension from that tab.';
  $('cancel').hidden = mode === 'start';
  $('cancel').onclick = async () => {
    try {
      await send({ type: 'cancel' });
      window.close();
    } catch (error) {
      $('status').textContent = safeErrorMessage(error);
    }
  };
  if (mode === 'waiting') return;
  $('action').hidden = false;
  $('action').textContent = mode === 'start' ? 'Open website' : 'Transfer session';
  $('notice').hidden = mode !== 'share';
  $('storage-option').hidden = mode !== 'share';
  // Read prior grants before the click so permissions.request keeps the user gesture.
  const origins = permissionOrigins(pair.site, pair.appOrigin);
  const prior = await Promise.all(
    origins.map(origin => chrome.permissions.contains({ origins: [origin] }))
  );
  const hadCookies = await chrome.permissions.contains({ permissions: ['cookies'] });
  $('action').onclick = async () => {
    $('action').disabled = true;
    try {
      if (mode === 'start') {
        const accepted = await chrome.permissions.request({ permissions: ['cookies'], origins });
        if (!accepted) throw new ExtensionError('PERMISSION_DENIED');
        const grantedOrigins = origins.filter((_, i) => !prior[i]);
        try {
          await send({ type: 'begin', pair, grantedOrigins, grantedCookies: !hadCookies });
        } catch (error) {
          if (grantedOrigins.length) await chrome.permissions.remove({ origins: grantedOrigins });
          if (!hadCookies) await chrome.permissions.remove({ permissions: ['cookies'] });
          throw error;
        }
      } else {
        $('status').textContent = 'Transfer in progress… You can check the result in PulsarTeam.';
        await send({
          type: 'transfer',
          tabId: tab.id,
          includeLocalStorage: $('local-storage').checked,
        });
      }
      window.close();
    } catch (error) {
      $('status').textContent = safeErrorMessage(error);
      $('action').disabled = false;
    }
  };
}
main().catch(error => {
  $('status').textContent = safeErrorMessage(error);
});
import { permissionOrigins } from './core.mjs';
