import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getGmailAccessTokenForAgent } from '../routes/gmail.js';

const GMAIL_BASE = 'https://www.googleapis.com/gmail/v1';

/**
 * Helper to call Gmail API with auto-refreshing tokens.
 * Uses agent-specific tokens when agentId is provided.
 */
async function gmailFetch(path: string, agentId: string | null = null, boardId: string | null = null, options: Record<string, any> = {}) {
  const token = await getGmailAccessTokenForAgent(agentId, boardId);
  const url = path.startsWith('http') ? path : `${GMAIL_BASE}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

/**
 * Decode base64url encoded content (used by Gmail API).
 */
function decodeBase64Url(str) {
  if (!str) return '';
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Encode content to base64url (used for sending emails).
 */
function encodeBase64Url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Extract header value from a Gmail message.
 */
function getHeader(headers, name) {
  const header = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : null;
}

/**
 * Extract readable text from a Gmail message payload.
 */
function extractBody(payload) {
  if (!payload) return '';

  // Simple body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — look for text/plain first, then text/html
  if (payload.parts) {
    // Try text/plain
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }

    // Try text/html
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = decodeBase64Url(htmlPart.body.data);
      // Strip HTML tags for a readable text version
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

/**
 * Format a Gmail message for display.
 */
function formatMessage(msg) {
  const headers = msg.payload?.headers || [];
  const from = getHeader(headers, 'From') || 'Unknown';
  const to = getHeader(headers, 'To') || '';
  const cc = getHeader(headers, 'Cc') || '';
  const subject = getHeader(headers, 'Subject') || '(no subject)';
  const date = getHeader(headers, 'Date') || '';

  const labels = msg.labelIds || [];
  const isUnread = labels.includes('UNREAD');
  const isStarred = labels.includes('STARRED');
  const snippet = msg.snippet || '';

  return {
    id: msg.id,
    threadId: msg.threadId,
    from,
    to,
    cc,
    subject,
    date,
    snippet,
    labels,
    isUnread,
    isStarred,
  };
}

/**
 * Attachment shape accepted by buildRawEmail.
 * `content` must be base64-encoded (standard base64, not base64url).
 */
type EmailAttachment = {
  filename: string;
  mimeType?: string;
  content: string;
};

/**
 * Encode a header value with RFC 2047 if it contains non-ASCII characters.
 * Needed for filenames in attachments and subject lines with unicode.
 */
function encodeHeaderIfNeeded(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

/**
 * Split a base64 string into 76-character lines (MIME requirement).
 */
function chunkBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

/**
 * Build an RFC 2822 email message for sending via Gmail API.
 * When attachments are provided, builds a multipart/mixed message;
 * otherwise builds a plain text/plain message (backwards compatible).
 */
function buildRawEmail({
  to,
  cc,
  bcc,
  subject,
  body,
  inReplyTo,
  references,
  attachments,
}: {
  to: any;
  cc?: any;
  bcc?: any;
  subject: any;
  body: any;
  inReplyTo?: any;
  references?: any;
  attachments?: EmailAttachment[];
}) {
  const headers: string[] = [];
  headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeaderIfNeeded(String(subject))}`);
  headers.push('MIME-Version: 1.0');
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${references || inReplyTo}`);
  }

  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  if (!hasAttachments) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('');
    headers.push(body);
    return encodeBase64Url(headers.join('\r\n'));
  }

  // Multipart message with attachments.
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  headers.push('');
  headers.push('This is a multi-part message in MIME format.');

  const parts: string[] = [];

  // Body part
  parts.push(
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      body,
    ].join('\r\n')
  );

  // Attachment parts
  for (const att of attachments!) {
    if (!att || !att.filename || typeof att.content !== 'string') {
      throw new Error('Each attachment must have a filename and base64-encoded content.');
    }
    const mime = att.mimeType || 'application/octet-stream';
    const encodedFilename = encodeHeaderIfNeeded(att.filename);
    // Normalize content: strip whitespace/newlines, validate, then chunk.
    const cleanB64 = att.content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanB64)) {
      throw new Error(`Attachment "${att.filename}" content is not valid base64.`);
    }
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${mime}; name="${encodedFilename}"`,
        `Content-Disposition: attachment; filename="${encodedFilename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        chunkBase64(cleanB64),
      ].join('\r\n')
    );
  }

  parts.push(`--${boundary}--`);

  return encodeBase64Url(headers.join('\r\n') + '\r\n' + parts.join('\r\n') + '\r\n');
}

/**
 * Zod schema for the `attachments` tool parameter.
 */
const attachmentsSchema = z
  .array(
    z.object({
      filename: z.string().describe('Filename of the attachment, including extension (e.g. "report.pdf")'),
      mimeType: z.string().optional().describe('MIME type (e.g. "application/pdf", "image/png"). Defaults to "application/octet-stream".'),
      content: z.string().describe('File content encoded as base64 (standard base64, not base64url). Whitespace is allowed and will be stripped.'),
    })
  )
  .optional()
  .describe('Optional list of file attachments. Each attachment must include filename and base64-encoded content.');

/**
 * Create the Gmail MCP server with all tools registered.
 * @param {string|null} agentId - When provided, tools use agent-specific tokens.
 */
export function createGmailMcpServer(agentId = null, boardId = null) {
  const server = new McpServer({
    name: 'Gmail',
    version: '1.0.0',
  });

  // ── Tool: get_profile ────────────────────────────────────────────────
  server.tool(
    'get_profile',
    'Get the connected Gmail account profile (email address, total messages, etc.).',
    {},
    async () => {
      const profile = await gmailFetch('/users/me/profile', agentId, boardId);
      return {
        content: [{
          type: 'text',
          text: `Gmail Profile:\n` +
            `Email: ${profile.emailAddress}\n` +
            `Total messages: ${profile.messagesTotal}\n` +
            `Total threads: ${profile.threadsTotal}\n` +
            `History ID: ${profile.historyId}`
        }],
      };
    }
  );

  // ── Tool: list_emails ────────────────────────────────────────────────
  server.tool(
    'list_emails',
    'List recent emails from Gmail inbox. Returns subject, sender, date, and snippet.',
    {
      maxResults: z.number().optional().default(20).describe('Number of emails to return (default 20, max 100)'),
      labelIds: z.string().optional().default('INBOX').describe('Comma-separated label IDs to filter (default: INBOX). Use INBOX, SENT, DRAFT, STARRED, UNREAD, etc.'),
      query: z.string().optional().describe('Gmail search query (same syntax as Gmail search bar). E.g. "is:unread", "from:bob@example.com", "subject:meeting"'),
    },
    async ({ maxResults, labelIds, query }) => {
      const limit = Math.min(maxResults || 20, 100);
      const params = new URLSearchParams({ maxResults: String(limit) });

      if (labelIds) {
        for (const label of labelIds.split(',').map(l => l.trim())) {
          params.append('labelIds', label);
        }
      }
      if (query) {
        params.set('q', query);
      }

      const list = await gmailFetch(`/users/me/messages?${params}`, agentId, boardId);
      const messages = list.messages || [];

      if (messages.length === 0) {
        return { content: [{ type: 'text', text: 'No emails found matching the criteria.' }] };
      }

      // Fetch details for each message (headers + snippet)
      const details = await Promise.all(
        messages.slice(0, limit).map(m =>
          gmailFetch(`/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, agentId, boardId)
        )
      );

      const formatted = details.map(formatMessage);
      const summary = formatted.map((m, i) => {
        const unread = m.isUnread ? '📩' : '📧';
        const star = m.isStarred ? '⭐' : '';
        return `${i + 1}. ${unread}${star} ${m.subject}\n   From: ${m.from}\n   Date: ${m.date}\n   ${m.snippet}\n   ID: ${m.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${list.resultSizeEstimate || messages.length} email(s):\n\n${summary}`
        }],
      };
    }
  );

  // ── Tool: search_emails ──────────────────────────────────────────────
  server.tool(
    'search_emails',
    'Search emails using Gmail search syntax. Supports all Gmail operators: from:, to:, subject:, has:, is:, after:, before:, etc.',
    {
      query: z.string().describe('Gmail search query (e.g. "from:alice subject:report after:2024/01/01")'),
      maxResults: z.number().optional().default(20).describe('Max results (default 20, max 100)'),
    },
    async ({ query, maxResults }) => {
      const limit = Math.min(maxResults || 20, 100);
      const params = new URLSearchParams({
        q: query,
        maxResults: String(limit),
      });

      const list = await gmailFetch(`/users/me/messages?${params}`, agentId, boardId);
      const messages = list.messages || [];

      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `No emails found for query: "${query}"` }] };
      }

      const details = await Promise.all(
        messages.slice(0, limit).map(m =>
          gmailFetch(`/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, agentId, boardId)
        )
      );

      const formatted = details.map(formatMessage);
      const summary = formatted.map((m, i) => {
        const unread = m.isUnread ? '📩' : '📧';
        return `${i + 1}. ${unread} ${m.subject}\n   From: ${m.from}\n   Date: ${m.date}\n   ${m.snippet}\n   ID: ${m.id}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Search "${query}" found ${list.resultSizeEstimate || messages.length} result(s):\n\n${summary}`
        }],
      };
    }
  );

  // ── Tool: read_email ─────────────────────────────────────────────────
  server.tool(
    'read_email',
    'Read the full content of a specific email by its ID. Returns headers, body text, and attachment info.',
    {
      messageId: z.string().describe('The Gmail message ID (returned by list_emails or search_emails)'),
    },
    async ({ messageId }) => {
      const msg = await gmailFetch(`/users/me/messages/${messageId}?format=full`, agentId, boardId);
      const headers = msg.payload?.headers || [];
      const from = getHeader(headers, 'From') || 'Unknown';
      const to = getHeader(headers, 'To') || '';
      const cc = getHeader(headers, 'Cc') || '';
      const subject = getHeader(headers, 'Subject') || '(no subject)';
      const date = getHeader(headers, 'Date') || '';
      const messageIdHeader = getHeader(headers, 'Message-ID') || '';

      const body = extractBody(msg.payload);

      // List attachments
      const attachments = [];
      function findAttachments(parts) {
        for (const part of parts || []) {
          if (part.filename && part.body?.attachmentId) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType,
              size: part.body.size,
              attachmentId: part.body.attachmentId,
            });
          }
          if (part.parts) findAttachments(part.parts);
        }
      }
      findAttachments(msg.payload?.parts);

      const attachInfo = attachments.length > 0
        ? `\n\nAttachments (${attachments.length}):\n${attachments.map(a => `  - ${a.filename} (${a.mimeType}, ${(a.size / 1024).toFixed(1)} KB)`).join('\n')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `From: ${from}\nTo: ${to}${cc ? `\nCc: ${cc}` : ''}\nSubject: ${subject}\nDate: ${date}\nMessage-ID: ${messageIdHeader}\nLabels: ${(msg.labelIds || []).join(', ')}\n\n--- Body ---\n${body}${attachInfo}`
        }],
      };
    }
  );

  // ── Tool: send_email ─────────────────────────────────────────────────
  server.tool(
    'send_email',
    'Send a new email via Gmail. Supports optional file attachments (base64-encoded).',
    {
      to: z.string().describe('Recipient email address(es), comma-separated'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipient(s), comma-separated'),
      bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
      attachments: attachmentsSchema,
    },
    async ({ to, subject, body, cc, bcc, attachments }) => {
      const raw = buildRawEmail({ to, cc, bcc, subject, body, attachments });

      const result = await gmailFetch('/users/me/messages/send', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({ raw }),
      });

      const attachInfo = attachments && attachments.length > 0
        ? `\nAttachments: ${attachments.map(a => a.filename).join(', ')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Email sent successfully!\nMessage ID: ${result.id}\nThread ID: ${result.threadId}\nTo: ${to}\nSubject: ${subject}${attachInfo}`
        }],
      };
    }
  );

  // ── Tool: reply_to_email ─────────────────────────────────────────────
  server.tool(
    'reply_to_email',
    'Reply to an existing email. Maintains the conversation thread. Supports optional file attachments (base64-encoded).',
    {
      messageId: z.string().describe('The Gmail message ID to reply to'),
      body: z.string().describe('Reply body (plain text)'),
      replyAll: z.boolean().optional().default(false).describe('If true, reply to all recipients (default: false)'),
      attachments: attachmentsSchema,
    },
    async ({ messageId, body, replyAll, attachments }) => {
      // Get the original message to extract headers
      const original = await gmailFetch(`/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`, agentId, boardId);
      const headers = original.payload?.headers || [];

      const from = getHeader(headers, 'From') || '';
      const to = getHeader(headers, 'To') || '';
      const cc = getHeader(headers, 'Cc') || '';
      const subject = getHeader(headers, 'Subject') || '';
      const originalMessageId = getHeader(headers, 'Message-ID') || '';
      const references = getHeader(headers, 'References') || '';

      // Reply goes to the original sender
      let replyTo = from;
      let replyCc = '';
      if (replyAll) {
        // Include original To and Cc, excluding ourselves
        replyCc = [to, cc].filter(Boolean).join(', ');
      }

      const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
      const raw = buildRawEmail({
        to: replyTo,
        cc: replyCc || undefined,
        subject: replySubject,
        body,
        inReplyTo: originalMessageId,
        references: references ? `${references} ${originalMessageId}` : originalMessageId,
        attachments,
      });

      const result = await gmailFetch('/users/me/messages/send', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({
          raw,
          threadId: original.threadId,
        }),
      });

      const attachInfo = attachments && attachments.length > 0
        ? `\nAttachments: ${attachments.map(a => a.filename).join(', ')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Reply sent successfully!\nMessage ID: ${result.id}\nThread ID: ${result.threadId}\nTo: ${replyTo}\nSubject: ${replySubject}${attachInfo}`
        }],
      };
    }
  );

  // ── Tool: create_draft ───────────────────────────────────────────────
  server.tool(
    'create_draft',
    'Create a draft email in Gmail (without sending it). Supports optional file attachments (base64-encoded).',
    {
      to: z.string().describe('Recipient email address(es), comma-separated'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipient(s), comma-separated'),
      bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
      attachments: attachmentsSchema,
    },
    async ({ to, subject, body, cc, bcc, attachments }) => {
      const raw = buildRawEmail({ to, cc, bcc, subject, body, attachments });

      const result = await gmailFetch('/users/me/drafts', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({
          message: { raw },
        }),
      });

      const attachInfo = attachments && attachments.length > 0
        ? `\nAttachments: ${attachments.map(a => a.filename).join(', ')}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `Draft created successfully!\nDraft ID: ${result.id}\nMessage ID: ${result.message?.id}\nTo: ${to}\nSubject: ${subject}${attachInfo}`
        }],
      };
    }
  );

  // ── Tool: list_labels ────────────────────────────────────────────────
  server.tool(
    'list_labels',
    'List all Gmail labels (folders/categories) in the account.',
    {},
    async () => {
      const data = await gmailFetch('/users/me/labels', agentId, boardId);
      const labels = data.labels || [];

      const system = labels.filter(l => l.type === 'system');
      const user = labels.filter(l => l.type === 'user');

      const format = (l) => `  - ${l.name} (ID: ${l.id})`;

      return {
        content: [{
          type: 'text',
          text: `Gmail Labels (${labels.length} total):\n\n` +
            `System Labels (${system.length}):\n${system.map(format).join('\n')}\n\n` +
            `User Labels (${user.length}):\n${user.length > 0 ? user.map(format).join('\n') : '  (none)'}`
        }],
      };
    }
  );

  // ── Tool: modify_labels ──────────────────────────────────────────────
  server.tool(
    'modify_labels',
    'Add or remove labels from an email. Use this to mark as read/unread, star/unstar, archive, move to trash, etc.',
    {
      messageId: z.string().describe('The Gmail message ID'),
      addLabelIds: z.string().optional().describe('Comma-separated label IDs to add (e.g. "STARRED,IMPORTANT")'),
      removeLabelIds: z.string().optional().describe('Comma-separated label IDs to remove (e.g. "UNREAD,INBOX")'),
    },
    async ({ messageId, addLabelIds, removeLabelIds }) => {
      const addIds = addLabelIds ? addLabelIds.split(',').map(l => l.trim()) : [];
      const removeIds = removeLabelIds ? removeLabelIds.split(',').map(l => l.trim()) : [];

      if (addIds.length === 0 && removeIds.length === 0) {
        return { content: [{ type: 'text', text: 'No label changes specified.' }] };
      }

      const result = await gmailFetch(`/users/me/messages/${messageId}/modify`, agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({
          addLabelIds: addIds,
          removeLabelIds: removeIds,
        }),
      });

      const changes = [];
      if (addIds.length > 0) changes.push(`Added: ${addIds.join(', ')}`);
      if (removeIds.length > 0) changes.push(`Removed: ${removeIds.join(', ')}`);

      return {
        content: [{
          type: 'text',
          text: `Labels modified for message ${messageId}:\n${changes.join('\n')}\nCurrent labels: ${(result.labelIds || []).join(', ')}`
        }],
      };
    }
  );

  // ── Tool: trash_email ────────────────────────────────────────────────
  server.tool(
    'trash_email',
    'Move an email to the trash.',
    {
      messageId: z.string().describe('The Gmail message ID to trash'),
    },
    async ({ messageId }) => {
      await gmailFetch(`/users/me/messages/${messageId}/trash`, agentId, boardId, {
        method: 'POST',
      });

      return {
        content: [{ type: 'text', text: `Email ${messageId} moved to trash.` }],
      };
    }
  );

  // ── Tool: download_attachment ────────────────────────────────────────
  server.tool(
    'download_attachment',
    'Download an attachment from an email. Returns the attachment content as base64. Use list/read_email first to find the attachmentId.',
    {
      messageId: z.string().describe('The Gmail message ID containing the attachment'),
      attachmentId: z.string().describe('The attachment ID (returned by read_email)'),
      filename: z.string().optional().describe('Original filename (for display only)'),
    },
    async ({ messageId, attachmentId, filename }) => {
      const data = await gmailFetch(
        `/users/me/messages/${messageId}/attachments/${attachmentId}`,
        agentId,
        boardId
      );

      // Gmail returns base64url-encoded data; convert to standard base64.
      const b64url = data.data || '';
      const standardB64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const size = data.size || 0;

      return {
        content: [{
          type: 'text',
          text: `Attachment downloaded${filename ? ` (${filename})` : ''}.\nSize: ${(size / 1024).toFixed(1)} KB\n\nBase64 content:\n${standardB64}`
        }],
      };
    }
  );

  // ── Tool: get_thread ─────────────────────────────────────────────────
  server.tool(
    'get_thread',
    'Get all messages in a conversation thread. Useful for reading entire email conversations.',
    {
      threadId: z.string().describe('The Gmail thread ID (returned in message details)'),
    },
    async ({ threadId }) => {
      const thread = await gmailFetch(`/users/me/threads/${threadId}?format=full`, agentId, boardId);
      const messages = thread.messages || [];

      const formatted = messages.map((msg, i) => {
        const headers = msg.payload?.headers || [];
        const from = getHeader(headers, 'From') || 'Unknown';
        const date = getHeader(headers, 'Date') || '';
        const body = extractBody(msg.payload);
        const bodyPreview = body.length > 500 ? body.slice(0, 500) + '...' : body;

        return `--- Message ${i + 1}/${messages.length} (ID: ${msg.id}) ---\nFrom: ${from}\nDate: ${date}\n\n${bodyPreview}`;
      });

      const subject = getHeader(messages[0]?.payload?.headers || [], 'Subject') || '(no subject)';

      return {
        content: [{
          type: 'text',
          text: `Thread: ${subject}\nThread ID: ${threadId}\nMessages: ${messages.length}\n\n${formatted.join('\n\n')}`
        }],
      };
    }
  );

  return server;
}

/**
 * Create an Express handler for the Gmail MCP endpoint.
 * This bridges HTTP requests to the MCP server.
 * Reads X-Agent-Id header to provide agent-specific token resolution.
 */
export function createGmailMcpHandler() {
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
      const server = createGmailMcpServer(agentId, boardId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[Gmail MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
