import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getOutlookAccessTokenForAgent } from '../routes/outlook.js';

/**
 * Outlook MCP — mirrors the Gmail MCP but talks to Microsoft Graph
 * (https://graph.microsoft.com/v1.0/me/...).
 *
 * Mail body content is exchanged as plain text (contentType: "Text") for
 * simplicity. Attachments use the inline FileAttachment shape:
 *   { "@odata.type": "#microsoft.graph.fileAttachment", "name", "contentBytes" }
 * which works for messages up to ~3 MB after base64 (Graph limit on inline
 * attachment payload). Large-file uploads via the upload-session API are out
 * of scope for parity with the Gmail MCP.
 */

type RunnerExecBridge = {
  exec: (
    agentId: string,
    command: string,
    options?: { cwd?: string; timeout?: number; maxOutput?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
};

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Microsoft Graph allows messages up to ~4 MB for the JSON body containing
// inline base64 attachments. Cap individual attachment binary size at 3 MB so
// the encoded payload + envelope stay safely below the limit.
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ics': 'text/calendar',
};

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Call Microsoft Graph with auto-refreshing tokens.
 */
async function graphFetch(
  pathOrUrl: string,
  agentId: string | null = null,
  boardId: string | null = null,
  options: Record<string, any> = {},
): Promise<any> {
  const token = await getOutlookAccessTokenForAgent(agentId, boardId);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft Graph error ${res.status}: ${text}`);
  }

  if (res.status === 202 || res.status === 204) return null;

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function readAttachmentViaRunner(
  bridge: RunnerExecBridge,
  agentId: string,
  filePath: string,
): Promise<Buffer> {
  const probe = await bridge.exec(
    agentId,
    `if [ ! -e ${shQuote(filePath)} ]; then echo "MISSING"; elif [ ! -f ${shQuote(filePath)} ]; then echo "NOT_A_FILE"; elif [ ! -r ${shQuote(filePath)} ]; then echo "UNREADABLE"; else stat -c %s ${shQuote(filePath)}; fi`,
    { timeout: 10000 },
  );
  const probeOut = (probe.stdout || '').trim();
  if (probeOut === 'MISSING') {
    throw new Error(`Cannot read attachment "${filePath}": file not found in agent workspace`);
  }
  if (probeOut === 'NOT_A_FILE') {
    throw new Error(`Attachment path "${filePath}" is not a regular file`);
  }
  if (probeOut === 'UNREADABLE') {
    throw new Error(`Cannot read attachment "${filePath}": permission denied (cross-agent access is blocked)`);
  }
  const size = parseInt(probeOut, 10);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`Cannot stat attachment "${filePath}" via runner: ${probe.stderr || probeOut || 'unknown error'}`);
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment "${filePath}" is ${(size / 1024 / 1024).toFixed(1)} MB, ` +
      `which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB inline-attachment limit for Outlook.`,
    );
  }

  const res = await bridge.exec(
    agentId,
    `base64 -w0 ${shQuote(filePath)}`,
    { timeout: 120000, maxOutput: 8 * 1024 * 1024 },
  );
  const b64 = (res.stdout || '').replace(/\s+/g, '');
  if (!b64) {
    throw new Error(`Empty content reading "${filePath}" via runner: ${res.stderr || 'no output'}`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== size) {
    throw new Error(
      `Attachment "${filePath}" was truncated during transfer ` +
      `(expected ${size} bytes, got ${buf.length}).`,
    );
  }
  return buf;
}

type GraphAttachment = {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
};

type AttachmentInput = {
  path?: string;
  filename?: string;
  mimeType?: string;
  content?: string;
};

async function resolveAttachment(
  att: AttachmentInput,
  agentId: string | null = null,
  runnerBridge: RunnerExecBridge | null = null,
): Promise<GraphAttachment> {
  if (!att || typeof att !== 'object') {
    throw new Error('Each attachment must be an object.');
  }

  const hasPath = typeof att.path === 'string' && att.path.length > 0;
  const hasContent = typeof att.content === 'string' && att.content.length > 0;

  if (hasPath && hasContent) {
    throw new Error('Provide either "path" or "content" for an attachment, not both.');
  }
  if (!hasPath && !hasContent) {
    throw new Error('Each attachment must specify "path" (file on disk) or "content" (base64).');
  }

  if (hasPath) {
    const userPath = att.path!;
    let buf: Buffer | null = null;
    let localErr: any = null;

    try {
      const absPath = path.resolve(userPath);
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        throw new Error(`Attachment path "${userPath}" is not a regular file.`);
      }
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `Attachment "${userPath}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, ` +
          `which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB inline-attachment limit for Outlook.`,
        );
      }
      buf = await fs.readFile(absPath);
    } catch (err: any) {
      localErr = err;
    }

    if (!buf) {
      const shouldFallback =
        agentId &&
        runnerBridge &&
        localErr &&
        (localErr.code === 'ENOENT' || localErr.code === 'EACCES' || localErr.code === 'EPERM');
      if (shouldFallback) {
        try {
          buf = await readAttachmentViaRunner(runnerBridge!, agentId!, userPath);
        } catch (runnerErr: any) {
          throw new Error(`Cannot read attachment "${userPath}": ${runnerErr.message}`);
        }
      } else if (localErr) {
        throw new Error(`Cannot read attachment "${userPath}": ${localErr.message}`);
      }
    }

    const filename = att.filename || path.basename(userPath);
    const mimeType = att.mimeType || guessMimeType(filename);
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: filename,
      contentType: mimeType,
      contentBytes: buf!.toString('base64'),
    };
  }

  // hasContent
  if (!att.filename) {
    throw new Error('Attachment supplied via "content" must also include "filename".');
  }
  const cleanB64 = att.content!.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanB64)) {
    throw new Error(`Attachment "${att.filename}" content is not valid base64.`);
  }
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: att.filename,
    contentType: att.mimeType || guessMimeType(att.filename),
    contentBytes: cleanB64,
  };
}

const attachmentsSchema = z
  .array(
    z.object({
      path: z.string().optional().describe('Path to the file on the server filesystem. The MCP reads the file and base64-encodes it. Recommended way to attach files.'),
      filename: z.string().optional().describe('Display filename for the attachment, including extension. Defaults to the basename of "path" when not provided.'),
      mimeType: z.string().optional().describe('MIME type (e.g. "application/pdf"). Auto-detected from the extension when not provided.'),
      content: z.string().optional().describe('Optional base64-encoded content (alternative to "path"). Requires "filename".'),
    }),
  )
  .optional()
  .describe('Optional list of file attachments. Specify each via "path" (preferred — file is read from disk) or pre-encoded "content". Outlook inline-attachment limit ≈ 3 MB per file.');

function parseEmailList(value?: string): { emailAddress: { address: string } }[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(addr => ({ emailAddress: { address: addr } }));
}

function formatRecipients(list?: any[]): string {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list
    .map(r => {
      const e = r.emailAddress || r;
      const name = e?.name;
      const addr = e?.address || '';
      return name ? `${name} <${addr}>` : addr;
    })
    .filter(Boolean)
    .join(', ');
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBodyText(message: any): string {
  const body = message?.body;
  if (!body?.content) return '';
  return body.contentType === 'html' ? htmlToText(body.content) : body.content;
}

function formatMessageSummary(msg: any): string {
  const from = formatRecipients(msg.from ? [msg.from] : []) || 'Unknown';
  const subject = msg.subject || '(no subject)';
  const date = msg.receivedDateTime || msg.sentDateTime || '';
  const snippet = (msg.bodyPreview || '').trim();
  const flags = [];
  if (msg.isRead === false) flags.push('📩');
  if (msg.flag?.flagStatus === 'flagged') flags.push('⭐');
  if (msg.hasAttachments) flags.push('📎');
  return `${flags.join('') || '📧'} ${subject}\n   From: ${from}\n   Date: ${date}\n   ${snippet}\n   ID: ${msg.id}`;
}

/**
 * Create the Outlook MCP server with all tools registered.
 */
export function createOutlookMcpServer(
  agentId: string | null = null,
  boardId: string | null = null,
  runnerBridge: RunnerExecBridge | null = null,
) {
  const server = new McpServer({
    name: 'Outlook',
    version: '1.0.0',
  });

  // ── Tool: get_profile ────────────────────────────────────────────────
  server.tool(
    'get_profile',
    'Get the connected Outlook account profile (email address, display name).',
    {},
    async () => {
      const profile = await graphFetch('/me?$select=displayName,mail,userPrincipalName,id', agentId, boardId);
      return {
        content: [{
          type: 'text',
          text:
            `Outlook Profile:\n` +
            `Display Name: ${profile.displayName || ''}\n` +
            `Email: ${profile.mail || profile.userPrincipalName || ''}\n` +
            `User ID: ${profile.id || ''}`,
        }],
      };
    },
  );

  // ── Tool: list_emails ────────────────────────────────────────────────
  server.tool(
    'list_emails',
    'List recent emails from an Outlook mail folder (default: Inbox). Returns subject, sender, date, and preview.',
    {
      maxResults: z.number().optional().default(20).describe('Number of emails to return (default 20, max 100)'),
      folder: z.string().optional().default('inbox').describe('Mail folder ID or well-known name: inbox, sentitems, drafts, deleteditems, junkemail, archive. Default: inbox.'),
      query: z.string().optional().describe('Outlook search query (KQL-like, same as the Outlook search bar). E.g. "from:bob@example.com", "subject:meeting", "isread:false".'),
      onlyUnread: z.boolean().optional().default(false).describe('Filter to unread messages only.'),
    },
    async ({ maxResults, folder, query, onlyUnread }) => {
      const limit = Math.min(maxResults || 20, 100);
      const params = new URLSearchParams();
      params.set('$top', String(limit));
      params.set('$select', 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,flag');
      params.set('$orderby', 'receivedDateTime desc');
      if (onlyUnread) params.set('$filter', 'isRead eq false');
      if (query) params.set('$search', `"${query.replace(/"/g, '\\"')}"`);

      const folderPath = folder
        ? `/me/mailFolders/${encodeURIComponent(folder)}/messages`
        : `/me/messages`;
      const list = await graphFetch(`${folderPath}?${params}`, agentId, boardId);
      const messages: any[] = list.value || [];

      if (messages.length === 0) {
        return { content: [{ type: 'text', text: 'No emails found matching the criteria.' }] };
      }

      const summary = messages
        .map((m, i) => `${i + 1}. ${formatMessageSummary(m)}`)
        .join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${messages.length} email(s):\n\n${summary}`,
        }],
      };
    },
  );

  // ── Tool: search_emails ──────────────────────────────────────────────
  server.tool(
    'search_emails',
    'Search emails across the entire mailbox using Outlook/KQL search syntax (from:, to:, subject:, hasattachment:, received:, etc.).',
    {
      query: z.string().describe('Outlook search query (e.g. "from:alice subject:report received:2024-01-01..2024-12-31")'),
      maxResults: z.number().optional().default(20).describe('Max results (default 20, max 100)'),
    },
    async ({ query, maxResults }) => {
      const limit = Math.min(maxResults || 20, 100);
      const params = new URLSearchParams();
      params.set('$top', String(limit));
      params.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments');
      params.set('$search', `"${query.replace(/"/g, '\\"')}"`);

      const list = await graphFetch(`/me/messages?${params}`, agentId, boardId);
      const messages: any[] = list.value || [];

      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `No emails found for query: "${query}"` }] };
      }

      const summary = messages
        .map((m, i) => `${i + 1}. ${formatMessageSummary(m)}`)
        .join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Search "${query}" found ${messages.length} result(s):\n\n${summary}`,
        }],
      };
    },
  );

  // ── Tool: read_email ─────────────────────────────────────────────────
  server.tool(
    'read_email',
    'Read the full content of a specific email by its ID. Returns headers, body text, and attachment info.',
    {
      messageId: z.string().describe('The Outlook message ID (returned by list_emails or search_emails).'),
    },
    async ({ messageId }) => {
      const params = new URLSearchParams();
      params.set('$select', 'id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,isRead,hasAttachments,importance,internetMessageId');
      const msg = await graphFetch(`/me/messages/${encodeURIComponent(messageId)}?${params}`, agentId, boardId);

      const from = formatRecipients(msg.from ? [msg.from] : []) || 'Unknown';
      const to = formatRecipients(msg.toRecipients) || '';
      const cc = formatRecipients(msg.ccRecipients) || '';
      const bcc = formatRecipients(msg.bccRecipients) || '';
      const subject = msg.subject || '(no subject)';
      const date = msg.receivedDateTime || msg.sentDateTime || '';
      const body = extractBodyText(msg);

      let attachInfo = '';
      if (msg.hasAttachments) {
        const attachList = await graphFetch(
          `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`,
          agentId,
          boardId,
        );
        const attachments: any[] = attachList.value || [];
        if (attachments.length > 0) {
          attachInfo =
            `\n\nAttachments (${attachments.length}):\n` +
            attachments
              .map(a => `  - ${a.name} (${a.contentType}, ${((a.size || 0) / 1024).toFixed(1)} KB, ID: ${a.id})`)
              .join('\n');
        }
      }

      return {
        content: [{
          type: 'text',
          text:
            `From: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}${bcc ? `\nBcc: ${bcc}` : ''}\n` +
            `Subject: ${subject}\nDate: ${date}\nImportance: ${msg.importance || 'normal'}\n` +
            `Message-ID: ${msg.internetMessageId || ''}\nConversation ID: ${msg.conversationId || ''}\n` +
            `Read: ${msg.isRead ? 'yes' : 'no'}\n\n` +
            `--- Body ---\n${body}${attachInfo}`,
        }],
      };
    },
  );

  // ── Tool: send_email ─────────────────────────────────────────────────
  server.tool(
    'send_email',
    'Send a new email via Outlook. Optional file attachments can be passed by disk path ("path") or as pre-encoded base64 ("content").',
    {
      to: z.string().describe('Recipient email address(es), comma-separated'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipient(s), comma-separated'),
      bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
      attachments: attachmentsSchema,
    },
    async ({ to, subject, body, cc, bcc, attachments }) => {
      const resolved = attachments
        ? await Promise.all(attachments.map(a => resolveAttachment(a, agentId, runnerBridge)))
        : undefined;

      const message: any = {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: parseEmailList(to) || [],
      };
      const ccList = parseEmailList(cc);
      if (ccList) message.ccRecipients = ccList;
      const bccList = parseEmailList(bcc);
      if (bccList) message.bccRecipients = bccList;
      if (resolved && resolved.length > 0) message.attachments = resolved;

      await graphFetch('/me/sendMail', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({ message, saveToSentItems: true }),
      });

      const attachInfo = resolved && resolved.length > 0
        ? `\nAttachments: ${resolved.map(a => a.name).join(', ')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Email sent successfully!\nTo: ${to}\nSubject: ${subject}${attachInfo}`,
        }],
      };
    },
  );

  // ── Tool: reply_to_email ─────────────────────────────────────────────
  server.tool(
    'reply_to_email',
    'Reply to an existing email. Maintains the conversation thread. Optional file attachments can be passed by disk path ("path") or as pre-encoded base64 ("content").',
    {
      messageId: z.string().describe('The Outlook message ID to reply to'),
      body: z.string().describe('Reply body (plain text)'),
      replyAll: z.boolean().optional().default(false).describe('If true, reply to all recipients (default: false)'),
      attachments: attachmentsSchema,
    },
    async ({ messageId, body, replyAll, attachments }) => {
      const resolved = attachments
        ? await Promise.all(attachments.map(a => resolveAttachment(a, agentId, runnerBridge)))
        : undefined;

      // Build the reply payload — Microsoft Graph supports inline body via the
      // `comment` field; for attachments we need to createReply first, then
      // attach, then send.
      const action = replyAll ? 'createReplyAll' : 'createReply';
      const draft = await graphFetch(
        `/me/messages/${encodeURIComponent(messageId)}/${action}`,
        agentId,
        boardId,
        {
          method: 'POST',
          body: JSON.stringify({
            comment: body,
          }),
        },
      );

      const draftId = draft?.id;
      if (!draftId) {
        throw new Error('Outlook did not return a draft id for the reply.');
      }

      if (resolved && resolved.length > 0) {
        for (const att of resolved) {
          await graphFetch(
            `/me/messages/${encodeURIComponent(draftId)}/attachments`,
            agentId,
            boardId,
            {
              method: 'POST',
              body: JSON.stringify(att),
            },
          );
        }
      }

      await graphFetch(`/me/messages/${encodeURIComponent(draftId)}/send`, agentId, boardId, {
        method: 'POST',
      });

      const attachInfo = resolved && resolved.length > 0
        ? `\nAttachments: ${resolved.map(a => a.name).join(', ')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Reply sent successfully!\nDraft ID: ${draftId}\nIn-reply-to: ${messageId}${attachInfo}`,
        }],
      };
    },
  );

  // ── Tool: create_draft ───────────────────────────────────────────────
  server.tool(
    'create_draft',
    'Create a draft email in Outlook (without sending it). Optional file attachments can be passed by disk path ("path") or as pre-encoded base64 ("content").',
    {
      to: z.string().describe('Recipient email address(es), comma-separated'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipient(s), comma-separated'),
      bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
      attachments: attachmentsSchema,
    },
    async ({ to, subject, body, cc, bcc, attachments }) => {
      const resolved = attachments
        ? await Promise.all(attachments.map(a => resolveAttachment(a, agentId, runnerBridge)))
        : undefined;

      const payload: any = {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: parseEmailList(to) || [],
      };
      const ccList = parseEmailList(cc);
      if (ccList) payload.ccRecipients = ccList;
      const bccList = parseEmailList(bcc);
      if (bccList) payload.bccRecipients = bccList;
      if (resolved && resolved.length > 0) payload.attachments = resolved;

      const draft = await graphFetch('/me/messages', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const attachInfo = resolved && resolved.length > 0
        ? `\nAttachments: ${resolved.map(a => a.name).join(', ')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Draft created successfully!\nDraft ID: ${draft.id}\nTo: ${to}\nSubject: ${subject}${attachInfo}`,
        }],
      };
    },
  );

  // ── Tool: list_folders ───────────────────────────────────────────────
  server.tool(
    'list_folders',
    'List all top-level Outlook mail folders (Inbox, Sent Items, Drafts, custom folders, etc.).',
    {},
    async () => {
      const data = await graphFetch('/me/mailFolders?$top=100', agentId, boardId);
      const folders: any[] = data.value || [];

      const format = (f: any) =>
        `  - ${f.displayName} (ID: ${f.id}, total: ${f.totalItemCount}, unread: ${f.unreadItemCount})`;

      return {
        content: [{
          type: 'text',
          text:
            `Outlook Folders (${folders.length} total):\n\n` +
            (folders.length > 0 ? folders.map(format).join('\n') : '  (none)'),
        }],
      };
    },
  );

  // ── Tool: mark_read ──────────────────────────────────────────────────
  server.tool(
    'mark_read',
    'Mark an email as read or unread. Use this to manage inbox state.',
    {
      messageId: z.string().describe('The Outlook message ID'),
      isRead: z.boolean().describe('true = mark as read, false = mark as unread'),
    },
    async ({ messageId, isRead }) => {
      await graphFetch(`/me/messages/${encodeURIComponent(messageId)}`, agentId, boardId, {
        method: 'PATCH',
        body: JSON.stringify({ isRead }),
      });
      return {
        content: [{
          type: 'text',
          text: `Email ${messageId} marked as ${isRead ? 'read' : 'unread'}.`,
        }],
      };
    },
  );

  // ── Tool: flag_email ─────────────────────────────────────────────────
  server.tool(
    'flag_email',
    'Flag or unflag (star/unstar) an email.',
    {
      messageId: z.string().describe('The Outlook message ID'),
      flagged: z.boolean().describe('true = flag (star), false = clear the flag'),
    },
    async ({ messageId, flagged }) => {
      await graphFetch(`/me/messages/${encodeURIComponent(messageId)}`, agentId, boardId, {
        method: 'PATCH',
        body: JSON.stringify({
          flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
        }),
      });
      return {
        content: [{
          type: 'text',
          text: `Email ${messageId} ${flagged ? 'flagged' : 'unflagged'}.`,
        }],
      };
    },
  );

  // ── Tool: move_email ─────────────────────────────────────────────────
  server.tool(
    'move_email',
    'Move an email to another folder (e.g. archive, deleteditems, or a custom folder ID).',
    {
      messageId: z.string().describe('The Outlook message ID'),
      destinationFolder: z.string().describe('Destination folder: well-known name (archive, deleteditems, junkemail, inbox) or a folder ID.'),
    },
    async ({ messageId, destinationFolder }) => {
      const result = await graphFetch(
        `/me/messages/${encodeURIComponent(messageId)}/move`,
        agentId,
        boardId,
        {
          method: 'POST',
          body: JSON.stringify({ destinationId: destinationFolder }),
        },
      );
      return {
        content: [{
          type: 'text',
          text: `Email moved to "${destinationFolder}". New message ID: ${result?.id || '(unchanged)'}.`,
        }],
      };
    },
  );

  // ── Tool: trash_email ────────────────────────────────────────────────
  server.tool(
    'trash_email',
    'Move an email to the Deleted Items folder.',
    {
      messageId: z.string().describe('The Outlook message ID to trash'),
    },
    async ({ messageId }) => {
      await graphFetch(`/me/messages/${encodeURIComponent(messageId)}/move`, agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({ destinationId: 'deleteditems' }),
      });
      return {
        content: [{ type: 'text', text: `Email ${messageId} moved to Deleted Items.` }],
      };
    },
  );

  // ── Tool: download_attachment ────────────────────────────────────────
  server.tool(
    'download_attachment',
    'Download an attachment from an email. Returns the attachment content as base64. Use read_email first to find the attachmentId.',
    {
      messageId: z.string().describe('The Outlook message ID containing the attachment'),
      attachmentId: z.string().describe('The attachment ID (returned by read_email)'),
    },
    async ({ messageId, attachmentId }) => {
      const att = await graphFetch(
        `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        agentId,
        boardId,
      );

      const name = att?.name || 'attachment';
      const size = att?.size || 0;
      const contentBytes = att?.contentBytes || '';

      return {
        content: [{
          type: 'text',
          text: `Attachment downloaded (${name}).\nSize: ${(size / 1024).toFixed(1)} KB\nContent-Type: ${att?.contentType || 'application/octet-stream'}\n\nBase64 content:\n${contentBytes}`,
        }],
      };
    },
  );

  // ── Tool: get_conversation ───────────────────────────────────────────
  server.tool(
    'get_conversation',
    'Get all messages in an Outlook conversation thread. Useful for reading entire email conversations.',
    {
      conversationId: z.string().describe('The Outlook conversation ID (returned in message details)'),
      maxResults: z.number().optional().default(50).describe('Max messages to return (default 50, max 200)'),
    },
    async ({ conversationId, maxResults }) => {
      const limit = Math.min(maxResults || 50, 200);
      const params = new URLSearchParams();
      params.set('$top', String(limit));
      params.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,body');
      params.set('$orderby', 'receivedDateTime asc');
      params.set('$filter', `conversationId eq '${conversationId.replace(/'/g, "''")}'`);

      const list = await graphFetch(`/me/messages?${params}`, agentId, boardId);
      const messages: any[] = list.value || [];

      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `No messages found for conversation: ${conversationId}` }] };
      }

      const formatted = messages.map((m, i) => {
        const from = formatRecipients(m.from ? [m.from] : []) || 'Unknown';
        const date = m.receivedDateTime || '';
        const text = extractBodyText(m);
        const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;
        return `--- Message ${i + 1}/${messages.length} (ID: ${m.id}) ---\nFrom: ${from}\nDate: ${date}\n\n${preview}`;
      });

      const subject = messages[0]?.subject || '(no subject)';

      return {
        content: [{
          type: 'text',
          text: `Conversation: ${subject}\nConversation ID: ${conversationId}\nMessages: ${messages.length}\n\n${formatted.join('\n\n')}`,
        }],
      };
    },
  );

  return server;
}

/**
 * Express handler for the Outlook MCP endpoint.
 * Reads X-Agent-Id / X-Board-Id headers for token resolution.
 */
export function createOutlookMcpHandler(runnerBridge: RunnerExecBridge | null = null) {
  return async (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const agentId = req.headers['x-agent-id'] || null;
      const boardId = req.headers['x-board-id'] || null;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createOutlookMcpServer(agentId, boardId, runnerBridge);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('[Outlook MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
