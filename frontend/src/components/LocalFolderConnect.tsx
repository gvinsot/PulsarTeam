import { useEffect, useState } from 'react';
import { FolderCheck, MonitorX, Download, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { getSocket } from '../socket';
import { WsEvents } from '../socketEvents';

type Status = { connected: boolean; folders: string[]; downloadUrl: string | null };

/**
 * Local Folder connector status. There's nothing to "connect" server-side — the
 * link is the user's desktop app being open and sharing a folder. We show its
 * live state (polled once + updated on the BRIDGE_FOLDER_CHANGED socket event)
 * and, when offline, a link to download the desktop app.
 *
 * Status is per-user, so agentId/boardId are accepted (to match the connector
 * widget interface) but not used.
 */
export default function LocalFolderConnect(_props: { agentId?: string; boardId?: string; onStatusChange?: () => void }) {
  const [status, setStatus] = useState<Status>({ connected: false, folders: [], downloadUrl: null });
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const s = await api.getLocalFolderStatus();
      setStatus({ connected: !!s.connected, folders: s.folders || [], downloadUrl: s.downloadUrl || null });
    } catch {
      setStatus(prev => ({ ...prev, connected: false }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const socket = getSocket();
    if (!socket) return;
    const onChange = (data: { connected: boolean; folders: string[] }) => {
      setStatus(prev => ({ ...prev, connected: !!data.connected, folders: data.folders || [] }));
    };
    socket.on(WsEvents.BRIDGE_FOLDER_CHANGED, onChange);
    return () => { socket.off(WsEvents.BRIDGE_FOLDER_CHANGED, onChange); };
  }, []);

  return (
    <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 p-3 text-sm">
      <div className="flex items-center gap-2">
        {status.connected ? (
          <FolderCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
        ) : (
          <MonitorX className="w-4 h-4 text-dark-400 flex-shrink-0" />
        )}
        <span className={status.connected ? 'text-emerald-400 font-medium' : 'text-dark-300'}>
          {loading ? 'Checking desktop app…' : status.connected ? 'Desktop app connected' : 'Desktop app not running'}
        </span>
        <button
          onClick={refresh}
          title="Refresh"
          className="ml-auto p-1 rounded hover:bg-dark-700/50 text-dark-400 hover:text-dark-200"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {status.connected ? (
        status.folders.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {status.folders.map((f, i) => (
              <li key={i} className="text-xs text-dark-300 font-mono truncate" title={f}>📁 {f}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-dark-400">No folder shared yet — pick one in the desktop app.</p>
        )
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-dark-400">
            Open the PulsarTeam desktop app and share a folder so agents can read, edit and generate
            its Office files. Files never leave your machine.
          </p>
          {status.downloadUrl && (
            <a
              href={status.downloadUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white text-xs"
            >
              <Download className="w-3.5 h-3.5" /> Download desktop app
            </a>
          )}
        </div>
      )}
    </div>
  );
}
