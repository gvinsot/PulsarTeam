import { HardDrive, XCircle } from 'lucide-react';
import { api } from '../api';
import OAuthConnectWidget, { OAuthProviderConfig } from './connect/OAuthConnectWidget';

/**
 * Google Drive OAuth connection widget — thin config over the shared OAuthConnectWidget.
 */
const GDRIVE_CONFIG: OAuthProviderConfig = {
  name: 'Google Drive',
  Icon: HardDrive,
  IconOff: HardDrive,
  IconDisconnect: XCircle,
  popupName: 'gdrive-oauth',
  messageType: 'gdrive-oauth-callback',
  buttonClass: 'bg-blue-500 hover:bg-blue-600',
  connectLabel: 'Connect with Google',
  badgeDetail: (status) => status.email || null,
  configuredHint: (
    <>
      Set <code className="text-dark-400">GOOGLE_CLIENT_ID</code> and <code className="text-dark-400">GOOGLE_CLIENT_SECRET</code> — one OAuth client serves Gmail, Drive, and Google login. Enable the Drive API in the Google Cloud Console and register the redirect URIs there.
    </>
  ),
  connectHint: (agentId) =>
    agentId
      ? 'Click "Connect with Google" to authorize this agent to access Google Drive.'
      : 'Click "Connect with Google" to authorize Google Drive access. A popup will open for Google login.',
  api: {
    getStatus: api.getGdriveStatus,
    getAuthUrl: api.getGdriveAuthUrl,
    disconnect: api.disconnectGdrive,
  },
};

export default function GoogleDriveConnect({ agentId, boardId, onStatusChange }) {
  return <OAuthConnectWidget config={GDRIVE_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
