import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, FileX, Loader2, CheckCircle, AlertCircle, Save } from 'lucide-react';
import { api } from '../api';

/**
 * WordPress connection widget — Application Password (Basic Auth).
 *
 * Props:
 *   agentId        — configure WordPress for this agent
 *   boardId        — or configure WordPress for this board
 *   onStatusChange — (optional) callback when connection status changes
 */
export default function WordPressConnect({ agentId, boardId, onStatusChange }: { agentId?: string; boardId?: string; onStatusChange?: (status: any) => void }) {
  const [status, setStatus] = useState<any>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [username, setUsername] = useState('');
  const [applicationPassword, setApplicationPassword] = useState('');

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const fetchStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const data = await api.getWordPressStatus(agentId || undefined, boardId || undefined);
      setStatus(data);
      onStatusChangeRef.current?.(data);
    } catch (err: any) {
      console.error('WordPress status check failed:', err);
      setStatusError(err.message || 'Status check failed');
    } finally {
      setLoading(false);
    }
  }, [agentId, boardId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleConnect = async () => {
    if (!siteUrl || !username || !applicationPassword) {
      setError('All fields are required');
      return;
    }
    setError(null);
    setConnecting(true);
    try {
      await api.connectWordPress(agentId || '', siteUrl, username, applicationPassword, boardId || undefined);
      setShowForm(false);
      setSiteUrl('');
      setUsername('');
      setApplicationPassword('');
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.disconnectWordPress(agentId || undefined, boardId || undefined);
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <Loader2 className="w-4 h-4 text-dark-400 animate-spin" />
        <span className="text-xs text-dark-400">Checking WordPress status...</span>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-dark-500" />
            <span className="text-sm font-medium text-dark-300">WordPress</span>
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

  return (
    <div className={`p-3 rounded-lg border transition-colors ${
      status.connected
        ? 'bg-sky-500/5 border-sky-500/20'
        : 'bg-dark-800/30 border-dark-700/30'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className={`w-4 h-4 ${status.connected ? 'text-sky-400' : 'text-dark-400'}`} />
          <span className="text-sm font-medium text-dark-200">WordPress</span>
          {status.connected ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/20 text-sky-400 border border-sky-500/30 flex items-center gap-1">
              <CheckCircle className="w-2.5 h-2.5" />
              {status.siteUrl ? new URL(status.siteUrl).host : 'Connected'}
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
            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileX className="w-3 h-3" />}
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-500 hover:bg-sky-600 text-white rounded-lg text-xs font-medium transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            {showForm ? 'Cancel' : 'Connect WordPress'}
          </button>
        )}
      </div>

      {showForm && !status.connected && (
        <div className="mt-3 space-y-2">
          <div>
            <label className="text-[11px] text-dark-400 block mb-1">Site URL</label>
            <input
              type="text"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://blog.example.com"
              className="w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[11px] text-dark-400 block mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your WordPress login"
              className="w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[11px] text-dark-400 block mb-1">Application Password</label>
            <input
              type="password"
              value={applicationPassword}
              onChange={(e) => setApplicationPassword(e.target.value)}
              placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
              className="w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 focus:border-sky-500 focus:outline-none"
            />
            <p className="text-[10px] text-dark-500 mt-1">
              Create one in WordPress under <span className="text-dark-300">Users → Profile → Application Passwords</span> (do not use your normal account password).
            </p>
          </div>
          <button
            onClick={handleConnect}
            disabled={connecting || !siteUrl || !username || !applicationPassword}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-500 hover:bg-sky-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-40 w-full justify-center"
          >
            {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {connecting ? 'Connecting...' : 'Save & Test Connection'}
          </button>
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!status.connected && !showForm && (
        <p className="mt-2 text-[11px] text-dark-500">
          Click "Connect WordPress" to configure access with a WordPress Application Password.
        </p>
      )}
    </div>
  );
}
