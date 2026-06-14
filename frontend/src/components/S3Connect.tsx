import { Cloud, CloudOff } from 'lucide-react';
import { api } from '../api';
import CredentialConnectWidget, { CredentialProviderConfig } from './connect/CredentialConnectWidget';

/**
 * AWS S3 connection widget — thin config over the shared CredentialConnectWidget.
 */
const S3_CONFIG: CredentialProviderConfig = {
  name: 'AWS S3',
  statusName: 'S3',
  Icon: Cloud,
  IconDisconnect: CloudOff,
  color: 'orange',
  connectButtonLabel: 'Connect S3',
  badgeDetail: (status) => status.region || 'Connected',
  requiredError: 'Access Key ID and Secret Access Key are required',
  fields: [
    { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIAIOSFODNN7EXAMPLE', required: true },
    { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', type: 'password', required: true },
    { key: 'region', label: 'Region', placeholder: 'us-east-1', initial: 'us-east-1' },
    {
      key: 'endpoint',
      label: (
        <>Custom Endpoint <span className="text-dark-500">(optional — for S3-compatible services like MinIO)</span></>
      ),
      placeholder: 'https://s3.example.com',
    },
  ],
  formFooter: (
    <p className="text-[10px] text-dark-500">
      Create IAM credentials at{' '}
      <a href="https://console.aws.amazon.com/iam/" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:underline">
        AWS IAM Console
      </a>
    </p>
  ),
  // Note: api.connectS3 takes secretAccessKey before accessKeyId.
  connect: (agentId, boardId, values) =>
    api.connectS3(agentId, values.secretAccessKey, values.accessKeyId, values.region, boardId, values.endpoint || undefined),
  api: {
    getStatus: api.getS3Status,
    disconnect: api.disconnectS3,
  },
  connectHint: 'Click "Connect S3" to configure AWS credentials for this agent.',
};

export default function S3Connect({ agentId, boardId, onStatusChange }: { agentId?: string; boardId?: string; onStatusChange?: (status: any) => void }) {
  return <CredentialConnectWidget config={S3_CONFIG} agentId={agentId} boardId={boardId} onStatusChange={onStatusChange} />;
}
