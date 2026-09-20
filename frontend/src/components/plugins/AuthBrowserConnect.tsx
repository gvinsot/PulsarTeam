import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuthBrowserControl } from '../../api';
import { useConnectStatus, type ConnectWidgetProps } from '../connect/useConnectStatus';
import { errorMessage } from '../../utils/errors';

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
  }, [agentId, boardId, status.phase, status.canControl, status.sessionId, fetchStatus]);

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
          throw new Error('Open PulsarTeam over HTTPS and choose a different HTTPS website.');
        }
      }
      await api.authBrowserControl({
        operation,
        agentId,
        boardId,
        sessionId: status.sessionId,
        ...(operation === 'prepare_import' ? { url } : {}),
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
        Sign in using your browser, then share the session so agents can browse the site on the
        cluster.
      </p>
      <p className="text-dark-400">
        Session for {agentId ? 'this agent' : 'this board and its agents'}.
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
      {!status.exists ? (
        <>
          <label className="block">
            Website address
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
      ) : (
        <>
          <p className="text-dark-300 break-all">
            {status.site} —{' '}
            {status.connected
              ? 'Session shared on the cluster'
              : status.phase === 'pending'
                ? 'Waiting for session transfer'
                : 'Agent access paused'}
          </p>
          {status.expiresAt && (
            <p className="text-dark-400">
              Expires no later than: {new Date(status.expiresAt).toLocaleString('en-GB')}.
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
                <li>Open the PulsarTeam extension from this tab, then click “Open website”.</li>
                <li>Sign in to the website as usual and check the account shown.</li>
                <li>From the website tab, open the extension and click “Transfer session”.</li>
              </ol>
              <p className="text-amber-300 mt-2">
                Transferring copies your session cookies to the cluster and gives the selected
                agents access to this account. Keep this PulsarTeam tab and connection panel open.
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
                {status.connected ? 'Pause sharing' : 'Resume sharing'}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() => void action('disconnect')}
            >
              {status.phase === 'pending' ? 'Cancel' : 'Disconnect'}
            </button>
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() => void fetchStatus()}
            >
              Refresh
            </button>
          </div>
        </>
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
