import { useState, useEffect, useCallback, useRef } from 'react';
import { Cloud, CloudOff, Loader2, CheckCircle, AlertCircle, Save } from 'lucide-react';
import { api } from '../api';

export default function S3Connect({ agentId, boardId, onStatusChange }: { agentId?: string; boardId?: string; onStatusChange?: (status: any) => void }) {
  const [status, setStatus] = useState<any>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [endpoint, setEndpoint] = useState('');

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  const fetchStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const data = await api.getS3Status(agentId || undefined, boardId || undefined);
      setStatus(data);
      onStatusChangeRef.current?.(data);
    } catch (err: any) {
      console.error('S3 status check failed:', err);
      setStatusError(err.message || 'Status check failed');
    } finally {
      setLoading(false);
    }
  }, [agentId, boardId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleConnect = async () => {
    if (!accessKeyId || !secretAccessKey) {
      setError('Access Key ID and Secret Access Key are required');
      return;
    }
    setError(null);
    setConnecting(true);
    try {
      await api.connectS3(agentId || '', secretAccessKey, accessKeyId, region, boardId || undefined, endpoint || undefined);
      setShowForm(false);
      setAccessKeyId('');
      setSecretAccessKey('');
      setRegion('us-east-1');
      setEndpoint('');
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
      await api.disconnectS3(agentId || undefined, boardId || undefined);
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
        <span className="text-xs text-dark-400">Checking S3 status...</span>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="p-3 bg-dark-800/30 rounded-lg border border-dark-700/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cloud className="w-4 h-4 text-dark-500" />
            <span className="text-sm font-medium text-dark-300">AWS S3</span>
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
        ? 'bg-orange-500/5 border-orange-500/20'
        : 'bg-dark-800/30 border-dark-700/30'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cloud className={`w-4 h-4 ${status.connected ? 'text-orange-400' : 'text-dark-400'}`} />
          <span className="text-sm font-medium text-dark-200">AWS S3</span>
          {status.connected ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30 flex items-center gap-1">
              <CheckCircle className="w-2.5 h-2.5" />
              {status.region || 'Connected'}
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
            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <CloudOff className="w-3 h-3" />}
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-xs font-medium transition-colors"
          >
            <Cloud className="w-3.5 h-3.5" />
            {showForm ? 'Cancel' : 'Connect S3'}
          </button>
        )}
      </div>

      {showForm && !status.connected && (
        <div className="mt-3 space-y-2">
          <div>
            <label className="text-[11px] text-dark-400 block mb-1">Access Key ID</label>
            <input
              type="text"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              placeholder="AKIAIOSFODNN7EXAMPLE"
              className="w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[11px] text-dark-400 block mb-1">Secret Access Key</label>
            <input
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
              className="w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[11px] text-dark-400 block mb-1">Region</label>
            <input
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1"
              className="w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[11px] text-dark-400 block mb-1">Custom Endpoint <span className="text-dark-500">(optional — for S3-compatible services like MinIO)</span></label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://s3.example.com"
              className="w-full px-2.5 py-1.5 text-xs bg-dark-900 border border-dark-600 rounded-lg text-dark-200 placeholder-dark-500 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <p className="text-[10px] text-dark-500">
            Create IAM credentials at{' '}
            <a href="https://console.aws.amazon.com/iam/" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:underline">
              AWS IAM Console
            </a>
          </p>
          <button
            onClick={handleConnect}
            disabled={connecting || !accessKeyId || !secretAccessKey}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-40 w-full justify-center"
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
          Click "Connect S3" to configure AWS credentials for this agent.
        </p>
      )}
    </div>
  );
}
