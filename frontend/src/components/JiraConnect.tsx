import { Ticket, TicketX } from 'lucide-react';
import { api } from '../api';
import CredentialConnectWidget, { CredentialProviderConfig } from './connect/CredentialConnectWidget';

/**
 * Jira connection widget — thin config over the shared CredentialConnectWidget.
 * Unlike Gmail/OneDrive (OAuth2), Jira uses Basic Auth (email + API token).
 */
const JIRA_CONFIG: CredentialProviderConfig = {
  name: 'Jira',
  Icon: Ticket,
  IconDisconnect: TicketX,
  color: 'blue',
  connectButtonLabel: 'Connect Jira',
  badgeDetail: (status) => status.domain || 'Connected',
  requiredError: 'All fields are required',
  fields: [
    { key: 'domain', label: 'Jira Domain', placeholder: 'yourcompany.atlassian.net', required: true },
    { key: 'email', label: 'Email', placeholder: 'you@company.com', type: 'email', required: true },
    {
      key: 'apiToken',
      label: 'API Token',
      placeholder: 'Atlassian API token',
      type: 'password',
      required: true,
      help: (
        <>
          Create at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">id.atlassian.com</a>
        </>
      ),
    },
  ],
  connect: (agentId, boardId, values) =>
    api.connectJira(agentId, values.domain, values.email, values.apiToken, boardId),
  api: {
    getStatus: api.getJiraStatus,
    disconnect: api.disconnectJira,
  },
  connectHint: 'Click "Connect Jira" to configure this agent\'s Jira access with your Atlassian API token.',
};

export default function JiraConnect({ agentId, boardId, onStatusChange }: { agentId?: string; boardId?: string; onStatusChange?: (status: any) => void }) {
  return <CredentialConnectWidget config={JIRA_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
