import { Mail, MailX } from 'lucide-react';
import { api } from '../api';
import OAuthConnectWidget, { OAuthProviderConfig } from './connect/OAuthConnectWidget';

/**
 * Outlook OAuth connection widget — thin config over the shared OAuthConnectWidget.
 * Reuses the shared Microsoft OAuth client (MICROSOFT_*) — same Azure App
 * registration as OneDrive. The originating plugin is encoded in the OAuth
 * state so a single redirect URI dispatches tokens to the right provider.
 */
const OUTLOOK_CONFIG: OAuthProviderConfig = {
  name: 'Outlook',
  Icon: Mail,
  IconOff: MailX,
  IconDisconnect: MailX,
  popupName: 'outlook-oauth',
  messageType: 'microsoft-oauth-callback',
  service: 'outlook',
  buttonClass: 'bg-blue-500 hover:bg-blue-600',
  connectLabel: 'Connect with Microsoft',
  badgeDetail: (status) => status.email || null,
  configuredHint: (
    <>
      Set <code className="text-dark-400">MICROSOFT_CLIENT_ID</code> and <code className="text-dark-400">MICROSOFT_CLIENT_SECRET</code> — one OAuth client serves OneDrive, Outlook, and Microsoft login.
    </>
  ),
  connectHint: (agentId) =>
    agentId
      ? 'Click "Connect with Microsoft" to authorize this agent to access Outlook mail.'
      : 'Click "Connect with Microsoft" to authorize Outlook access. A popup will open for Microsoft login.',
  api: {
    getStatus: api.getOutlookStatus,
    getAuthUrl: api.getOutlookAuthUrl,
    disconnect: api.disconnectOutlook,
  },
};

export default function OutlookConnect({ agentId, boardId, onStatusChange }) {
  return <OAuthConnectWidget config={OUTLOOK_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
