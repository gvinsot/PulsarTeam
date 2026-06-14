import { Mail, MailX } from 'lucide-react';
import { api } from '../api';
import OAuthConnectWidget, { OAuthProviderConfig } from './connect/OAuthConnectWidget';

/**
 * Gmail OAuth connection widget — thin config over the shared OAuthConnectWidget.
 */
const GMAIL_CONFIG: OAuthProviderConfig = {
  name: 'Gmail',
  Icon: Mail,
  IconOff: MailX,
  IconDisconnect: MailX,
  popupName: 'gmail-oauth',
  messageType: 'gmail-oauth-callback',
  buttonClass: 'bg-blue-500 hover:bg-blue-600',
  connectLabel: 'Connect with Google',
  badgeDetail: (status) => status.email || null,
  configuredHint: (
    <>
      Set <code className="text-dark-400">GOOGLE_CLIENT_ID</code> and <code className="text-dark-400">GOOGLE_CLIENT_SECRET</code> — one OAuth client serves Gmail, Drive, and Google login.
    </>
  ),
  connectHint: (agentId) =>
    agentId
      ? 'Click "Connect with Google" to authorize this agent to access Gmail.'
      : 'Click "Connect with Google" to authorize Gmail access. A popup will open for Google login.',
  api: {
    getStatus: api.getGmailStatus,
    getAuthUrl: api.getGmailAuthUrl,
    disconnect: api.disconnectGmail,
  },
};

export default function GmailConnect({ agentId, boardId, onStatusChange }) {
  return <OAuthConnectWidget config={GMAIL_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
