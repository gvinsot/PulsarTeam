import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthBrowserControl, type AuthBrowserSession } from '../../api';
import { useConnectStatus, type ConnectWidgetProps } from '../connect/useConnectStatus';
import { errorMessage } from '../../utils/errors';
import { browserSessions, pendingTransfer, sessionLabel } from './authBrowserSessions';

// One plugin instance shares SEVERAL websites: each has its own server browser
// session (worker key `<scope>@<host>`). Only one transfer waits at a time,
// because the extension pairs with exactly one request element on this page.

export default function AuthBrowserConnect({
  agentId,
  boardId,
  onStatusChange,
}: ConnectWidgetProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bridge = useRef<HTMLDivElement>(null);
  const importing = useRef(false);
  const getStatus = useCallback(
    (agentId?: string, boardId?: string) =>
      api.authBrowserControl({ operation: 'status', agentId, boardId }),
    []
  );
  const { status, fetchStatus, statusError, loading, retry } = useConnectStatus(
    'auth-browser',
    getStatus,
    agentId,
    boardId,
    onStatusChange
  );
  const sessions = browserSessions(status.sessions);
  const { mine: pending, blocked, canAdd } = pendingTransfer(sessions);
  const pendingId = pending?.sessionId;
  const pendingSite = pending?.site;

  useEffect(() => {
    setError('');
  }, [agentId, boardId]);
  useEffect(() => {
    const node = bridge.current;
    if (!node || !pendingId) return;
    // API independently checks user, edit permission, scope and one-use nonce.
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || detail.requestId !== pendingId || importing.current) return;
      importing.current = true;
      setBusy(true);
      setError('');
      void (async () => {
        try {
          await api.authBrowserControl({
            operation: 'import',
            agentId,
            boardId,
            site: pendingSite,
            sessionId: pendingId,
            url: detail.url,
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
  }, [agentId, boardId, pendingId, pendingSite, fetchStatus]);

  async function action(operation: AuthBrowserControl['operation'], session?: AuthBrowserSession) {
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
          throw new Error('Open PulsarTeam over HTTPS and choose a different HTTPS website.');
        }
      }
      await api.authBrowserControl({
        operation,
        agentId,
        boardId,
        ...(session ? { site: session.site, sessionId: session.sessionId } : {}),
        ...(operation === 'prepare_import' ? { url } : {}),
      });
      if (operation === 'prepare_import') setUrl('');
      await fetchStatus();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setError('');
    await fetchStatus();
  }
  const button =
    'px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50';
  return (
    <div className="space-y-2 border-t border-dark-700 pt-3 text-xs">
      <p className="text-dark-300">
        Sign in locally and transfer each website session once. All subsequent agent navigation runs
        in the server browser, independently of your local tabs.
      </p>
      <p className="text-dark-400">
        Sessions for {agentId ? 'this agent' : 'this board and its agents'}. You can share several
        websites, one transfer at a time.
      </p>
      {!loading && !statusError && status.configured === false && (
        <p className="text-amber-300">An administrator must configure the browser service.</p>
      )}
      {loading && <p className="text-dark-400">Checking the browser service…</p>}
      {statusError && (
        <button type="button" className={button} onClick={retry}>
          Retry service connection
        </button>
      )}
      {sessions.length > 0 && (
        <ul className="space-y-2" aria-label="Shared websites">
          {sessions.map(s => (
            <li
              key={s.sessionId || s.site}
              className="rounded border border-dark-700 p-2 space-y-1"
            >
              <p className="text-dark-300 break-all">
                {s.site} — {sessionLabel(s)}
              </p>
              {s.expiresAt && (
                <p className="text-dark-400">
                  Expires no later than: {new Date(s.expiresAt).toLocaleString('en-GB')}.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {s.canControl && s.phase && ['login', 'ready'].includes(s.phase) && (
                  <button
                    type="button"
                    disabled={busy}
                    className={button}
                    onClick={() => void action(s.connected ? 'takeover' : 'activate', s)}
                  >
                    {s.connected ? 'Pause sharing' : 'Resume sharing'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  className={button}
                  aria-label={`${s.phase === 'pending' ? 'Cancel' : 'Disconnect'} ${s.site}`}
                  onClick={() => void action('disconnect', s)}
                >
                  {s.phase === 'pending' ? 'Cancel' : 'Disconnect'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <div
          ref={bridge}
          data-pulsar-browser-request={JSON.stringify({
            version: 1,
            requestId: pending.sessionId,
            site: pending.site,
            expiresAt: pending.expiresAt,
            scope: agentId ? `agent:${agentId}` : `board:${boardId}`,
          })}
        >
          <ol className="list-decimal ml-4 space-y-1 text-dark-200">
            <li>Open the PulsarTeam extension from this tab, then click “Open website”.</li>
            <li>
              Sign in to {pending.site}, check the account shown and open the page you want to
              share.
            </li>
            <li>From the website tab, open the extension and click “Transfer session”.</li>
          </ol>
          <p className="text-amber-300 mt-2">
            Transferring copies your session cookies to the cluster and gives the selected agents
            access to this account. Keep this PulsarTeam tab and connection panel open. Once the
            transfer succeeds, you may close both local tabs.
          </p>
        </div>
      )}
      {blocked && (
        <p className="text-dark-400">
          Another transfer is waiting. Add a website once it is done or cancelled.
        </p>
      )}
      {canAdd && (
        <>
          <label className="block">
            {sessions.length ? 'Add another website' : 'Website address'}
            <input
              aria-label="Website address"
              placeholder="https://www.example.com/"
              type="url"
              className="block w-full bg-dark-900 border border-dark-600 rounded p-2 mt-1"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={button}
            disabled={busy || !url.trim() || !status.configured || (!agentId && !boardId)}
            onClick={() => void action('prepare_import')}
          >
            {busy ? 'Preparing…' : 'Connect in my browser'}
          </button>
        </>
      )}
      {sessions.length > 0 && (
        <div>
          <button type="button" disabled={busy} className={button} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      )}
      <details className="text-dark-400">
        <summary className="cursor-pointer">Install the Chrome / Edge extension</summary>
        <p className="mt-1">
          Download and extract the extension. Open chrome://extensions or edge://extensions, enable
          Developer mode, click “Load unpacked” and select the extracted folder. To update an
          existing installation, replace its files and click “Reload”.
        </p>
        <a href="/extensions/pulsarteam-session.zip" download className="text-indigo-300 underline">
          Download extension
        </a>
      </details>
      <p className="text-dark-400">
        Login and MFA stay in your browser. Device-bound sessions or sessions rejected by the
        website may not work on the cluster. Expired sessions require a new transfer.
      </p>
      {busy && <p className="text-dark-300">Operation in progress…</p>}
      {(error || statusError) && (
        <p role="alert" className="text-red-400">
          {error || statusError}
        </p>
      )}
    </div>
  );
}
