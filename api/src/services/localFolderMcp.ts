import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import { WsEvents } from '../ws/events.js';
import { getDesktopSocketsForUser } from '../ws/socketHandler.js';

/**
 * Local Folder MCP — gives any configured LLM read/edit/generate access to a
 * folder on the USER'S OWN machine, WITHOUT the files ever leaving it.
 *
 * The tools defined here have no server-side implementation: each one is a thin
 * proxy that emit-with-acks `bridge:tool:call` to the user's connected desktop
 * app (the "bridge"), which executes the operation locally — file ops against an
 * allow-listed folder, office ops via its bundled office-engine sidecar — and
 * returns the result through the ack. The schemas mirror the office-engine tools
 * so the model sees the same surface whether a doc lives in the cloud (mcp-office)
 * or on disk (mcp-local-folder).
 *
 * agentContext:true → mcpManager forwards X-Agent-Id; we resolve it to the owning
 * user (agent.ownerId) and address that user's desktop room. There is no path the
 * server can reach another user's machine.
 */

const okEnvelope = (result: unknown) => ({
  content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
});
const jsonError = (error: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

const NO_DESKTOP =
  'No desktop app connected. Ask the user to open the PulsarTeam desktop app and pick a folder to share, then retry.';

/** One awaitable round-trip to the user's desktop. */
async function callDesktop(userId: string | null, tool: string, args: Record<string, unknown>, timeoutMs = 120_000) {
  if (!userId) return jsonError('Cannot resolve the owning user for this agent (agent.ownerId is empty).');
  const set = getDesktopSocketsForUser(userId);
  if (!set || set.size === 0) return jsonError(NO_DESKTOP);
  const socket = set.values().next().value; // first live bridge socket for this user
  try {
    const resp: any = await socket
      .timeout(timeoutMs)
      .emitWithAck(WsEvents.BRIDGE_TOOL_CALL, { requestId: randomUUID(), tool, args });
    if (resp && resp.ok) return okEnvelope(resp.result);
    return jsonError(resp?.error ? `${resp.code || 'error'}: ${resp.error}` : 'desktop returned an unspecified error');
  } catch {
    return jsonError('Desktop bridge timed out — the app may be busy or offline. Retry once it is back.');
  }
}

const PATH_HINT = ' Path is relative to the folder the user shared in the desktop app.';

// Reused zod fragments for office payloads (kept permissive so the model isn't
// fought by the schema; the office-engine validates the shapes).
const ops = z.array(z.record(z.string(), z.any())).describe('list of edit operations');
const spec = z.record(z.string(), z.any()).describe('structured document spec');
const outPath = z.string().optional().describe('destination path (default: a sibling .edited / output file)' + PATH_HINT);

type ToolDef = { name: string; description: string; shape: z.ZodRawShape };

const TOOLS: ToolDef[] = [
  // ── File operations (desktop filesystem, allow-listed) ──────────────
  { name: 'list_files', description: 'List files and subfolders in the shared folder.' + PATH_HINT,
    shape: { path: z.string().default('.').describe('folder path' + PATH_HINT) } },
  { name: 'read_file', description: 'Read a UTF-8 text file (for binary office files use read_document instead).' + PATH_HINT,
    shape: { path: z.string().describe('file path' + PATH_HINT) } },
  { name: 'write_file', description: 'Write a UTF-8 text file. Without overwrite=true the file goes under a pulsar-output/ subfolder.' + PATH_HINT,
    shape: { path: z.string(), content: z.string(), overwrite: z.boolean().default(false) } },
  { name: 'search_files', description: 'Find files by name/content within the shared folder.' + PATH_HINT,
    shape: { query: z.string().describe('text or filename fragment'), glob: z.string().optional().describe('optional glob filter, e.g. **/*.docx') } },

  // ── Universal office ────────────────────────────────────────────────
  { name: 'read_document', description: 'Read ANY office file (docx/xlsx/pptx/pdf) as markdown — best first step.' + PATH_HINT,
    shape: { path: z.string() } },
  { name: 'get_outline', description: 'Document structure only (headings/sheets/slides/bookmarks) with indexes.' + PATH_HINT,
    shape: { path: z.string() } },
  { name: 'convert_document', description: 'High-fidelity convert via LibreOffice (docx<->pdf, pptx->pdf, md->docx…). Also how to "edit" a PDF.' + PATH_HINT,
    shape: { path: z.string(), to_format: z.string().describe('pdf|docx|xlsx|pptx|odt|ods|odp|csv|html|png|txt'), output_path: outPath } },
  { name: 'render_preview', description: 'Render a page/slide to a PNG image; returns the saved image path.' + PATH_HINT,
    shape: { path: z.string(), page: z.number().default(1), dpi: z.number().default(150), output_path: outPath } },

  // ── Word ────────────────────────────────────────────────────────────
  { name: 'read_docx', description: 'Read a .docx into indexed paragraphs, tables and markdown.' + PATH_HINT, shape: { path: z.string() } },
  { name: 'edit_docx', description: 'Edit a .docx in place (round-trip). ops: replace_text/set_paragraph/insert_paragraph/delete_paragraph.' + PATH_HINT,
    shape: { path: z.string(), operations: ops, output_path: outPath } },
  { name: 'generate_docx', description: 'Create a new .docx from {title?, sections:[{heading,level,paragraphs[],bullets[],table}]}.' + PATH_HINT,
    shape: { output_path: z.string(), spec } },

  // ── Excel ───────────────────────────────────────────────────────────
  { name: 'read_xlsx', description: 'Read a .xlsx — sheet names, a capped cell grid and markdown tables.' + PATH_HINT,
    shape: { path: z.string(), sheet: z.string().optional(), max_rows: z.number().default(500), max_cols: z.number().default(50) } },
  { name: 'edit_xlsx', description: 'Set cells in a .xlsx (round-trip). cells:[{sheet?,cell:"B3",value}]; "="-prefixed = formula.' + PATH_HINT,
    shape: { path: z.string(), cells: z.array(z.record(z.string(), z.any())), output_path: outPath } },
  { name: 'generate_xlsx', description: 'Create a new .xlsx from {sheets:[{name,header?,rows:[[...]]}]}.' + PATH_HINT,
    shape: { output_path: z.string(), spec } },

  // ── PowerPoint ──────────────────────────────────────────────────────
  { name: 'read_pptx', description: 'Read a .pptx — per-slide title, body, notes and markdown.' + PATH_HINT, shape: { path: z.string() } },
  { name: 'edit_pptx', description: 'Edit a .pptx (round-trip). ops: replace_text/set_title/set_notes/add_slide.' + PATH_HINT,
    shape: { path: z.string(), operations: ops, output_path: outPath } },
  { name: 'generate_pptx', description: 'Create a new .pptx from {slides:[{layout?,title,bullets[],notes?}]}.' + PATH_HINT,
    shape: { output_path: z.string(), spec } },

  // ── PDF (read/extract/assemble only — no in-place text edit) ─────────
  { name: 'read_pdf', description: 'Extract text from a PDF (pages like "1-3,5"; default all) as markdown.' + PATH_HINT,
    shape: { path: z.string(), pages: z.string().optional() } },
  { name: 'extract_pdf', description: 'Extract "text" | "tables" | "images" from a PDF.' + PATH_HINT,
    shape: { path: z.string(), what: z.string().default('text'), pages: z.string().optional() } },
  { name: 'merge_pdfs', description: 'Concatenate 2+ PDFs into output_path.' + PATH_HINT,
    shape: { paths: z.array(z.string()).describe('PDF paths' + PATH_HINT), output_path: z.string() } },
  { name: 'split_pdf', description: 'Extract pages (e.g. "1-3,7") from a PDF into a new file.' + PATH_HINT,
    shape: { path: z.string(), pages: z.string(), output_path: outPath } },
];

export function createLocalFolderMcpServer(ctx: { agentId: string | null; boardId: string | null }, agentManager: any): McpServer {
  const server = new McpServer({ name: 'Local Folder', version: '1.0.0' });
  const ownerId: string | null = ctx.agentId ? (agentManager.agents.get(ctx.agentId)?.ownerId ?? null) : null;

  for (const def of TOOLS) {
    server.tool(def.name, def.description, def.shape, async (args: Record<string, unknown>) =>
      callDesktop(ownerId, def.name, args),
    );
  }
  return server;
}

export function createLocalFolderMcpHandler(agentManager: any) {
  return createMcpHttpHandler('Local Folder', (ctx) => createLocalFolderMcpServer(ctx, agentManager));
}
