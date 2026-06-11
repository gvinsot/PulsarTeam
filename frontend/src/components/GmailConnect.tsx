import { useState, useEffect, useCallback, useRef } from 'react';
import { Mail, MailX, ExternalLink, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { api } from '../api';

/**
 * Gmail OAuth connection widget.
 * Handles the full OAuth flow: get auth URL → open popup → capture code+state → exchange tokens.
 *
 * Props:
 *   agentId       — (optional) when provided, authenticates Gmail for this specific agent
 *   onStatusChange — (optional) callback when connection status changes
 */
export default function GmailConnect({ agentId, boardId, onStatusChange }) {
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean; email?: string | null }>({ configured: false, connected: false });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState(null);
  const [statusError, setStatusError] = useState(null);

  // Use a ref for the callback to avoid re-triggering the effect when the
  // parent passes a new inline function reference on every render.
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const pollRef = useRef(null);
  useEffect(() => () => clearInterval(pollRef.current), []);

  const fetchStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const data = await api.getGmailStatus(agentId || undefined, boardId || undefined);
      setStatus(data);
      onStatusChangeRef.current?.(data);
    } catch (err) {
      console.error('Gmail status check failed:', err);
      setStatusError(err.message || 'Status check failed');
    } finally {
      setLoading(false);
    }
  }, [agentId, boardId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Listen for OAuth callback messages from the popup window
  useEffect(() => {
    const handleMessage = async (event) => {
      if (event.data?.type !== 'gmail-oauth-callback') return;

      // New server-side flow: tokens already exchanged, just refresh status
      if ('success' in event.data) {
        if (event.data.success) {
          await fetchStatus();
        } else {
          setError(event.data.error || 'OAuth failed');
        }
        setConnecting(false);
        return;
      }

      // Legacy popup flow (gmail-callback.html): exchange code via API
      if (event.data?.code) {
        setConnecting(true);
        setError(null);
        try {
          await api.gmailCallback(event.data.code, event.data.state);
          await fetchStatus();
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
      const { authUrl } = await api.getGmailAuthUrl(agentId || undefined, boardId || undefined);

      // Open OAuth popup
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.innerWidth - width) / 2;
      const top = window.screenY + (window.innerHeight - height) / 2;

      const popup = window.open(
        authUrl,
        'gmail-oauth',
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
      );

      if (!popup) {
        setError('Popup blocked. Please allow popups for this site.');
        setConnecting(false);
        return;
      }

      // Poll only for popup closure detection
      // The callback page (gmail-callback.html) handles sending the code via postMessage
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
      await api.disconnectGmail(agentId || undefined, boardId || undefined);
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
        <span className="text-xs text-dark-400">Checking Gmail status...</span>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MailX className="w-4 h-4 text-dark-500" />
            <span className="text-sm font-medium text-dark-300">Gmail</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">status check failed</span>
          </div>
          <button
            onClick={() => { setLoading(true); fetchStatus(); }}
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
          <MailX className="w-4 h-4 text-dark-500" />
          <span className="text-sm font-medium text-dark-300">Gmail</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">not configured</span>
        </div>
        <p className="text-xs text-dark-500">
          Set <code className="text-dark-400">GOOGLE_CLIENT_ID</code> and <code className="text-dark-400">GOOGLE_CLIENT_SECRET</code> — one OAuth client serves Gmail, Drive, and Google login.
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
          <Mail className={`w-4 h-4 ${status.connected ? 'text-emerald-400' : 'text-dark-400'}`} />
          <span className="text-sm font-medium text-dark-200">Gmail</span>
          {status.connected ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
              <CheckCircle className="w-2.5 h-2.5" />
              {status.email || 'Connected'}
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
            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <MailX className="w-3 h-3" />}
            Disconnect
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
          >
            {connecting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ExternalLink className="w-3.5 h-3.5" />
            )}
            {connecting ? 'Connecting...' : 'Connect with Google'}
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
            ? 'Click "Connect with Google" to authorize this agent to access Gmail.'
            : 'Click "Connect with Google" to authorize Gmail access. A popup will open for Google login.'
          }
        </p>
      )}
    </div>
  );
}
