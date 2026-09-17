import { useCallback, useMemo, useState } from 'react';
import { Plug, Unplug } from 'lucide-react';
import { api } from '../../api';
import type { PluginMcpEntry } from '../../types';
import OAuthConnectWidget from '../connect/OAuthConnectWidget';
import { useConnectStatus, type ConnectWidgetProps } from '../connect/useConnectStatus';
import { errorMessage } from '../../utils/errors';

export default function RemoteMcpConnect({
  mcp,
  agentId,
  boardId,
  onStatusChange,
}: ConnectWidgetProps & { mcp: PluginMcpEntry }) {
  const [key, setKey] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [prefix, setPrefix] = useState('Bearer ');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState('');
  const getStatus = useCallback(
    (agent?: string, board?: string) => api.getRemoteMcpStatus(mcp.id, agent, board),
    [mcp.id]
  );
  const { status, fetchStatus, statusError } = useConnectStatus(
    mcp.id,
    getStatus,
    agentId,
    boardId,
    onStatusChange
  );
  const config = useMemo(
    () => ({
      name: mcp.name,
      Icon: Plug,
      IconOff: Unplug,
      IconDisconnect: Unplug,
      popupName: `remote-mcp-${mcp.id}-${agentId || boardId}`,
      messageType: 'remote-mcp-oauth-callback',
      service: mcp.id,
      buttonClass: 'bg-indigo-600 hover:bg-indigo-500',
      connectLabel: 'Connecter',
      configuredHint: 'Ce serveur doit prendre en charge OAuth MCP standard.',
      connectHint: () =>
        'Autorisez l’accès dans le navigateur. Les jetons seront renouvelés automatiquement.',
      api: {
        getStatus,
        getAuthUrl: (agent?: string, board?: string) =>
          api.getRemoteMcpAuthUrl(mcp.id, agent, board, clientId, clientSecret),
        disconnect: (agent?: string, board?: string) =>
          api.disconnectRemoteMcp(mcp.id, agent, board),
      },
    }),
    [mcp.id, mcp.name, agentId, boardId, getStatus, clientId, clientSecret]
  );

  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setTestResult('');
    try {
      await fn();
      await fetchStatus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const inputClass =
    'w-full bg-dark-900 border border-dark-600 rounded px-2 py-1.5 text-xs text-dark-100';
  return (
    <div className="space-y-2 border-t border-dark-700 pt-3">
      <p className="text-xs text-dark-300 break-all">{mcp.url}</p>
      <p className="text-[11px] text-dark-400">
        Accès pour {agentId ? 'cet agent' : 'ce board et ses agents'} uniquement.
      </p>
      {mcp.remoteAuth === 'oauth' ? (
        <>
          <OAuthConnectWidget
            config={config}
            agentId={agentId}
            boardId={boardId}
            onStatusChange={value => {
              onStatusChange?.(value);
              void fetchStatus();
            }}
          />
          {!status.connected && (
            <details className="text-xs text-dark-400">
              <summary className="cursor-pointer">
                Application OAuth préenregistrée (facultatif)
              </summary>
              <label className="block mt-2">
                Client ID
                <input
                  aria-label="Client ID OAuth MCP"
                  className={inputClass}
                  value={clientId}
                  onChange={e => setClientId(e.target.value)}
                />
              </label>
              <label className="block mt-2">
                Client Secret (si requis)
                <input
                  type="password"
                  autoComplete="new-password"
                  aria-label="Client Secret OAuth MCP"
                  className={inputClass}
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                />
              </label>
              <p className="mt-1">
                Pour les fournisseurs qui imposent une application préenregistrée. URL de retour :{' '}
                {window.location.origin}/api/remote-mcp/oauth/callback
              </p>
            </details>
          )}
        </>
      ) : (
        <>
          <div className="flex gap-2 items-center text-xs">
            <span className={status.connected ? 'text-emerald-400' : 'text-dark-400'}>
              {status.connected ? 'Clé enregistrée' : 'À configurer'}
            </span>
            <button className="text-indigo-400" onClick={() => setEditing(!editing)}>
              {editing ? 'Annuler' : 'Configurer'}
            </button>
            {status.connected && (
              <button
                disabled={busy}
                className="text-red-400"
                onClick={() => action(() => api.disconnectRemoteMcp(mcp.id, agentId, boardId))}
              >
                Déconnecter
              </button>
            )}
          </div>
          {editing && (
            <form
              className="space-y-2"
              onSubmit={e => {
                e.preventDefault();
                void action(async () => {
                  await api.saveRemoteMcpKey(mcp.id, {
                    agentId,
                    boardId,
                    apiKey: key,
                    headerName,
                    prefix,
                  });
                  setKey('');
                  setEditing(false);
                });
              }}
            >
              <label className="block text-xs text-dark-300">
                Clé API
                <input
                  type="password"
                  autoComplete="new-password"
                  aria-label="Clé API MCP"
                  className={inputClass}
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  required
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-dark-300">
                  En-tête
                  <input
                    className={inputClass}
                    value={headerName}
                    onChange={e => setHeaderName(e.target.value)}
                    required
                  />
                </label>
                <label className="text-xs text-dark-300">
                  Format
                  <select
                    className={inputClass}
                    value={prefix}
                    onChange={e => setPrefix(e.target.value)}
                  >
                    <option value="Bearer ">Bearer + clé</option>
                    <option value="">Clé seule</option>
                  </select>
                </label>
              </div>
              <button
                disabled={busy || !key}
                className="text-xs rounded bg-indigo-600 px-3 py-1.5 text-white disabled:opacity-50"
              >
                {busy ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </form>
          )}
        </>
      )}
      {status.connected && (
        <button
          disabled={busy}
          className="text-xs text-indigo-400"
          onClick={() =>
            action(async () => {
              const result = await api.testRemoteMcp(mcp.id, agentId, boardId);
              setTestResult(`Connexion réussie : ${result.toolCount} outil(s).`);
            })
          }
        >
          {busy ? 'Vérification…' : 'Tester la connexion'}
        </button>
      )}
      {testResult && (
        <p className="text-xs text-emerald-400" role="status">
          {testResult}
        </p>
      )}
      {(error || statusError) && (
        <p className="text-xs text-red-400" role="alert">
          {error || statusError}
        </p>
      )}
    </div>
  );
}
