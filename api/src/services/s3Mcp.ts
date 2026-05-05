import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3CredentialsForAgent } from '../routes/s3.js';

function createS3Client(agentId: string | null, boardId: string | null): S3Client {
  const creds = getS3CredentialsForAgent(agentId, boardId);
  if (!creds) throw new Error('Not connected to AWS S3. Please configure S3 credentials for this agent first.');

  return new S3Client({
    region: creds.region || 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    ...(creds.endpoint ? { endpoint: creds.endpoint, forcePathStyle: true } : {}),
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function createS3McpServer(agentId: string | null = null, boardId: string | null = null) {
  const server = new McpServer({
    name: 'AWS S3',
    version: '1.0.0',
  });

  server.tool(
    'list_buckets',
    'List all S3 buckets in the account.',
    {},
    async () => {
      const client = createS3Client(agentId, boardId);
      const result = await client.send(new ListBucketsCommand({}));
      const buckets = (result.Buckets || []).map(b => ({
        name: b.Name,
        created: b.CreationDate?.toISOString() || null,
      }));

      const summary = buckets.map(b => `- ${b.name} (created: ${b.created || 'unknown'})`).join('\n');
      return {
        content: [{ type: 'text', text: `Found ${buckets.length} bucket(s):\n\n${summary}\n\nJSON:\n${JSON.stringify(buckets, null, 2)}` }],
      };
    }
  );

  server.tool(
    'list_objects',
    'List objects (files) in an S3 bucket. Supports prefix filtering and pagination.',
    {
      bucket: z.string().describe('Bucket name'),
      prefix: z.string().optional().default('').describe('Key prefix to filter (e.g. "uploads/" or "data/2024/")'),
      max_keys: z.number().optional().default(100).describe('Max number of objects to return (default 100, max 1000)'),
      continuation_token: z.string().optional().describe('Token for pagination (from previous response)'),
    },
    async ({ bucket, prefix, max_keys, continuation_token }) => {
      const client = createS3Client(agentId, boardId);
      const result = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        MaxKeys: Math.min(max_keys || 100, 1000),
        ContinuationToken: continuation_token || undefined,
      }));

      const objects = (result.Contents || []).map(obj => ({
        key: obj.Key,
        size: obj.Size,
        sizeFormatted: formatSize(obj.Size || 0),
        lastModified: obj.LastModified?.toISOString() || null,
        storageClass: obj.StorageClass || 'STANDARD',
      }));

      const prefixes = (result.CommonPrefixes || []).map(p => p.Prefix);

      const summary = objects.map(o => {
        const icon = o.key?.endsWith('/') ? '📁' : '📄';
        return `${icon} ${o.key} (${o.sizeFormatted})`;
      }).join('\n');

      const nextToken = result.IsTruncated ? result.NextContinuationToken : null;
      const pagination = nextToken ? `\n\nMore results available. Use continuation_token: "${nextToken}"` : '';

      return {
        content: [{
          type: 'text',
          text: `Bucket "${bucket}" prefix "${prefix || "/"}" — ${objects.length} object(s)${result.IsTruncated ? ` (truncated, ${result.KeyCount} shown)` : ""}:\n\n${summary}${prefixes.length ? `\n\nCommon prefixes: ${prefixes.join(", ")}` : ""}${pagination}\n\nJSON:\n${JSON.stringify(objects, null, 2)}`,
        }],
      };
    }
  );

  server.tool(
    'get_object',
    'Download and read the content of an S3 object. Best for text files. For binary files, use get_presigned_url instead.',
    {
      bucket: z.string().describe('Bucket name'),
      key: z.string().describe('Object key (path)'),
    },
    async ({ bucket, key }) => {
      const client = createS3Client(agentId, boardId);

      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const contentType = head.ContentType || '';
      const size = head.ContentLength || 0;

      if (size > 5 * 1024 * 1024) {
        return {
          content: [{ type: 'text', text: `Object "${key}" is too large to read directly (${formatSize(size)}, type: ${contentType}). Use get_presigned_url to get a download link.` }],
        };
      }

      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await result.Body?.transformToString() || '';

      return {
        content: [{
          type: 'text',
          text: `Object: ${key}\nBucket: ${bucket}\nSize: ${formatSize(size)}\nType: ${contentType}\nLast modified: ${head.LastModified?.toISOString() || 'unknown'}\n\n--- Content ---\n${body}`,
        }],
      };
    }
  );

  server.tool(
    'put_object',
    'Upload content to an S3 object. Creates or overwrites the object.',
    {
      bucket: z.string().describe('Bucket name'),
      key: z.string().describe('Object key (path) — e.g. "data/report.json"'),
      content: z.string().describe('Text content to upload'),
      content_type: z.string().optional().default('text/plain').describe('MIME type (default: text/plain)'),
    },
    async ({ bucket, key, content, content_type }) => {
      const client = createS3Client(agentId, boardId);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: content_type || 'text/plain',
      }));

      return {
        content: [{ type: 'text', text: `Object uploaded: s3://${bucket}/${key} (${formatSize(Buffer.byteLength(content, 'utf8'))}, ${content_type})` }],
      };
    }
  );

  server.tool(
    'delete_object',
    'Delete an object from an S3 bucket.',
    {
      bucket: z.string().describe('Bucket name'),
      key: z.string().describe('Object key (path) to delete'),
    },
    async ({ bucket, key }) => {
      const client = createS3Client(agentId, boardId);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

      return {
        content: [{ type: 'text', text: `Object deleted: s3://${bucket}/${key}` }],
      };
    }
  );

  server.tool(
    'copy_object',
    'Copy an object within or between S3 buckets.',
    {
      source_bucket: z.string().describe('Source bucket name'),
      source_key: z.string().describe('Source object key'),
      dest_bucket: z.string().describe('Destination bucket name'),
      dest_key: z.string().describe('Destination object key'),
    },
    async ({ source_bucket, source_key, dest_bucket, dest_key }) => {
      const client = createS3Client(agentId, boardId);
      await client.send(new CopyObjectCommand({
        CopySource: `${source_bucket}/${source_key}`,
        Bucket: dest_bucket,
        Key: dest_key,
      }));

      return {
        content: [{ type: 'text', text: `Copied s3://${source_bucket}/${source_key} → s3://${dest_bucket}/${dest_key}` }],
      };
    }
  );

  server.tool(
    'get_object_info',
    'Get metadata about an S3 object without downloading it.',
    {
      bucket: z.string().describe('Bucket name'),
      key: z.string().describe('Object key (path)'),
    },
    async ({ bucket, key }) => {
      const client = createS3Client(agentId, boardId);
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

      const info = {
        key,
        bucket,
        size: head.ContentLength,
        sizeFormatted: formatSize(head.ContentLength || 0),
        contentType: head.ContentType,
        lastModified: head.LastModified?.toISOString(),
        eTag: head.ETag,
        storageClass: head.StorageClass || 'STANDARD',
        metadata: head.Metadata || {},
      };

      return {
        content: [{ type: 'text', text: `Object info for s3://${bucket}/${key}:\n${JSON.stringify(info, null, 2)}` }],
      };
    }
  );

  server.tool(
    'get_presigned_url',
    'Generate a presigned URL for downloading or uploading an S3 object (valid for 1 hour).',
    {
      bucket: z.string().describe('Bucket name'),
      key: z.string().describe('Object key (path)'),
      operation: z.enum(['get', 'put']).default('get').describe('"get" for download URL, "put" for upload URL'),
      expires_in: z.number().optional().default(3600).describe('URL validity in seconds (default: 3600 = 1 hour)'),
    },
    async ({ bucket, key, operation, expires_in }) => {
      const client = createS3Client(agentId, boardId);
      const command = operation === 'put'
        ? new PutObjectCommand({ Bucket: bucket, Key: key })
        : new GetObjectCommand({ Bucket: bucket, Key: key });

      const url = await getSignedUrl(client, command, { expiresIn: Math.min(expires_in || 3600, 86400) });

      return {
        content: [{ type: 'text', text: `Presigned ${operation.toUpperCase()} URL for s3://${bucket}/${key} (valid ${expires_in}s):\n${url}` }],
      };
    }
  );

  server.tool(
    'create_bucket',
    'Create a new S3 bucket.',
    {
      bucket: z.string().describe('Bucket name (must be globally unique, lowercase, 3-63 chars)'),
      region: z.string().optional().describe('AWS region for the bucket (uses configured region if omitted)'),
    },
    async ({ bucket, region }) => {
      const creds = getS3CredentialsForAgent(agentId, boardId);
      const client = createS3Client(agentId, boardId);

      const bucketRegion = region || creds?.region || 'us-east-1';
      await client.send(new CreateBucketCommand({
        Bucket: bucket,
        ...(bucketRegion !== 'us-east-1' ? {
          CreateBucketConfiguration: { LocationConstraint: bucketRegion as BucketLocationConstraint },
        } : {}),
      }));

      return {
        content: [{ type: 'text', text: `Bucket "${bucket}" created in ${bucketRegion}.` }],
      };
    }
  );

  return server;
}

export function createS3McpHandler() {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const agentId = req.headers['x-agent-id'] || null;
      const boardId = req.headers['x-board-id'] || null;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createS3McpServer(agentId, boardId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[S3 MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
