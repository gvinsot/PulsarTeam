import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getOnedriveAccessTokenForAgent } from '../routes/onedrive.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAX_READ_BYTES = 5 * 1024 * 1024;

/**
 * Encode a OneDrive path for use in Graph API URLs.
 * Encodes each segment individually to preserve '/' separators.
 */
function encodePath(path) {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return clean.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Helper to call Microsoft Graph API with auto-refreshing tokens.
 * Uses agent-specific tokens when agentId is provided.
 */
async function graphFetch(path: string, agentId: string | null = null, boardId: string | null = null, options: Record<string, any> = {}) {
  const token = await getOnedriveAccessTokenForAgent(agentId, boardId);
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

/**
 * Format file/folder items for display.
 */
function formatItem(item) {
  const isFolder = !!item.folder;
  const size = item.size ? `${(item.size / 1024).toFixed(1)} KB` : '';
  const modified = item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).toLocaleString() : '';
  return {
    name: item.name,
    id: item.id,
    type: isFolder ? 'folder' : 'file',
    size,
    modified,
    path: item.parentReference?.path
      ? `${item.parentReference.path}/${item.name}`
      : `/${item.name}`,
    mimeType: item.file?.mimeType || null,
    webUrl: item.webUrl || null,
    downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
    childCount: item.folder?.childCount || null,
  };
}

/**
 * Create the OneDrive MCP server with all tools registered.
 * @param {string|null} agentId - When provided, tools use agent-specific tokens.
 */
export function createOneDriveMcpServer(agentId = null, boardId = null) {
  const server = new McpServer({
    name: 'OneDrive',
    version: '1.0.0',
  });

  // ── Tool: list_files ──────────────────────────────────────────────────
  server.tool(
    'list_files',
    'List files and folders in a OneDrive directory. Use path "/" for the root.',
    {
      path: z.string().default('/').describe('Folder path in OneDrive (e.g. "/" or "/Documents/Projects")'),
      top: z.number().optional().default(50).describe('Max number of items to return (default 50, max 200)'),
    },
    async ({ path, top }) => {
      const limit = Math.min(top || 50, 200);

      let endpoint;
      if (!path || path === '/' || path === '') {
        endpoint = `/me/drive/root/children?$top=${limit}&$orderby=name`;
      } else {
        endpoint = `/me/drive/root:/${encodePath(path)}:/children?$top=${limit}&$orderby=name`;
      }

      const data = await graphFetch(endpoint, agentId, boardId);
      const items = (data.value || []).map(formatItem);

      const summary = items.map(i => {
        const icon = i.type === 'folder' ? '📁' : '📄';
        const meta = i.type === 'folder' ? `${i.childCount ?? '?'} items` : i.size;
        return `${icon} ${i.name} (${meta})`;
      }).join('\n');

      return {
        content: [{ type: 'text', text: `Found ${items.length} item(s) in "${path || '/'}":\n\n${summary}\n\n---\nJSON:\n${JSON.stringify(items, null, 2)}` }],
      };
    }
  );

  // ── Tool: search_files ────────────────────────────────────────────────
  server.tool(
    'search_files',
    'Search for files by name or content across OneDrive.',
    {
      query: z.string().describe('Search query (file name or content keywords)'),
      top: z.number().optional().default(25).describe('Max results (default 25)'),
    },
    async ({ query, top }) => {
      const limit = Math.min(top || 25, 100);
      const endpoint = `/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${limit}`;

      const data = await graphFetch(endpoint, agentId, boardId);
      const items = (data.value || []).map(formatItem);

      const summary = items.map(i => {
        const icon = i.type === 'folder' ? '📁' : '📄';
        return `${icon} ${i.path} (${i.size})`;
      }).join('\n');

      return {
        content: [{ type: 'text', text: `Search "${query}" found ${items.length} result(s):\n\n${summary}\n\n---\nJSON:\n${JSON.stringify(items, null, 2)}` }],
      };
    }
  );

  // ── Tool: read_file ───────────────────────────────────────────────────
  server.tool(
    'read_file',
    'Read the content of a text file from OneDrive. Returns the text content for text-based files.',
    {
      path: z.string().describe('File path in OneDrive (e.g. "/Documents/notes.txt")'),
    },
    async ({ path }) => {
      // Get file metadata first
      const meta = await graphFetch(`/me/drive/root:/${encodePath(path)}`, agentId, boardId);
      const mimeType = meta.file?.mimeType || '';

      // Check if file is text-readable
      const textTypes = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/x-yaml', 'application/x-sh'];
      const isText = textTypes.some(t => mimeType.startsWith(t)) || mimeType === '';

      if (!meta.folder && meta.size > MAX_READ_BYTES) {
        const dest = meta['@microsoft.graph.downloadUrl'] || meta.webUrl;
        if (!isText) {
          return {
            content: [{ type: 'text', text: `File "${meta.name}" is a binary file (${mimeType}, ${(meta.size / 1024).toFixed(1)} KB). Download URL: ${dest}` }],
          };
        }
        return {
          content: [{ type: 'text', text: `File "${meta.name}" is too large to read directly (${(meta.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_READ_BYTES / 1024 / 1024} MB). Use the download URL instead: ${dest}` }],
        };
      }

      // Download content
      const downloadUrl = meta['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) {
        return {
          content: [{ type: 'text', text: `Cannot read "${meta.name}": no download URL available. Web URL: ${meta.webUrl}` }],
        };
      }

      const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Download failed ${response.status}: ${errText.slice(0, 300)}`);
      }

      // Stream with a byte cap as a backstop — meta.size can be stale or
      // absent, and an unbounded read of a huge file would blow up the heap.
      let content: string;
      const reader = response.body?.getReader();
      if (!reader) {
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length > MAX_READ_BYTES) {
          throw new Error(`File too large to read (${(buf.length / 1024 / 1024).toFixed(1)} MB; max ${MAX_READ_BYTES / 1024 / 1024} MB).`);
        }
        content = buf.toString('utf8');
      } else {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.length;
            if (total > MAX_READ_BYTES) {
              try { await reader.cancel(); } catch { /* ignore */ }
              throw new Error(`File too large to read (>${MAX_READ_BYTES / 1024 / 1024} MB).`);
            }
            chunks.push(value);
          }
        }
        content = Buffer.concat(chunks).toString('utf8');
      }

      return {
        content: [{ type: 'text', text: `File: ${meta.name}\nSize: ${(meta.size / 1024).toFixed(1)} KB\nType: ${mimeType}\nModified: ${meta.lastModifiedDateTime}\n\n--- Content ---\n${content}` }],
      };
    }
  );

  // ── Tool: get_file_info ───────────────────────────────────────────────
  server.tool(
    'get_file_info',
    'Get detailed metadata about a file or folder in OneDrive.',
    {
      path: z.string().describe('File or folder path in OneDrive'),
    },
    async ({ path }) => {
      const meta = await graphFetch(`/me/drive/root:/${encodePath(path)}`, agentId, boardId);
      const info = formatItem(meta);

      return {
        content: [{ type: 'text', text: `File info for "${path}":\n${JSON.stringify(info, null, 2)}\n\nFull metadata:\n${JSON.stringify(meta, null, 2)}` }],
      };
    }
  );

  // ── Tool: create_folder ───────────────────────────────────────────────
  server.tool(
    'create_folder',
    'Create a new folder in OneDrive.',
    {
      parentPath: z.string().default('/').describe('Parent folder path (e.g. "/" or "/Documents")'),
      name: z.string().describe('Name of the new folder'),
    },
    async ({ parentPath, name }) => {
      let endpoint;
      if (!parentPath || parentPath === '/' || parentPath === '') {
        endpoint = '/me/drive/root/children';
      } else {
        endpoint = `/me/drive/root:/${encodePath(parentPath)}:/children`;
      }

      const result = await graphFetch(endpoint, agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({
          name,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename',
        }),
      });

      return {
        content: [{ type: 'text', text: `Folder "${name}" created successfully in "${parentPath}".\nID: ${result.id}\nWeb URL: ${result.webUrl}` }],
      };
    }
  );

  // ── Tool: upload_file ─────────────────────────────────────────────────
  server.tool(
    'upload_file',
    'Upload/create a text file to OneDrive. For small files up to 4MB.',
    {
      path: z.string().describe('Target file path in OneDrive (e.g. "/Documents/file.txt")'),
      content: z.string().describe('Text content to write into the file'),
    },
    async ({ path, content }) => {
      const token = await getOnedriveAccessTokenForAgent(agentId, boardId);

      const url = `${GRAPH_BASE}/me/drive/root:/${encodePath(path)}:/content`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        body: content,
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed ${res.status}: ${text}`);
      }

      const result = await res.json();
      return {
        content: [{ type: 'text', text: `File uploaded to "${path}".\nID: ${result.id}\nSize: ${(result.size / 1024).toFixed(1)} KB\nWeb URL: ${result.webUrl}` }],
      };
    }
  );

  // ── Tool: delete_item ─────────────────────────────────────────────────
  server.tool(
    'delete_item',
    'Delete a file or folder from OneDrive. This moves it to the recycle bin.',
    {
      path: z.string().describe('Path of the file or folder to delete'),
    },
    async ({ path }) => {
      const token = await getOnedriveAccessTokenForAgent(agentId, boardId);

      const url = `${GRAPH_BASE}/me/drive/root:/${encodePath(path)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        throw new Error(`Delete failed ${res.status}: ${text}`);
      }

      return {
        content: [{ type: 'text', text: `"${path}" has been deleted (moved to recycle bin).` }],
      };
    }
  );

  // ── Tool: get_share_link ──────────────────────────────────────────────
  server.tool(
    'get_share_link',
    'Create a sharing link for a file or folder in OneDrive.',
    {
      path: z.string().describe('Path of the file or folder'),
      type: z.enum(['view', 'edit']).default('view').describe('Link type: "view" (read-only) or "edit" (read-write)'),
    },
    async ({ path, type }) => {
      const result = await graphFetch(
        `/me/drive/root:/${encodePath(path)}:/createLink`,
        agentId,
        boardId,
        {
          method: 'POST',
          body: JSON.stringify({
            type: type,
            scope: 'anonymous',
          }),
        }
      );

      return {
        content: [{ type: 'text', text: `Share link for "${path}" (${type}):\n${result.link?.webUrl || JSON.stringify(result)}` }],
      };
    }
  );

  // ── Tool: get_drive_info ──────────────────────────────────────────────
  server.tool(
    'get_drive_info',
    'Get information about the connected OneDrive (storage usage, owner, etc.).',
    {},
    async () => {
      const drive = await graphFetch('/me/drive', agentId, boardId);

      const used = drive.quota?.used || 0;
      const total = drive.quota?.total || 0;
      const pct = total > 0 ? ((used / total) * 100).toFixed(1) : '?';

      return {
        content: [{
          type: 'text',
          text: `OneDrive Info:\n` +
            `Owner: ${drive.owner?.user?.displayName || 'Unknown'}\n` +
            `Drive Type: ${drive.driveType}\n` +
            `Storage: ${(used / 1024 / 1024 / 1024).toFixed(2)} GB / ${(total / 1024 / 1024 / 1024).toFixed(2)} GB (${pct}%)\n` +
            `Remaining: ${((total - used) / 1024 / 1024 / 1024).toFixed(2)} GB\n` +
            `State: ${drive.quota?.state || 'unknown'}`
        }],
      };
    }
  );

  return server;
}

/**
 * Create an Express handler for the OneDrive MCP endpoint.
 * This bridges HTTP requests to the MCP server.
 * Reads X-Agent-Id header to provide agent-specific token resolution.
 */
export function createOneDriveMcpHandler() {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      // Read agent context from custom header (set by MCPManager for per-agent calls)
      const agentId = req.headers['x-agent-id'] || null;
      const boardId = req.headers['x-board-id'] || null;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createOneDriveMcpServer(agentId, boardId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[OneDrive MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
