import { useState, useEffect, useCallback, useRef } from 'react';
import { Github, ExternalLink, Loader2, CheckCircle, AlertCircle, Unplug } from 'lucide-react';
import { api } from '../api';

export default function GitHubConnect({ agentId, boardId, onStatusChange }) {
  const [status, setStatus] = useState({ configured: false, connected: false });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState(null);

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.getGitHubStatus(agentId || undefined, boardId || undefined);
      setStatus(data);
      onStatusChangeRef.current?.(data);
    } catch (err) {
      console.error('GitHub status check failed:', err);
    } finally {
      setLoading(false);
    }
  }, [agentId, boardId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const handleMessage = async (event) => {
      if (event.data?.type === 'github-oauth-callback') {
        setConnecting(true);
        setError(null);
        try {
          if (event.data.success) {
            await fetchStatus();
          } else {
            setError(event.data.error || 'OAuth failed');
          }
        } catch (err) {
          setError(err.message);
        } finally {
          setConnecting(false);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchStatus]);

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const { authUrl } = await api.getGitHubAuthUrl(agentId || undefined, boardId || undefined);

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.innerWidth - width) / 2;
      const top = window.screenY + (window.innerHeight - height) / 2;

      const popup = window.open(
        authUrl,
        'github-oauth',
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
      );

      if (!popup) {
        setError('Popup blocked. Please allow popups for this site.');
        setConnecting(false);
        return;
      }

      const pollInterval = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollInterval);
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
      await api.disconnectGitHub(agentId || undefined, boardId || undefined);
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
        <span className="text-xs text-dark-400">Checking GitHub status...</span>
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div className="p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <div className="flex items-center gap-2 mb-1.5">
          <Github className="w-4 h-4 text-dark-500" />
          <span className="text-sm font-medium text-dark-300">GitHub</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">not configured</span>
        </div>
        <p className="text-xs text-dark-500">
          Set <code className="text-dark-400">GITHUB_OAUTH_CLIENT_ID</code>, <code className="text-dark-400">GITHUB_OAUTH_CLIENT_SECRET</code>, and <code className="text-dark-400">GITHUB_OAUTH_REDIRECT_URI</code> environment variables to enable.
        </p>
      </div>
    );
  }

  return (
    <div className={`p-3 rounded-lg border transition-colors ${
      status.connected
        ? 'bg-emerald-500/5 border-emerald-500/20'
        : 'bg-dark-800/30 border-dark-700/30'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Github className={`w-4 h-4 ${status.connected ? 'text-emerald-400' : 'text-dark-400'}`} />
          <span className="text-sm font-medium text-dark-200">GitHub</span>
          {status.connected ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
              <CheckCircle className="w-2.5 h-2.5" />
              {status.login || 'Connected'}
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
            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unplug className="w-3 h-3" />}
            Disconnect
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
          >
            {connecting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ExternalLink className="w-3.5 h-3.5" />
            )}
            {connecting ? 'Connecting...' : 'Connect with GitHub'}
          </button>
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
          {agentId
            ? 'Click "Connect with GitHub" to authorize this agent to access GitHub repositories.'
            : 'Click "Connect with GitHub" to authorize access. A popup will open for GitHub login.'
          }
        </p>
      )}
    </div>
  );
}
