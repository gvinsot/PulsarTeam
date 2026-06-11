import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getGmailAccessTokenForAgent } from '../routes/gmail.js';

/**
 * Minimal interface for the runner-service bridge used to read attachment
 * files from an agent's container when the file is not present on the API
 * container filesystem (which is the common case — agents live in separate
 * containers with their own volumes).
 */
type RunnerExecBridge = {
  exec: (
    agentId: string,
    command: string,
    options?: { cwd?: string; timeout?: number; maxOutput?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
};

const GMAIL_BASE = 'https://www.googleapis.com/gmail/v1';

// Gmail's API limit is 25 MB total per message (incl. encoding overhead).
// Keep per-attachment limit slightly below that to leave headroom for the body
// and base64 overhead (~33%).
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Minimal extension → MIME type map for common attachment types.
 * Falls back to application/octet-stream when unknown.
 */
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
 * Helper to call Gmail API with auto-refreshing tokens.
 * Uses agent-specific tokens when agentId is provided.
 */
async function gmailFetch(path: string, agentId: string | null = null, boardId: string | null = null, options: Record<string, any> = {}) {
  const token = await getGmailAccessTokenForAgent(agentId, boardId);
  const url = path.startsWith('http') ? path : `${GMAIL_BASE}${path}`;

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
 * Attachment shape accepted by buildRawEmail (after resolution).
 * `content` is base64-encoded (standard base64, not base64url).
 */
type EmailAttachment = {
  filename: string;
  mimeType?: string;
  content: string;
};

/**
 * Attachment shape accepted by the MCP tools (before resolution).
 * Either `path` (file on disk, read by the MCP) or `content` (pre-encoded
 * base64) must be provided.
 */
type AttachmentInput = {
  path?: string;
  filename?: string;
  mimeType?: string;
  content?: string;
};

/** Shell-quote a string for safe inclusion in a bash command. */
function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Read a file from the agent's runner-service container via /exec-shell.
 *
 * The Gmail MCP runs in the API container, so file paths supplied by an
 * agent (which live in a separate runner container with its own volumes
 * and per-agent UID isolation) are not accessible via local fs. We delegate
 * the read to the runner-service, which executes under the agent's UID and
 * therefore enforces cross-agent isolation automatically.
 */
async function readAttachmentViaRunner(
  bridge: RunnerExecBridge,
  agentId: string,
  filePath: string,
): Promise<Buffer> {
  // Probe size and file type first so we can fail fast with a useful message
  // before transferring potentially large base64 payloads.
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
      `which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`
    );
  }

  // A 20 MB binary attachment expands to ~27 MB once base64-encoded; request
  // the server-side hard cap (32 MiB) so the runner does not silently truncate
  // the output. The previous default of 10 000 chars caused attachments to be
  // cut to ~7.3 KB after decoding.
  const res = await bridge.exec(
    agentId,
    `base64 -w0 ${shQuote(filePath)}`,
    { timeout: 120000, maxOutput: 32 * 1024 * 1024 },
  );
  const b64 = (res.stdout || '').replace(/\s+/g, '');
  if (!b64) {
    throw new Error(`Empty content reading "${filePath}" via runner: ${res.stderr || 'no output'}`);
  }
  const buf = Buffer.from(b64, 'base64');
  // Defence-in-depth: if the runner output were ever truncated again, the
  // decoded size would no longer match the size we probed via stat. Surface
  // that as a hard error rather than silently sending a corrupted attachment.
  if (buf.length !== size) {
    throw new Error(
      `Attachment "${filePath}" was truncated during transfer ` +
      `(expected ${size} bytes, got ${buf.length}).`,
    );
  }
  return buf;
}

/**
 * Resolve a user-provided attachment input into the form expected by
 * buildRawEmail: read from disk when `path` is supplied, infer filename and
 * MIME type from the path when not explicitly provided, and validate size.
 *
 * Reads happen in two tiers:
 *   1. Try the API container's local filesystem (legacy / dev convenience).
 *   2. If the file isn't on the API container (ENOENT/EACCES) and an agent
 *      context is available, fall back to reading via the agent's runner
 *      container. This is the normal path in production: agent workspaces
 *      live in the runner-service container, not in the API container.
 */
async function resolveAttachment(
  att: AttachmentInput,
  agentId: string | null = null,
  runnerBridge: RunnerExecBridge | null = null,
): Promise<EmailAttachment> {
  if (!att || (typeof att !== 'object')) {
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

    // Tier 1: try local filesystem on the API container.
    try {
      const absPath = path.resolve(userPath);
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        throw new Error(`Attachment path "${userPath}" is not a regular file.`);
      }
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `Attachment "${userPath}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, ` +
          `which exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`
        );
      }
      buf = await fs.readFile(absPath);
    } catch (err: any) {
      localErr = err;
    }

    // Tier 2: fall back to the agent's runner container if the file isn't on
    // the API container's filesystem. Most agent-supplied paths land here.
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
      filename,
      mimeType,
      content: buf!.toString('base64'),
    };
  }

  // hasContent: legacy path — caller already supplied base64.
  if (!att.filename) {
    throw new Error('Attachment supplied via "content" must also include "filename".');
  }
  return {
    filename: att.filename,
    mimeType: att.mimeType || guessMimeType(att.filename),
    content: att.content!,
  };
}

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
 *
 * Each attachment is specified EITHER by:
 *   - `path`: absolute or relative path to a file on the server's disk
 *     (the MCP reads and base64-encodes it itself), OR
 *   - `content`: pre-encoded base64 string (legacy form; requires `filename`).
 *
 * When `path` is provided, `filename` defaults to the file's basename and
 * `mimeType` is auto-detected from the extension.
 */
const attachmentsSchema = z
  .array(
    z.object({
      path: z.string().optional().describe('Path to the file on the server filesystem. The MCP reads the file and base64-encodes it. Recommended way to attach files.'),
      filename: z.string().optional().describe('Display filename for the attachment, including extension. Defaults to the basename of "path" when not provided.'),
      mimeType: z.string().optional().describe('MIME type (e.g. "application/pdf"). Auto-detected from the extension when not provided.'),
      content: z.string().optional().describe('Optional base64-encoded content (alternative to "path"). Requires "filename".'),
    })
  )
  .optional()
  .describe('Optional list of file attachments. Specify each via "path" (preferred — file is read from disk) or pre-encoded "content".');

/**
 * Create the Gmail MCP server with all tools registered.
 * @param agentId - When provided, tools use agent-specific tokens.
 * @param boardId - Optional board context for token resolution.
 * @param runnerBridge - Optional bridge to the runner-service used to read
 *   attachment files from the agent's container when not present locally.
 */
export function createGmailMcpServer(
  agentId: string | null = null,
  boardId: string | null = null,
  runnerBridge: RunnerExecBridge | null = null,
) {
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
    'Send a new email via Gmail. Optional file attachments can be passed by disk path ("path") or as pre-encoded base64 ("content").',
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

      const raw = buildRawEmail({ to, cc, bcc, subject, body, attachments: resolved });

      const result = await gmailFetch('/users/me/messages/send', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({ raw }),
      });

      const attachInfo = resolved && resolved.length > 0
        ? `\nAttachments: ${resolved.map(a => a.filename).join(', ')}`
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
    'Reply to an existing email. Maintains the conversation thread. Optional file attachments can be passed by disk path ("path") or as pre-encoded base64 ("content").',
    {
      messageId: z.string().describe('The Gmail message ID to reply to'),
      body: z.string().describe('Reply body (plain text)'),
      replyAll: z.boolean().optional().default(false).describe('If true, reply to all recipients (default: false)'),
      attachments: attachmentsSchema,
    },
    async ({ messageId, body, replyAll, attachments }) => {
      const resolved = attachments
        ? await Promise.all(attachments.map(a => resolveAttachment(a, agentId, runnerBridge)))
        : undefined;
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
        attachments: resolved,
      });

      const result = await gmailFetch('/users/me/messages/send', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({
          raw,
          threadId: original.threadId,
        }),
      });

      const attachInfo = resolved && resolved.length > 0
        ? `\nAttachments: ${resolved.map(a => a.filename).join(', ')}`
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
    'Create a draft email in Gmail (without sending it). Optional file attachments can be passed by disk path ("path") or as pre-encoded base64 ("content").',
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

      const raw = buildRawEmail({ to, cc, bcc, subject, body, attachments: resolved });

      const result = await gmailFetch('/users/me/drafts', agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({
          message: { raw },
        }),
      });

      const attachInfo = resolved && resolved.length > 0
        ? `\nAttachments: ${resolved.map(a => a.filename).join(', ')}`
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
 *
 * @param runnerBridge - Optional. When provided, attachment paths that don't
 *   exist on the API container's filesystem are read via the agent's runner
 *   container. Without it, only files local to the API container can be
 *   attached (which is rarely useful in production).
 */
export function createGmailMcpHandler(runnerBridge: RunnerExecBridge | null = null) {
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
      const server = createGmailMcpServer(agentId, boardId, runnerBridge);
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
