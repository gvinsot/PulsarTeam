import { Cloud, CloudOff } from 'lucide-react';
import { api } from '../api';
import OAuthConnectWidget, { OAuthProviderConfig } from './connect/OAuthConnectWidget';

/**
 * OneDrive OAuth connection widget — thin config over the shared OAuthConnectWidget.
 * Shares the unified Microsoft OAuth dispatcher with Outlook; the `service`
 * field filters callbacks so each widget only reacts to its own.
 */
const ONEDRIVE_CONFIG: OAuthProviderConfig = {
  name: 'OneDrive',
  Icon: Cloud,
  IconOff: CloudOff,
  IconDisconnect: CloudOff,
  popupName: 'microsoft-oauth',
  messageType: 'microsoft-oauth-callback',
  service: 'onedrive',
  buttonClass: 'bg-blue-500 hover:bg-blue-600',
  connectLabel: 'Connect with Microsoft',
  configuredHint: (
    <>
      Set <code className="text-dark-400">MICROSOFT_CLIENT_ID</code> and <code className="text-dark-400">MICROSOFT_CLIENT_SECRET</code> — one Azure App serves OneDrive, Outlook, and Microsoft login.
    </>
  ),
  connectHint: (agentId) =>
    agentId
      ? 'Click "Connect with Microsoft" to authorize this agent to access OneDrive files.'
      : 'Click "Connect with Microsoft" to authorize OneDrive access. A popup will open for Microsoft login.',
  extraConnectActions: ({ connect, connecting }) => (
    <button
      onClick={() => connect({ consumer: true })}
      disabled={connecting}
      title="Force personal Microsoft account (consumers endpoint)"
      className="text-[11px] text-dark-400 hover:text-blue-400 underline underline-offset-2 disabled:opacity-40"
    >
      personal
    </button>
  ),
  api: {
    getStatus: api.getOnedriveStatus,
    getAuthUrl: api.getOnedriveAuthUrl,
    disconnect: api.disconnectOnedrive,
  },
};

export default function OneDriveConnect({ agentId, boardId, onStatusChange }) {
  return <OAuthConnectWidget config={ONEDRIVE_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
