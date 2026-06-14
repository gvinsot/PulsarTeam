import { Github, Unplug } from 'lucide-react';
import { api } from '../api';
import OAuthConnectWidget, { OAuthProviderConfig } from './connect/OAuthConnectWidget';

/**
 * GitHub OAuth connection widget — thin config over the shared OAuthConnectWidget.
 */
const GITHUB_CONFIG: OAuthProviderConfig = {
  name: 'GitHub',
  Icon: Github,
  IconOff: Github,
  IconDisconnect: Unplug,
  popupName: 'github-oauth',
  messageType: 'github-oauth-callback',
  buttonClass: 'bg-gray-800 hover:bg-gray-700',
  connectLabel: 'Connect with GitHub',
  badgeDetail: (status) => status.login || null,
  configuredHint: (
    <>
      Set <code className="text-dark-400">GITHUB_OAUTH_CLIENT_ID</code> and <code className="text-dark-400">GITHUB_OAUTH_CLIENT_SECRET</code> — one OAuth App serves GitHub login and the per-agent GitHub plugin.
    </>
  ),
  connectHint: (agentId) =>
    agentId
      ? 'Click "Connect with GitHub" to authorize this agent to access GitHub repositories.'
      : 'Click "Connect with GitHub" to authorize access. A popup will open for GitHub login.',
  api: {
    getStatus: api.getGitHubStatus,
    getAuthUrl: api.getGitHubAuthUrl,
    disconnect: api.disconnectGitHub,
  },
};

export default function GitHubConnect({ agentId, boardId, onStatusChange }) {
  return <OAuthConnectWidget config={GITHUB_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
