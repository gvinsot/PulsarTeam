import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthBrowserControl, type AuthBrowserFrame } from '../../api';
import { useConnectStatus, type ConnectWidgetProps } from '../connect/useConnectStatus';
import { errorMessage } from '../../utils/errors';

export default function AuthBrowserConnect({
  agentId,
  boardId,
  onStatusChange,
}: ConnectWidgetProps) {
  const [url, setUrl] = useState('https://www.linkedin.com/');
  const [origins, setOrigins] = useState('');
  const [viewer, setViewer] = useState(false);
  const [frame, setFrame] = useState<AuthBrowserFrame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const queue = useRef(Promise.resolve());
  const getStatus = useCallback(
    (agentId?: string, boardId?: string) =>
      api.authBrowserControl({ operation: 'status', agentId, boardId }),
    []
  );
  const { status, fetchStatus, statusError } = useConnectStatus(
    'auth-browser',
    getStatus,
    agentId,
    boardId,
    onStatusChange
  );
  const control = useCallback(
    (operation: AuthBrowserControl['operation'], data: Partial<AuthBrowserControl> = {}) =>
      api.authBrowserControl({ ...data, operation, agentId, boardId, sessionId: status.sessionId }),
    [agentId, boardId, status.sessionId]
  );

  useEffect(() => {
    setViewer(false);
    setFrame(null);
    setError('');
  }, [agentId, boardId]);

  useEffect(() => {
    if (!viewer || !status.sessionId || status.phase !== 'login') {
      setFrame(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const image = await api.authBrowserControl<AuthBrowserFrame>({
          operation: 'frame',
          agentId,
          boardId,
          sessionId: status.sessionId,
        });
        if (!stopped) setFrame(image);
      } catch (e) {
        if (!stopped) {
          setError(errorMessage(e));
          setViewer(false);
          void fetchStatus();
        }
      } finally {
        if (!stopped) timer = setTimeout(refresh, 1200);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [viewer, status.sessionId, status.phase, agentId, boardId, fetchStatus]);

  async function action(operation: AuthBrowserControl['operation']) {
    setBusy(true);
    setError('');
    try {
      await queue.current;
      await control(
        operation,
        operation === 'start' ? { url, loginOrigins: origins.split(/[\s,]+/).filter(Boolean) } : {}
      );
      await fetchStatus();
      setViewer(operation === 'start' || operation === 'takeover');
      setFrame(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function input(
    operation: 'click' | 'key' | 'text' | 'wheel' | 'back' | 'home',
    data: Partial<AuthBrowserControl>
  ) {
    // Preserve key/click ordering, without saving input in React state or logs.
    queue.current = queue.current
      .then(async () => {
        await control(operation, data);
      })
      .catch(e => setError(errorMessage(e)));
  }
  const button =
    'px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50';
  return (
    <div className="space-y-2 border-t border-dark-700 pt-3 text-xs">
      <p className="text-dark-300">
        Navigateur sur le cluster. Session pour {agentId ? 'cet agent' : 'ce board et ses agents'}.
      </p>
      {!status.configured && (
        <p className="text-amber-300">
          Le service de navigateur doit être configuré par l’administrateur.
        </p>
      )}
      {!status.exists ? (
        <>
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
          <details>
            <summary className="cursor-pointer text-dark-400">
              Domaines de connexion supplémentaires (OAuth / SSO)
            </summary>
            <input
              aria-label="Domaines de connexion OAuth"
              className="w-full bg-dark-900 border border-dark-600 rounded p-2 mt-1"
              value={origins}
              onChange={e => setOrigins(e.target.value)}
              placeholder="https://accounts.google.com https://appleid.apple.com"
            />
            <p className="text-dark-400 mt-1">
              Ajoutez les origines HTTPS utilisées pendant votre connexion, séparées par des
              espaces. L’agent restera limité au site principal.
            </p>
          </details>
          <button
            type="button"
            className={button}
            disabled={busy || !status.configured || (!agentId && !boardId)}
            onClick={() => void action('start')}
          >
            {busy ? 'Ouverture…' : 'Connecter'}
          </button>
        </>
      ) : (
        <>
          <p className="text-dark-300 break-all">
            {status.site} —{' '}
            {status.connected ? 'Session partagée' : 'Connexion privée, agent en attente'}
          </p>
          {status.expiresAt && (
            <p className="text-dark-400">
              Expiration au plus tard : {new Date(status.expiresAt).toLocaleString()}. Fermeture
              après 30 minutes sans activité.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {status.canControl && (
              <button
                type="button"
                disabled={busy}
                className={button}
                onClick={() => (status.connected ? void action('takeover') : setViewer(true))}
              >
                {status.connected ? 'Reprendre la main' : 'Ouvrir la connexion'}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() => void action('disconnect')}
            >
              Déconnecter
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
          {!status.canControl && (
            <p className="text-dark-400">
              La connexion privée est contrôlée par l’utilisateur qui l’a ouverte.
            </p>
          )}
        </>
      )}
      <p className="text-dark-400">
        La connexion se fait dans le site, avec votre MFA si nécessaire. Aucun jeton OAuth d’API
        n’est converti en cookie. Certains sites, dont LinkedIn, peuvent limiter ou bloquer ce
        navigateur. Une session expirée nécessite une nouvelle connexion.
      </p>
      {(error || statusError) && (
        <p role="alert" className="text-red-400">
          {error || statusError}
        </p>
      )}
      {viewer && status.phase === 'login' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Connexion au navigateur du cluster"
          className="fixed inset-0 z-[100] bg-dark-900 flex flex-col p-4 gap-2 overflow-auto"
        >
          <div className="flex flex-wrap gap-2 items-center">
            <strong className="text-white">Connexion privée — agent en attente</strong>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => input('back', {})}
            >
              Retour
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => input('home', {})}
            >
              Revenir au site
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void action('activate')}
            >
              Partager cette session
            </button>
            <button
              type="button"
              className={button}
              onClick={() => {
                setViewer(false);
                setFrame(null);
              }}
            >
              Fermer l’aperçu
            </button>
          </div>
          <p className="text-dark-200">
            Connectez-vous puis revenez sur le site. Vérifiez le compte affiché avant de partager.
            Cliquez dans l’image pour saisir au clavier ; le collage est disponible. Vos saisies
            transitent par PulsarTeam vers ce navigateur.
          </p>
          <p className="text-dark-300 break-all">{frame?.url || 'Chargement…'}</p>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
          {frame && (
            <img
              src={`data:image/jpeg;base64,${frame.image}`}
              alt="Navigateur distant interactif"
              tabIndex={0}
              draggable={false}
              className="w-full max-w-[1280px] self-center outline-none focus:ring-2 focus:ring-indigo-500 cursor-default"
              onClick={e => {
                e.currentTarget.focus();
                const r = e.currentTarget.getBoundingClientRect();
                input('click', {
                  x: Math.min(
                    1279,
                    Math.max(0, Math.floor(((e.clientX - r.left) * 1280) / r.width))
                  ),
                  y: Math.min(799, Math.max(0, Math.floor(((e.clientY - r.top) * 800) / r.height))),
                });
              }}
              onPaste={e => {
                e.preventDefault();
                input('text', { text: e.clipboardData.getData('text/plain').slice(0, 4000) });
              }}
              onWheel={e =>
                input('wheel', { delta: Math.max(-1400, Math.min(1400, Math.round(e.deltaY))) })
              }
              onKeyDown={e => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
                e.preventDefault();
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')
                  input('key', { text: 'Control+A' });
                else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
                  input('text', { text: e.key });
                else if (
                  [
                    'Enter',
                    'Tab',
                    'Backspace',
                    'Delete',
                    'Escape',
                    'ArrowLeft',
                    'ArrowRight',
                    'ArrowUp',
                    'ArrowDown',
                    'Home',
                    'End',
                  ].includes(e.key)
                )
                  input('key', { text: e.shiftKey && e.key === 'Tab' ? 'Shift+Tab' : e.key });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
