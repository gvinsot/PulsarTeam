import express from 'express';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken,
} from '../services/database.js';
import type { ScopeType } from '../services/database.js';

function resolveScope(agentId, boardId): { scopeType: ScopeType; scopeId: string } | null {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return null;
}

export function hasS3CredentialsForAgent(agentId: string): boolean {
  if (!agentId) return false;
  return hasOAuthToken('s3', 'agent', agentId);
}

export function hasS3CredentialsForBoard(boardId: string): boolean {
  if (!boardId) return false;
  return hasOAuthToken('s3', 'board', boardId);
}

export function getS3CredentialsForAgent(agentId: string | null, boardId: string | null = null) {
  if (agentId) {
    const token = getOAuthToken('s3', 'agent', agentId);
    if (token) return token.meta as { accessKeyId: string; secretAccessKey: string; region: string; endpoint?: string } | null;
  }
  if (boardId) {
    const token = getOAuthToken('s3', 'board', boardId);
    if (token) return token.meta as { accessKeyId: string; secretAccessKey: string; region: string; endpoint?: string } | null;
  }
  return null;
}

export function s3Routes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const agentId = (req.query.agentId as string) || null;
    const boardId = (req.query.boardId as string) || null;
    if (!agentId && !boardId) {
      return res.json({ connected: false, agentId: null, boardId: null });
    }
    const scope = resolveScope(agentId, boardId);
    if (!scope) return res.json({ connected: false });
    const token = getOAuthToken('s3', scope.scopeType, scope.scopeId);
    res.json({
      connected: !!token,
      region: token?.meta?.region || null,
      endpoint: token?.meta?.endpoint || null,
      agentId,
      boardId,
    });
  });

  router.post('/connect', async (req, res) => {
    const { agentId, boardId, accessKeyId, secretAccessKey, region, endpoint } = req.body;
    if ((!agentId && !boardId) || !accessKeyId || !secretAccessKey) {
      return res.status(400).json({ error: 'agentId or boardId, accessKeyId, and secretAccessKey are required' });
    }

    const awsRegion = region || 'us-east-1';

    try {
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

      const scope = resolveScope(agentId, boardId)!;
      await storeOAuthToken({
        provider: 's3',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        accessToken: accessKeyId,
        meta: { accessKeyId, secretAccessKey, region: awsRegion, ...(endpoint ? { endpoint } : {}) },
      }, { throwOnPersistError: true });

      const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
      console.log(`✅ [S3] Credentials stored for ${target} → ${awsRegion} (${bucketCount} buckets)`);
      res.json({ success: true, agentId, boardId, region: awsRegion, bucketCount });
    } catch (err) {
      console.error('[S3] Connection test failed:', err);
      res.status(400).json({ error: `S3 connection failed: ${err.message}` });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    if (!agentId && !boardId) {
      return res.status(400).json({ error: 'agentId or boardId is required' });
    }
    const scope = resolveScope(agentId, boardId)!;
    await deleteOAuthToken('s3', scope.scopeType, scope.scopeId);
    const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
    console.log(`🔌 [S3] Disconnected ${target}`);
    res.json({ success: true });
  });

  return router;
}
