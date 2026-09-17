const $ = id => document.getElementById(id);
const send = async message => {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error || !response?.result)
    throw new Error(response?.error || 'Extension indisponible.');
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
      ? 'Autorisez PulsarTeam, le site et ses domaines parents pour accéder aux cookies de connexion, puis connectez-vous dans l’onglet qui va s’ouvrir.'
      : mode === 'share'
        ? 'La connexion se fait sur votre poste. Le partage est valable pour cette destination uniquement.'
        : 'Connectez-vous dans l’onglet du site ouvert par cette extension, puis rouvrez l’extension depuis cet onglet.';
  $('cancel').hidden = mode === 'start';
  $('cancel').onclick = async () => {
    await send({ type: 'cancel' });
    window.close();
  };
  if (mode === 'waiting') return;
  $('action').hidden = false;
  $('action').textContent = mode === 'start' ? 'Ouvrir le site' : 'Transférer la session';
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
        if (!accepted) throw new Error('Permission refusée. Aucun transfert effectué.');
        const grantedOrigins = origins.filter((_, i) => !prior[i]);
        try {
          await send({ type: 'begin', pair, grantedOrigins, grantedCookies: !hadCookies });
        } catch (error) {
          if (grantedOrigins.length) await chrome.permissions.remove({ origins: grantedOrigins });
          if (!hadCookies) await chrome.permissions.remove({ permissions: ['cookies'] });
          throw error;
        }
      } else {
        $('status').textContent =
          'Transfert en cours… Vous pouvez consulter son résultat dans PulsarTeam.';
        await send({
          type: 'transfer',
          tabId: tab.id,
          includeLocalStorage: $('local-storage').checked,
        });
      }
      window.close();
    } catch (error) {
      $('status').textContent = error.message;
      $('action').disabled = false;
    }
  };
}
main().catch(() => {
  $('status').textContent =
    'Dans PulsarTeam, cliquez sur « Connecter dans mon navigateur », puis ouvrez cette extension depuis ce même onglet.';
});
import { permissionOrigins } from './core.mjs';
