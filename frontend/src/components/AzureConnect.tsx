import { Cloud, CloudOff } from 'lucide-react';
import { api } from '../api';
import CredentialConnectWidget, {
  CredentialProviderConfig,
} from './connect/CredentialConnectWidget';
import type { ConnectStatus } from './connect/useConnectStatus';

/**
 * Azure CLI connection widget — a service principal the runner logs the
 * agent's `az` in with. Thin config over the shared CredentialConnectWidget.
 */
const AZURE_CONFIG: CredentialProviderConfig = {
  name: 'Azure',
  Icon: Cloud,
  IconDisconnect: CloudOff,
  color: 'sky',
  connectButtonLabel: 'Connect Azure',
  badgeDetail: status =>
    status.subscriptionName || status.subscriptionId || status.tenantId || 'Connected',
  requiredError: 'Tenant ID, Client ID and Client Secret are required',
  fields: [
    {
      key: 'tenantId',
      label: 'Tenant ID',
      placeholder: '00000000-0000-0000-0000-000000000000 or contoso.onmicrosoft.com',
      required: true,
    },
    {
      key: 'clientId',
      label: 'Client (application) ID',
      placeholder: '00000000-0000-0000-0000-000000000000',
      required: true,
    },
    {
      key: 'clientSecret',
      label: 'Client Secret',
      placeholder: 'Service principal secret value',
      type: 'password',
      required: true,
    },
    {
      key: 'subscriptionId',
      label: (
        <>
          Default subscription ID{' '}
          <span className="text-dark-500">(optional — auto-selected when there is only one)</span>
        </>
      ),
      placeholder: '00000000-0000-0000-0000-000000000000',
    },
  ],
  formFooter: (
    <p className="text-[10px] text-dark-500">
      Create one with{' '}
      <code className="text-sky-400">
        az ad sp create-for-rbac --name pulsar-agent --role Contributor --scopes
        /subscriptions/&lt;id&gt;
      </code>{' '}
      and copy its tenant, appId and password. The agent gets the principal&apos;s permissions.
    </p>
  ),
  connect: (agentId, boardId, values) =>
    api.connectAzure(agentId, boardId, {
      tenantId: values.tenantId,
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      subscriptionId: values.subscriptionId || undefined,
    }),
  api: {
    getStatus: api.getAzureStatus,
    disconnect: api.disconnectAzure,
  },
  connectHint:
    'Click "Connect Azure" to log this agent\'s az CLI in with a service principal (CLI runners only).',
};

export default function AzureConnect({
  agentId,
  boardId,
  onStatusChange,
}: {
  agentId?: string;
  boardId?: string;
  onStatusChange?: (status: ConnectStatus) => void;
}) {
  return (
    <CredentialConnectWidget
      config={AZURE_CONFIG}
      agentId={agentId}
      boardId={boardId}
      onStatusChange={onStatusChange}
    />
  );
}
