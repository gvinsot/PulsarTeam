import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import {
  credentialConnectorRoutes,
  getProviderCredentials,
} from './lib/credentialConnector.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  endpoint?: string;
}

export const getS3CredentialsForAgent = (
  agentId: string | null,
  boardId: string | null = null,
): S3Credentials | null => getProviderCredentials<S3Credentials>('s3', agentId, boardId);

export function s3Routes() {
  return credentialConnectorRoutes({
    provider: 's3',
    label: 'S3',
    statusFields: (meta) => ({
      region: meta?.region || null,
      endpoint: meta?.endpoint || null,
    }),
    connect: async ({ agentId, boardId, accessKeyId, secretAccessKey, region, endpoint }) => {
      if ((!agentId && !boardId) || !accessKeyId || !secretAccessKey) {
        return { error: 'agentId or boardId, accessKeyId, and secretAccessKey are required', status: 400 };
      }

      const awsRegion = region || 'us-east-1';

      const clientOpts: any = {
        region: awsRegion,
        credentials: { accessKeyId, secretAccessKey },
      };
      if (endpoint) {
        clientOpts.endpoint = endpoint;
        clientOpts.forcePathStyle = true;
      }
      const client = new S3Client(clientOpts);
      const result = await client.send(new ListBucketsCommand({}));
      const bucketCount = result.Buckets?.length || 0;

      return {
        accessToken: accessKeyId,
        meta: { accessKeyId, secretAccessKey, region: awsRegion, ...(endpoint ? { endpoint } : {}) },
        extra: { region: awsRegion, bucketCount },
        logSuffix: `→ ${awsRegion} (${bucketCount} buckets)`,
      };
    },
    onError: (err) => ({ status: 400, message: `S3 connection failed: ${err.message}` }),
  });
}
