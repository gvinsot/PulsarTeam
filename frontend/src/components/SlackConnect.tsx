import { MessageSquare, XCircle } from 'lucide-react';
import { api } from '../api';
import OAuthConnectWidget, { OAuthProviderConfig } from './connect/OAuthConnectWidget';

/**
 * Slack OAuth connection widget — thin config over the shared OAuthConnectWidget.
 */
const SLACK_CONFIG: OAuthProviderConfig = {
  name: 'Slack',
  Icon: MessageSquare,
  IconOff: XCircle,
  IconDisconnect: XCircle,
  popupName: 'slack-oauth',
  messageType: 'slack-oauth-callback',
  buttonClass: 'bg-[#4A154B] hover:bg-[#5b1b5d]',
  connectLabel: 'Connect to Slack',
  badgeDetail: (status) => status.teamName || null,
  configuredHint: (
    <>
      Set <code className="text-dark-400">SLACK_CLIENT_ID</code>, <code className="text-dark-400">SLACK_CLIENT_SECRET</code>, and <code className="text-dark-400">SLACK_REDIRECT_URI</code> environment variables to enable.
    </>
  ),
  connectHint: (agentId) =>
    agentId
      ? 'Click "Connect to Slack" to authorize this agent to access your Slack workspace.'
      : 'Click "Connect to Slack" to authorize workspace access. A popup will open for Slack login.',
  api: {
    getStatus: api.getSlackStatus,
    getAuthUrl: api.getSlackAuthUrl,
    disconnect: api.disconnectSlack,
  },
};

export default function SlackConnect({ agentId, boardId, onStatusChange }) {
  return <OAuthConnectWidget config={SLACK_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
