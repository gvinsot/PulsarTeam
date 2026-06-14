import { useState, useEffect, useRef, ReactNode } from 'react';
import { ExternalLink, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { useConnectStatus, ConnectStatus } from './useConnectStatus';

/**
 * Generic OAuth connection widget shared by the provider connect components
 * (Gmail, GitHub, Google Drive, OneDrive, Outlook, Slack).
 * Owns the full flow: status fetch → get auth URL → open popup →
 * server-side token exchange via redirect → postMessage callback.
 */
export interface OAuthProviderConfig {
  name: string;
  /** Icon shown on the connected/disconnected card. */
  Icon: any;
  /** Icon shown in the status-error and not-configured states. */
  IconOff: any;
  /** Icon shown on the Disconnect button. */
  IconDisconnect: any;
  /** window.open() target name for the OAuth popup. */
  popupName: string;
  /** postMessage `type` emitted by the server-rendered oauth-redirect page. */
  messageType: string;
  /** Optional `service` filter for shared dispatchers (e.g. Microsoft). */
  service?: string;
  /** Tailwind classes for the connect button background. */
  buttonClass: string;
  connectLabel: string;
  /** Detail shown in the connected badge (email/login/teamName); falls back to 'Connected'. */
  badgeDetail?: (status: ConnectStatus) => string | null;
  /** Body of the "not configured" hint paragraph. */
  configuredHint: ReactNode;
  /** Hint below the connect button; varies between agent-scoped and global use. */
  connectHint: (agentId?: string) => string;
  /** Extra actions rendered next to the connect button (e.g. OneDrive 'personal'). */
  extraConnectActions?: (props: { connect: (opts?: any) => void; connecting: boolean }) => ReactNode;
  api: {
    getStatus: (agentId?: string, boardId?: string) => Promise<ConnectStatus>;
    getAuthUrl: (agentId?: string, boardId?: string, opts?: any) => Promise<{ authUrl: string }>;
    disconnect: (agentId?: string, boardId?: string) => Promise<any>;
  };
}

export default function OAuthConnectWidget({ config, agentId, boardId, onStatusChange }: {
  config: OAuthProviderConfig;
  agentId?: string;
  boardId?: string;
  onStatusChange?: (status: ConnectStatus) => void;
}) {
  const { name, Icon, IconOff, IconDisconnect } = config;
  const { status, loading, statusError, fetchStatus, retry } =
    useConnectStatus(name, config.api.getStatus, agentId, boardId, onStatusChange);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState(null);

  const pollRef = useRef(null);
  useEffect(() => () => clearInterval(pollRef.current), []);

  // Listen for OAuth callback messages from the popup window
  useEffect(() => {
    const handleMessage = async (event) => {
      if (event.data?.type !== config.messageType) return;
      // Shared-client dispatchers (e.g. the unified Microsoft OAuth redirect)
      // include a `service` field so each widget only reacts to its own callback.
      if (config.service && event.data.service !== config.service) return;
      if (!('success' in event.data)) return;
      setConnecting(true);
      setError(null);
      if (event.data.success) {
        await fetchStatus();
      } else {
        setError(event.data.error || 'OAuth failed');
      }
      setConnecting(false);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchStatus, config.messageType, config.service]);

  const handleConnect = async (opts?: any) => {
    setError(null);
    setConnecting(true);
    try {
      const { authUrl } = await config.api.getAuthUrl(agentId || undefined, boardId || undefined, opts);

      // Open OAuth popup
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.innerWidth - width) / 2;
      const top = window.screenY + (window.innerHeight - height) / 2;

      const popup = window.open(
        authUrl,
        config.popupName,
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
      );

      if (!popup) {
        setError('Popup blocked. Please allow popups for this site.');
        setConnecting(false);
        return;
      }

      // Poll only for popup closure detection
      // The server-rendered oauth-redirect page reports the result via postMessage
      clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setConnecting(false);
        }
      }, 500);

    } catch (err) {
      setError(err.message);
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await config.api.disconnect(agentId || undefined, boardId || undefined);
      await fetchStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <Loader2 className="w-4 h-4 text-dark-400 animate-spin" />
        <span className="text-xs text-dark-400">Checking {name} status...</span>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconOff className="w-4 h-4 text-dark-500" />
            <span className="text-sm font-medium text-dark-300">{name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">status check failed</span>
          </div>
          <button
            onClick={retry}
            className="px-2.5 py-1 text-xs text-dark-400 hover:text-dark-200 hover:bg-dark-700 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{statusError}</span>
        </div>
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div className="p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <div className="flex items-center gap-2 mb-1.5">
          <IconOff className="w-4 h-4 text-dark-500" />
          <span className="text-sm font-medium text-dark-300">{name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">not configured</span>
        </div>
        <p className="text-xs text-dark-500">
          {config.configuredHint}
        </p>
      </div>
    );
  }

  const connectButton = (
    <button
      onClick={() => handleConnect()}
      disabled={connecting}
      className={`flex items-center gap-1.5 px-3 py-1.5 ${config.buttonClass} text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-40`}
    >
      {connecting ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <ExternalLink className="w-3.5 h-3.5" />
      )}
      {connecting ? 'Connecting...' : config.connectLabel}
    </button>
  );

  return (
    <div className={`p-3 rounded-lg border transition-colors ${
      status.connected
        ? 'bg-emerald-500/5 border-emerald-500/20'
        : 'bg-dark-800/30 border-dark-700/30'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${status.connected ? 'text-emerald-400' : 'text-dark-400'}`} />
          <span className="text-sm font-medium text-dark-200">{name}</span>
          {status.connected ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
              <CheckCircle className="w-2.5 h-2.5" />
              {config.badgeDetail?.(status) || 'Connected'}
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">
              Disconnected
            </span>
          )}
        </div>

        {status.connected ? (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-dark-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40"
          >
            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <IconDisconnect className="w-3 h-3" />}
            Disconnect
          </button>
        ) : config.extraConnectActions ? (
          <div className="flex items-center gap-2">
            {connectButton}
            {config.extraConnectActions({ connect: handleConnect, connecting })}
          </div>
        ) : (
          connectButton
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!status.connected && (
        <p className="mt-2 text-[11px] text-dark-500">
          {config.connectHint(agentId)}
        </p>
      )}
    </div>
  );
}
