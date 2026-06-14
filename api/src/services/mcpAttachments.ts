import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Shared attachment stack for the email MCPs (Gmail, Outlook).
 *
 * Owns the MIME table, the runner-bridge file read with its probe/truncation
 * protocol (security-sensitive: cross-agent isolation is enforced by running
 * under the agent's UID in the runner container), the two-tier
 * local-fs-then-runner attachment resolution, and the tool schema for the
 * `attachments` parameter. Each provider keeps a thin adapter mapping the
 * resolved attachment onto its wire shape.
 */

/**
 * Minimal interface for the runner-service bridge used to read attachment
 * files from an agent's container when the file is not present on the API
 * container filesystem (which is the common case — agents live in separate
 * containers with their own volumes).
 */
export type RunnerExecBridge = {
  exec: (
    agentId: string,
    command: string,
    options?: { cwd?: string; timeout?: number; maxOutput?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
};

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

export function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** Shell-quote a string for safe inclusion in a bash command. */
function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Attachment shape accepted by the MCP tools (before resolution).
 * Either `path` (file on disk, read by the MCP) or `content` (pre-encoded
 * base64) must be provided.
 */
export type AttachmentInput = {
  path?: string;
  filename?: string;
  mimeType?: string;
  content?: string;
};

/**
 * Provider-neutral resolved attachment. `contentBase64` is standard base64
 * for the `path` branch; for the `content` branch the caller-supplied payload
 * is passed through RAW — each provider adapter owns normalization/validation
 * (Outlook validates at resolve time, Gmail later in buildRawEmail).
 */
export type ResolvedAttachment = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};

export type AttachmentLimits = {
  /** Per-attachment binary size cap (provider-specific). */
  maxBytes: number;
  /** Runner exec output cap — must cover maxBytes plus ~33% base64 overhead. */
  maxOutput: number;
  /**
   * Suffix of the size-limit error after "<n> MB " (default "limit"), e.g.
   * "inline-attachment limit for Outlook".
   */
  limitLabel?: string;
};

/**
 * Read a file from the agent's runner-service container via /exec-shell.
 *
 * The email MCPs run in the API container, so file paths supplied by an
 * agent (which live in a separate runner container with its own volumes
 * and per-agent UID isolation) are not accessible via local fs. We delegate
 * the read to the runner-service, which executes under the agent's UID and
 * therefore enforces cross-agent isolation automatically.
 */
export async function readAttachmentViaRunner(
  bridge: RunnerExecBridge,
  agentId: string,
  filePath: string,
  opts: AttachmentLimits,
): Promise<Buffer> {
  const limitLabel = opts.limitLabel || 'limit';
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
  if (size > opts.maxBytes) {
    throw new Error(
      `Attachment "${filePath}" is ${(size / 1024 / 1024).toFixed(1)} MB, ` +
      `which exceeds the ${opts.maxBytes / 1024 / 1024} MB ${limitLabel}.`
    );
  }

  // Binary attachments expand by ~33% once base64-encoded; the caller passes
  // a maxOutput covering that overhead so the runner does not silently
  // truncate the output. (A previous default of 10 000 chars caused
  // attachments to be cut to ~7.3 KB after decoding.)
  const res = await bridge.exec(
    agentId,
    `base64 -w0 ${shQuote(filePath)}`,
    { timeout: 120000, maxOutput: opts.maxOutput },
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
 * Resolve a user-provided attachment input into a provider-neutral shape:
 * read from disk when `path` is supplied, infer filename and MIME type from
 * the path when not explicitly provided, and validate size.
 *
 * Reads happen in two tiers:
 *   1. Try the API container's local filesystem (legacy / dev convenience).
 *   2. If the file isn't on the API container (ENOENT/EACCES) and an agent
 *      context is available, fall back to reading via the agent's runner
 *      container. This is the normal path in production: agent workspaces
 *      live in the runner-service container, not in the API container.
 */
export async function resolveAttachmentInput(
  att: AttachmentInput,
  opts: AttachmentLimits & {
    agentId?: string | null;
    runnerBridge?: RunnerExecBridge | null;
  },
): Promise<ResolvedAttachment> {
  if (!att || (typeof att !== 'object')) {
    throw new Error('Each attachment must be an object.');
  }

  const limitLabel = opts.limitLabel || 'limit';
  const { agentId = null, runnerBridge = null } = opts;

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
      if (stat.size > opts.maxBytes) {
        throw new Error(
          `Attachment "${userPath}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, ` +
          `which exceeds the ${opts.maxBytes / 1024 / 1024} MB ${limitLabel}.`
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
          buf = await readAttachmentViaRunner(runnerBridge!, agentId!, userPath, opts);
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
      contentBase64: buf!.toString('base64'),
    };
  }

  // hasContent: legacy path — caller already supplied base64 (passed through
  // raw; the provider adapter owns normalization/validation).
  if (!att.filename) {
    throw new Error('Attachment supplied via "content" must also include "filename".');
  }
  return {
    filename: att.filename,
    mimeType: att.mimeType || guessMimeType(att.filename),
    contentBase64: att.content!,
  };
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
 *
 * @param extraDescription - Provider-specific suffix appended to the
 *   array-level description (wire-visible in the MCP tools/list response).
 */
export function buildAttachmentsSchema(extraDescription = '') {
  return z
    .array(
      z.object({
        path: z.string().optional().describe('Path to the file on the server filesystem. The MCP reads the file and base64-encodes it. Recommended way to attach files.'),
        filename: z.string().optional().describe('Display filename for the attachment, including extension. Defaults to the basename of "path" when not provided.'),
        mimeType: z.string().optional().describe('MIME type (e.g. "application/pdf"). Auto-detected from the extension when not provided.'),
        content: z.string().optional().describe('Optional base64-encoded content (alternative to "path"). Requires "filename".'),
      })
    )
    .optional()
    .describe(`Optional list of file attachments. Specify each via "path" (preferred — file is read from disk) or pre-encoded "content".${extraDescription}`);
}
