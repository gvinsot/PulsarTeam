import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthBrowserControl } from '../../api';
import { useConnectStatus, type ConnectWidgetProps } from '../connect/useConnectStatus';
import { errorMessage } from '../../utils/errors';

/** A plugin pinned to one site (e.g. LinkedIn): its own session slot, no URL field. */
export interface BrowserSitePreset {
  site: NonNullable<AuthBrowserControl['site']>;
  name: string;
  url: string;
}

export default function AuthBrowserConnect({
  agentId,
  boardId,
  onStatusChange,
  preset,
}: ConnectWidgetProps & { preset?: BrowserSitePreset }) {
  const site = preset?.site;
  const [url, setUrl] = useState(preset?.url ?? 'https://www.linkedin.com/');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bridge = useRef<HTMLDivElement>(null);
  const importing = useRef(false);
  const getStatus = useCallback(
    (agentId?: string, boardId?: string) =>
      api.authBrowserControl({ operation: 'status', agentId, boardId, site }),
    [site]
  );
  const { status, fetchStatus, statusError, loading, retry } = useConnectStatus(
    site ?? 'auth-browser',
    getStatus,
    agentId,
    boardId,
    onStatusChange
  );

  useEffect(() => {
    setError('');
  }, [agentId, boardId]);
  useEffect(() => {
    const node = bridge.current;
    if (!node || status.phase !== 'pending' || !status.canControl) return;
    // API independently checks user, edit permission, scope and one-use nonce.
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || detail.requestId !== status.sessionId || importing.current) return;
      importing.current = true;
      setBusy(true);
      setError('');
      void (async () => {
        try {
          await api.authBrowserControl({
            operation: 'import',
            agentId,
            boardId,
            site,
            sessionId: status.sessionId,
            storage: detail.storage,
          });
          node.dataset.result = 'success';
        } catch (e) {
          setError(errorMessage(e));
          node.dataset.result = 'error';
        } finally {
          // No credentials in React state, DOM attributes or localStorage.
          detail.storage = undefined;
          importing.current = false;
          setBusy(false);
          await fetchStatus();
        }
      })();
    };
    node.addEventListener('pulsar:browser-import', receive);
    return () => node.removeEventListener('pulsar:browser-import', receive);
  }, [agentId, boardId, site, status.phase, status.canControl, status.sessionId, fetchStatus]);

  async function action(operation: AuthBrowserControl['operation']) {
    setBusy(true);
    setError('');
    try {
      if (operation === 'prepare_import') {
        const site = new URL(url);
        if (
          location.protocol !== 'https:' ||
          site.protocol !== 'https:' ||
          site.username ||
          site.password ||
          (site.port && site.port !== '443') ||
          site.origin === location.origin
        ) {
          throw new Error('Ouvrez PulsarTeam en HTTPS et choisissez un site HTTPS distinct.');
        }
      }
      await api.authBrowserControl({
        operation,
        agentId,
        boardId,
        site,
        sessionId: status.sessionId,
        // A pinned site is chosen server-side, never sent from the client.
        ...(operation === 'prepare_import' && !preset ? { url } : {}),
      });
      await fetchStatus();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const pending = status.phase === 'pending' && status.canControl;
  const button =
    'px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50';
  return (
    <div className="space-y-2 border-t border-dark-700 pt-3 text-xs">
      <p className="text-dark-300">
        {preset
          ? `Connexion à ${preset.name} dans votre navigateur. Navigation des agents sur le cluster, en lecture seule.`
          : 'Connexion dans votre navigateur. Navigation des agents sur le cluster.'}
      </p>
      <p className="text-dark-400">
        Session pour {agentId ? 'cet agent' : 'ce board et ses agents'}.
      </p>
      {!loading && !statusError && status.configured === false && (
        <p className="text-amber-300">
          Le service de navigateur doit être configuré par l’administrateur.
        </p>
      )}
      {loading && <p className="text-dark-400">Vérification du service de navigateur…</p>}
      {statusError && (
        <button type="button" className={button} onClick={retry}>
          Réessayer la connexion au service
        </button>
      )}
      {!status.exists ? (
        <>
          {!preset && (
            <label className="block">
              Adresse du site
              <input
                aria-label="Adresse du site"
                type="url"
                className="block w-full bg-dark-900 border border-dark-600 rounded p-2 mt-1"
                value={url}
                onChange={e => setUrl(e.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            className={button}
            disabled={busy || !status.configured || (!agentId && !boardId)}
            onClick={() => void action('prepare_import')}
          >
            {busy
              ? 'Préparation…'
              : preset
                ? `Se connecter à ${preset.name}`
                : 'Connecter dans mon navigateur'}
          </button>
        </>
      ) : (
        <>
          <p className="text-dark-300 break-all">
            {preset?.name ?? status.site} —{' '}
            {status.connected
              ? 'Session partagée sur le cluster'
              : status.phase === 'pending'
                ? 'En attente du transfert'
                : 'Accès des agents suspendu'}
          </p>
          {status.expiresAt && (
            <p className="text-dark-400">
              Expiration au plus tard : {new Date(status.expiresAt).toLocaleString()}.
            </p>
          )}
          {pending && (
            <div
              ref={bridge}
              data-pulsar-browser-request={JSON.stringify({
                version: 1,
                requestId: status.sessionId,
                site: status.site,
                expiresAt: status.expiresAt,
                scope: agentId ? `agent:${agentId}` : `board:${boardId}`,
              })}
            >
              <ol className="list-decimal ml-4 space-y-1 text-dark-200">
                <li>
                  Ouvrez l’extension PulsarTeam depuis cet onglet, puis cliquez « Ouvrir le site ».
                </li>
                <li>Connectez-vous normalement sur le site et vérifiez le compte affiché.</li>
                <li>
                  Dans cet onglet du site, ouvrez l’extension puis cliquez « Transférer la session
                  ».
                </li>
              </ol>
              <p className="text-amber-300 mt-2">
                Le transfert copie vos cookies de connexion sur le cluster et donne accès à ce
                compte aux agents sélectionnés. Gardez cet onglet PulsarTeam ouvert.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {status.canControl && status.phase !== 'pending' && (
              <button
                type="button"
                disabled={busy}
                className={button}
                onClick={() => void action(status.connected ? 'takeover' : 'activate')}
              >
                {status.connected ? 'Suspendre' : 'Reprendre le partage'}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() => void action('disconnect')}
            >
              {status.phase === 'pending' ? 'Annuler' : 'Déconnecter'}
            </button>
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() => void fetchStatus()}
            >
              Actualiser
            </button>
          </div>
        </>
      )}
      <details className="text-dark-400">
        <summary className="cursor-pointer">Installer l’extension Chrome / Edge</summary>
        <p className="mt-1">
          Téléchargez et décompressez l’extension. Dans chrome://extensions ou edge://extensions,
          activez le mode développeur, puis « Charger l’extension non empaquetée » et sélectionnez
          ce dossier.
        </p>
        <a href="/extensions/pulsarteam-session.zip" download className="text-indigo-300 underline">
          Télécharger l’extension
        </a>
      </details>
      <p className="text-dark-400">
        La connexion et le MFA restent dans votre navigateur. Une session liée à l’appareil ou
        refusée par le site, notamment LinkedIn, peut ne pas fonctionner sur le cluster. Une
        expiration nécessite un nouveau transfert.
      </p>
      {site === 'linkedin' && (
        <p className="text-dark-400">
          Les agents lisent avec votre compte (recherche, profils, pages entreprise, fil), sans
          jamais écrire ni envoyer de message, au rythme d’une page toutes les 3 s et de 120 pages
          par heure au maximum. LinkedIn restreint l’automatisation de son site et peut limiter un
          compte : partagez de préférence un compte dont vous acceptez ce risque.
        </p>
      )}
      {busy && <p className="text-dark-300">Opération en cours…</p>}
      {(error || statusError) && (
        <p role="alert" className="text-red-400">
          {error || statusError}
        </p>
      )}
    </div>
  );
}
