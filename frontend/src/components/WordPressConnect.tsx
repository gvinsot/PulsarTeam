import { FileText, FileX } from 'lucide-react';
import { api } from '../api';
import CredentialConnectWidget, { CredentialProviderConfig } from './connect/CredentialConnectWidget';

/**
 * WordPress connection widget — Application Password (Basic Auth).
 * Thin config over the shared CredentialConnectWidget.
 */
const WORDPRESS_CONFIG: CredentialProviderConfig = {
  name: 'WordPress',
  Icon: FileText,
  IconDisconnect: FileX,
  color: 'sky',
  connectButtonLabel: 'Connect WordPress',
  badgeDetail: (status) => status.siteUrl ? new URL(status.siteUrl).host : 'Connected',
  requiredError: 'All fields are required',
  fields: [
    { key: 'siteUrl', label: 'Site URL', placeholder: 'https://blog.example.com', required: true },
    { key: 'username', label: 'Username', placeholder: 'your WordPress login', required: true },
    {
      key: 'applicationPassword',
      label: 'Application Password',
      placeholder: 'xxxx xxxx xxxx xxxx xxxx xxxx',
      type: 'password',
      required: true,
      help: (
        <>
          Create one in WordPress under <span className="text-dark-300">Users → Profile → Application Passwords</span> (do not use your normal account password).
        </>
      ),
    },
  ],
  connect: (agentId, boardId, values) =>
    api.connectWordPress(agentId, values.siteUrl, values.username, values.applicationPassword, boardId),
  api: {
    getStatus: api.getWordPressStatus,
    disconnect: api.disconnectWordPress,
  },
  connectHint: 'Click "Connect WordPress" to configure access with a WordPress Application Password.',
};

export default function WordPressConnect({ agentId, boardId, onStatusChange }: { agentId?: string; boardId?: string; onStatusChange?: (status: any) => void }) {
  return <CredentialConnectWidget config={WORDPRESS_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
