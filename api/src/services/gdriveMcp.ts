import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getGdriveAccessTokenForAgent } from '../routes/gdrive.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

const MAX_TEXT_READ_BYTES = 5 * 1024 * 1024;

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Map Google-native mime types to a plain-text export format.
const NATIVE_EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
  'application/vnd.google-apps.drawing': 'image/png',
};

async function driveFetch(
  path: string,
  agentId: string | null = null,
  boardId: string | null = null,
  options: Record<string, any> = {},
) {
  const token = await getGdriveAccessTokenForAgent(agentId, boardId);
  const url = path.startsWith('http') ? path : `${DRIVE_BASE}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  if (options.body && !headers['Content-Type'] && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(options.raw ? 120_000 : 60_000), ...options, headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API error ${res.status}: ${text}`);
  }

  if (options.raw) {
    return res;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatItem(item: any) {
  const isFolder = item.mimeType === FOLDER_MIME;
  const size = item.size ? `${(Number(item.size) / 1024).toFixed(1)} KB` : '';
  const modified = item.modifiedTime ? new Date(item.modifiedTime).toLocaleString() : '';
  return {
    id: item.id,
    name: item.name,
    type: isFolder ? 'folder' : 'file',
    mimeType: item.mimeType || null,
    size,
    modified,
    parents: item.parents || [],
    webViewLink: item.webViewLink || null,
    trashed: !!item.trashed,
  };
}

/**
 * Resolve a Drive item ID either from an explicit id or by resolving a path
 * (e.g. "/Documents/notes.txt"). Returns the file metadata (id, name, mimeType,
 * parents).
 */
async function resolveItemId(
  pathOrId: string,
  agentId: string | null,
  boardId: string | null,
): Promise<{ id: string; name: string; mimeType: string }> {
  if (!pathOrId) throw new Error('A non-empty path or id is required.');

  // Treat any value containing "/" or starting with the root as a path.
  const looksLikePath = pathOrId === '/' || pathOrId.includes('/');
  if (!looksLikePath) {
    const meta = await driveFetch(
      `/files/${encodeURIComponent(pathOrId)}?fields=id,name,mimeType`,
      agentId,
      boardId,
    );
    return { id: meta.id, name: meta.name, mimeType: meta.mimeType };
  }

  const segments = pathOrId.split('/').map(s => s.trim()).filter(Boolean);
  let parentId = 'root';
  let lastMeta: any = { id: 'root', name: 'My Drive', mimeType: FOLDER_MIME };

  for (const segment of segments) {
    const q = `'${parentId}' in parents and name = '${escapeDriveQuery(segment)}' and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,mimeType)',
      pageSize: '2',
    });
    const result = await driveFetch(`/files?${params}`, agentId, boardId);
    const files = result.files || [];
    if (files.length === 0) {
      throw new Error(`Drive item not found: "${pathOrId}" (segment "${segment}" missing under parent "${lastMeta.name}").`);
    }
    if (files.length > 1) {
      throw new Error(`Drive path "${pathOrId}" is ambiguous: multiple items named "${segment}" exist. Use the file id instead.`);
    }
    lastMeta = files[0];
    parentId = files[0].id;
  }

  return { id: lastMeta.id, name: lastMeta.name, mimeType: lastMeta.mimeType };
}

/**
 * Download the bytes of a Drive file, exporting Google-native formats to a
 * plain-text variant when possible. Returns { buffer, mimeType, exported }.
 */
async function downloadFile(
  fileId: string,
  mimeType: string,
  agentId: string | null,
  boardId: string | null,
  maxBytes: number = MAX_TEXT_READ_BYTES,
): Promise<{ buffer: Buffer; mimeType: string; exported: boolean }> {
  if (mimeType === FOLDER_MIME) {
    throw new Error('Cannot download a folder.');
  }

  const exportMime = NATIVE_EXPORT_MIME[mimeType];
  let res: Response;
  let outMime = mimeType;
  let exported = false;

  if (exportMime) {
    res = await driveFetch(
      `/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`,
      agentId,
      boardId,
      { raw: true },
    );
    outMime = exportMime;
    exported = true;
  } else {
    res = await driveFetch(
      `/files/${encodeURIComponent(fileId)}?alt=media`,
      agentId,
      boardId,
      { raw: true },
    );
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`File too large to read (${(buf.length / 1024 / 1024).toFixed(1)} MB; max ${(maxBytes / 1024 / 1024).toFixed(1)} MB).`);
    }
    return { buffer: buf, mimeType: outMime, exported };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`File too large to read (>${(maxBytes / 1024 / 1024).toFixed(1)} MB).`);
      }
      chunks.push(value);
    }
  }
  return { buffer: Buffer.concat(chunks), mimeType: outMime, exported };
}

export function createGdriveMcpServer(
  agentId: string | null = null,
  boardId: string | null = null,
) {
  const server = new McpServer({
    name: 'GoogleDrive',
    version: '1.0.0',
  });

  // ── Tool: get_drive_info ─────────────────────────────────────────────
  server.tool(
    'get_drive_info',
    'Get the connected Google Drive account info (email, storage quota).',
    {},
    async () => {
      const about = await driveFetch(
        '/about?fields=user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive)',
        agentId,
        boardId,
      );
      const quota = about.storageQuota || {};
      const limit = quota.limit ? `${(Number(quota.limit) / 1024 / 1024 / 1024).toFixed(2)} GB` : 'unlimited';
      const usage = quota.usage ? `${(Number(quota.usage) / 1024 / 1024 / 1024).toFixed(2)} GB` : '0 GB';
      const inDrive = quota.usageInDrive ? `${(Number(quota.usageInDrive) / 1024 / 1024 / 1024).toFixed(2)} GB` : '0 GB';

      return {
        content: [{
          type: 'text',
          text: `Google Drive:\n` +
            `User: ${about.user?.displayName || ''} <${about.user?.emailAddress || ''}>\n` +
            `Total quota: ${limit}\n` +
            `Used: ${usage} (${inDrive} in My Drive)`
        }],
      };
    }
  );

  // ── Tool: list_files ─────────────────────────────────────────────────
  server.tool(
    'list_files',
    'List files and folders. Pass "path" (e.g. "/" or "/Documents") or "folderId" to scope the listing.',
    {
      path: z.string().optional().describe('Folder path. "/" for root. Defaults to root when neither path nor folderId is given.'),
      folderId: z.string().optional().describe('Drive folder id (alternative to path).'),
      pageSize: z.number().optional().default(50).describe('Number of items to return (1-100, default 50).'),
      includeTrashed: z.boolean().optional().default(false).describe('Include items in the trash.'),
    },
    async ({ path, folderId, pageSize, includeTrashed }) => {
      let parentId = 'root';
      let parentName = 'My Drive';

      if (folderId) {
        const meta = await driveFetch(
          `/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType`,
          agentId,
          boardId,
        );
        if (meta.mimeType !== FOLDER_MIME) {
          throw new Error(`"${folderId}" is not a folder.`);
        }
        parentId = meta.id;
        parentName = meta.name;
      } else if (path && path !== '/') {
        const resolved = await resolveItemId(path, agentId, boardId);
        if (resolved.mimeType !== FOLDER_MIME) {
          throw new Error(`"${path}" is not a folder.`);
        }
        parentId = resolved.id;
        parentName = resolved.name;
      }

      const q = `'${parentId}' in parents${includeTrashed ? '' : ' and trashed = false'}`;
      const params = new URLSearchParams({
        q,
        pageSize: String(Math.min(Math.max(pageSize || 50, 1), 100)),
        orderBy: 'folder,name',
        fields: 'files(id,name,mimeType,size,modifiedTime,parents,webViewLink,trashed)',
      });

      const result = await driveFetch(`/files?${params}`, agentId, boardId);
      const items = (result.files || []).map(formatItem);

      if (items.length === 0) {
        return { content: [{ type: 'text', text: `Folder "${parentName}" is empty.` }] };
      }

      const lines = items.map((it: any) => {
        const icon = it.type === 'folder' ? '📁' : '📄';
        const meta = [it.size, it.modified].filter(Boolean).join(' · ');
        return `${icon} ${it.name}   [${it.mimeType || it.type}]${meta ? `\n     ${meta}` : ''}\n     id: ${it.id}`;
      });

      return {
        content: [{
          type: 'text',
          text: `Folder: ${parentName} (id: ${parentId})\nItems: ${items.length}\n\n${lines.join('\n\n')}`,
        }],
      };
    }
  );

  // ── Tool: search_files ───────────────────────────────────────────────
  server.tool(
    'search_files',
    'Search files by name or content using Drive query syntax. Examples: "name contains \'report\'", "mimeType = \'application/pdf\'", "fullText contains \'budget\'". Pass a plain string and it will be wrapped in a name/fullText match.',
    {
      query: z.string().describe('Drive search query. Plain strings match name or full text.'),
      pageSize: z.number().optional().default(25).describe('Max results (1-100, default 25).'),
      includeTrashed: z.boolean().optional().default(false),
    },
    async ({ query, pageSize, includeTrashed }) => {
      let q: string;
      const hasOperator = /\b(contains|=|!=|<|>|in)\b/i.test(query);
      if (hasOperator) {
        q = query;
      } else {
        const escaped = escapeDriveQuery(query);
        q = `(name contains '${escaped}' or fullText contains '${escaped}')`;
      }
      if (!includeTrashed) q += ' and trashed = false';

      const params = new URLSearchParams({
        q,
        pageSize: String(Math.min(Math.max(pageSize || 25, 1), 100)),
        fields: 'files(id,name,mimeType,size,modifiedTime,parents,webViewLink,trashed)',
      });

      const result = await driveFetch(`/files?${params}`, agentId, boardId);
      const items = (result.files || []).map(formatItem);

      if (items.length === 0) {
        return { content: [{ type: 'text', text: `No results for query: ${query}` }] };
      }

      const lines = items.map((it: any) => {
        const icon = it.type === 'folder' ? '📁' : '📄';
        const meta = [it.size, it.modified].filter(Boolean).join(' · ');
        return `${icon} ${it.name}   [${it.mimeType || it.type}]${meta ? ` — ${meta}` : ''}\n     id: ${it.id}`;
      });

      return {
        content: [{ type: 'text', text: `${items.length} result(s) for "${query}":\n\n${lines.join('\n\n')}` }],
      };
    }
  );

  // ── Tool: get_file_info ──────────────────────────────────────────────
  server.tool(
    'get_file_info',
    'Get detailed metadata about a file or folder. Pass either "path" or "fileId".',
    {
      path: z.string().optional().describe('Drive path (e.g. "/Documents/report.pdf").'),
      fileId: z.string().optional().describe('Drive file id (alternative to path).'),
    },
    async ({ path, fileId }) => {
      if (!path && !fileId) throw new Error('Provide "path" or "fileId".');
      const resolved = fileId
        ? { id: fileId, name: '', mimeType: '' }
        : await resolveItemId(path!, agentId, boardId);

      const meta = await driveFetch(
        `/files/${encodeURIComponent(resolved.id)}?fields=id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,owners(displayName,emailAddress),shared,trashed,description`,
        agentId,
        boardId,
      );

      const size = meta.size ? `${(Number(meta.size) / 1024).toFixed(1)} KB` : '—';
      const owners = (meta.owners || []).map((o: any) => `${o.displayName} <${o.emailAddress}>`).join(', ');

      return {
        content: [{
          type: 'text',
          text:
            `Name: ${meta.name}\n` +
            `ID: ${meta.id}\n` +
            `Type: ${meta.mimeType}\n` +
            `Size: ${size}\n` +
            `Created: ${meta.createdTime || '—'}\n` +
            `Modified: ${meta.modifiedTime || '—'}\n` +
            `Owners: ${owners || '—'}\n` +
            `Shared: ${meta.shared ? 'yes' : 'no'}\n` +
            `Trashed: ${meta.trashed ? 'yes' : 'no'}\n` +
            `Web link: ${meta.webViewLink || '—'}\n` +
            `Parents: ${(meta.parents || []).join(', ') || '—'}\n` +
            (meta.description ? `Description: ${meta.description}\n` : ''),
        }],
      };
    }
  );

  // ── Tool: read_file ──────────────────────────────────────────────────
  server.tool(
    'read_file',
    'Read the content of a Drive file. Google Docs/Sheets/Slides are exported to plain text/CSV. Other binary files are returned as base64.',
    {
      path: z.string().optional().describe('Drive path (e.g. "/Documents/notes.txt").'),
      fileId: z.string().optional().describe('Drive file id (alternative to path).'),
      maxBytes: z.number().optional().describe(`Max bytes to read (default ${MAX_TEXT_READ_BYTES}).`),
    },
    async ({ path, fileId, maxBytes }) => {
      if (!path && !fileId) throw new Error('Provide "path" or "fileId".');
      const meta = fileId
        ? await driveFetch(
            `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
            agentId,
            boardId,
          )
        : await resolveItemId(path!, agentId, boardId);

      const limit = Math.min(maxBytes || MAX_TEXT_READ_BYTES, MAX_TEXT_READ_BYTES);
      const { buffer, mimeType, exported } = await downloadFile(
        meta.id,
        meta.mimeType,
        agentId,
        boardId,
        limit,
      );

      const looksText =
        mimeType.startsWith('text/') ||
        mimeType === 'application/json' ||
        mimeType === 'application/xml' ||
        mimeType === 'application/javascript' ||
        mimeType === 'application/csv';

      if (looksText) {
        const text = buffer.toString('utf-8');
        return {
          content: [{
            type: 'text',
            text:
              `File: ${meta.name} (${meta.mimeType}${exported ? ` → exported as ${mimeType}` : ''})\n` +
              `Bytes: ${buffer.length}\n\n${text}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text:
            `Binary file ${meta.name} (${mimeType}, ${buffer.length} bytes).\n` +
            `Base64 content:\n${buffer.toString('base64')}`,
        }],
      };
    }
  );

  // ── Tool: create_folder ──────────────────────────────────────────────
  server.tool(
    'create_folder',
    'Create a new folder under a given parent. Provide either "parentPath" or "parentId" (defaults to root).',
    {
      name: z.string().describe('Folder name.'),
      parentPath: z.string().optional().describe('Parent folder path (e.g. "/Documents"). Defaults to root.'),
      parentId: z.string().optional().describe('Parent folder id (alternative to parentPath).'),
    },
    async ({ name, parentPath, parentId }) => {
      let parent = 'root';
      if (parentId) {
        parent = parentId;
      } else if (parentPath && parentPath !== '/') {
        const resolved = await resolveItemId(parentPath, agentId, boardId);
        if (resolved.mimeType !== FOLDER_MIME) throw new Error(`"${parentPath}" is not a folder.`);
        parent = resolved.id;
      }

      const result = await driveFetch('/files?fields=id,name,parents,webViewLink', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
      });

      return {
        content: [{
          type: 'text',
          text: `Folder created: ${result.name}\nID: ${result.id}\nParent: ${parent}\nLink: ${result.webViewLink || '—'}`,
        }],
      };
    }
  );

  // ── Tool: upload_file ────────────────────────────────────────────────
  server.tool(
    'upload_file',
    'Upload a new file to Drive (text or base64). Provide either "parentPath" or "parentId" (defaults to root).',
    {
      name: z.string().describe('File name with extension (e.g. "report.txt").'),
      content: z.string().describe('File content. UTF-8 text by default, or base64 when "encoding" is "base64".'),
      mimeType: z.string().optional().describe('MIME type (e.g. "text/plain", "application/pdf"). Auto-detected from extension when omitted.'),
      encoding: z.enum(['utf8', 'base64']).optional().default('utf8').describe('Encoding of "content" (default utf8).'),
      parentPath: z.string().optional().describe('Parent folder path. Defaults to root.'),
      parentId: z.string().optional().describe('Parent folder id (alternative to parentPath).'),
    },
    async ({ name, content, mimeType, encoding, parentPath, parentId }) => {
      let parent = 'root';
      if (parentId) {
        parent = parentId;
      } else if (parentPath && parentPath !== '/') {
        const resolved = await resolveItemId(parentPath, agentId, boardId);
        if (resolved.mimeType !== FOLDER_MIME) throw new Error(`"${parentPath}" is not a folder.`);
        parent = resolved.id;
      }

      const buffer = encoding === 'base64'
        ? Buffer.from(content.replace(/\s+/g, ''), 'base64')
        : Buffer.from(content, 'utf-8');

      const finalMime = mimeType || 'application/octet-stream';
      const metadata = { name, parents: [parent], mimeType: finalMime };

      const boundary = `pulsar_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${finalMime}\r\n\r\n`;
      const tail = `\r\n--${boundary}--`;
      const body = Buffer.concat([Buffer.from(head, 'utf-8'), buffer, Buffer.from(tail, 'utf-8')]);

      const token = await getGdriveAccessTokenForAgent(agentId, boardId);
      const res = await fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents`, {
        signal: AbortSignal.timeout(120_000),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Drive upload failed (${res.status}): ${text}`);
      }
      const result = await res.json();

      return {
        content: [{
          type: 'text',
          text:
            `File uploaded: ${result.name}\n` +
            `ID: ${result.id}\n` +
            `MIME: ${result.mimeType}\n` +
            `Parent: ${parent}\n` +
            `Bytes: ${buffer.length}\n` +
            `Link: ${result.webViewLink || '—'}`,
        }],
      };
    }
  );

  // ── Tool: delete_item ────────────────────────────────────────────────
  server.tool(
    'delete_item',
    'Move a file or folder to the trash (recoverable). Pass "permanent": true to delete permanently.',
    {
      path: z.string().optional().describe('Drive path (e.g. "/Documents/old.txt").'),
      fileId: z.string().optional().describe('Drive file id (alternative to path).'),
      permanent: z.boolean().optional().default(false).describe('Permanently delete instead of trashing.'),
    },
    async ({ path, fileId, permanent }) => {
      if (!path && !fileId) throw new Error('Provide "path" or "fileId".');
      const resolved = fileId
        ? { id: fileId, name: '', mimeType: '' }
        : await resolveItemId(path!, agentId, boardId);

      if (permanent) {
        await driveFetch(`/files/${encodeURIComponent(resolved.id)}`, agentId, boardId, { method: 'DELETE' });
        return {
          content: [{ type: 'text', text: `Permanently deleted: ${resolved.name || resolved.id}` }],
        };
      }

      await driveFetch(`/files/${encodeURIComponent(resolved.id)}?fields=id,trashed`, agentId, boardId, {
        method: 'PATCH',
        body: JSON.stringify({ trashed: true }),
      });
      return {
        content: [{ type: 'text', text: `Moved to trash: ${resolved.name || resolved.id}` }],
      };
    }
  );

  // ── Tool: get_share_link ─────────────────────────────────────────────
  server.tool(
    'get_share_link',
    'Create or retrieve a shareable link for a file/folder. Type "view" (read-only) or "edit" (write).',
    {
      path: z.string().optional().describe('Drive path.'),
      fileId: z.string().optional().describe('Drive file id (alternative to path).'),
      type: z.enum(['view', 'edit']).optional().default('view').describe('Permission type.'),
      anyoneWithLink: z.boolean().optional().default(true).describe('When true, anyone with the link gets access. When false, the file is only shared with explicitly added users (no link permission created).'),
    },
    async ({ path, fileId, type, anyoneWithLink }) => {
      if (!path && !fileId) throw new Error('Provide "path" or "fileId".');
      const resolved = fileId
        ? { id: fileId, name: '', mimeType: '' }
        : await resolveItemId(path!, agentId, boardId);

      if (anyoneWithLink) {
        await driveFetch(`/files/${encodeURIComponent(resolved.id)}/permissions`, agentId, boardId, {
          method: 'POST',
          body: JSON.stringify({
            role: type === 'edit' ? 'writer' : 'reader',
            type: 'anyone',
            allowFileDiscovery: false,
          }),
        });
      }

      const meta = await driveFetch(
        `/files/${encodeURIComponent(resolved.id)}?fields=id,name,webViewLink`,
        agentId,
        boardId,
      );

      return {
        content: [{
          type: 'text',
          text:
            `Share link for ${meta.name}:\n` +
            `${meta.webViewLink}\n` +
            `Access: ${anyoneWithLink ? `anyone with link can ${type === 'edit' ? 'edit' : 'view'}` : 'restricted (no link permission added)'}`,
        }],
      };
    }
  );

  return server;
}

export function createGdriveMcpHandler() {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const agentId = req.headers['x-agent-id'] || null;
      const boardId = req.headers['x-board-id'] || null;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createGdriveMcpServer(agentId, boardId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[Gdrive MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
