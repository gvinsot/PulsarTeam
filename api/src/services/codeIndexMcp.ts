import fs from 'fs/promises';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import type {
  CodeIndexService,
  EnsureIndexedResult,
  IndexFreshness,
  SyncResult,
} from './codeIndexService.js';

/**
 * The repo-header fields rendered below. Two different results reach them:
 * `indexFolder` and `listRepos` hand over the stored header, where
 * `filesWithoutSymbols` is a count, while `getRepoSummary` replaces that same key
 * with the list of paths. Both are only interpolated into text here.
 */
interface RenderedRepo {
  id: string;
  name: string;
  rootPath: string;
  indexedAt: string;
  filesIndexed: number;
  symbolsIndexed: number;
  filesWithoutSymbols: number | string[];
  vectorBackend: string;
}

/** A node of the tree `CodeIndexService.getFileTree` builds; only directories carry children. */
interface RenderedTreeNode {
  name: string;
  type: 'file' | 'directory';
  children?: RenderedTreeNode[];
}

/** The outline entries `CodeIndexService.getFileOutline` returns for one file. */
interface RenderedOutlineSymbol {
  kind: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
}

interface RenderedOutline {
  file: { path: string; language: string };
  symbols: RenderedOutlineSymbol[];
}

/**
 * One hit of the three searches. `score` and `vectorScore` are folded in from the
 * per-search `scores` bag rather than fixed on the hit, so neither is guaranteed.
 */
interface RenderedSearchHit {
  kind: string;
  qualifiedName: string;
  filePath: string;
  score?: number;
  vectorScore?: number;
}

/** A symbol as embedded in reference results (see CodeIndexService.findReferences). */
interface RenderedSymbolRef {
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
}

interface RenderedReferences {
  symbol: RenderedSymbolRef;
  graphAvailable: boolean;
  total: number;
  truncated: boolean;
  references: {
    filePath: string;
    line: number;
    kind: string;
    confidence: string;
    enclosingSymbol: { qualifiedName: string } | null;
    preview?: string;
  }[];
}

interface RenderedCallers {
  symbol: RenderedSymbolRef;
  graphAvailable: boolean;
  totalCalls: number;
  total: number;
  truncated: boolean;
  callers: {
    caller: { id: string; qualifiedName: string; kind: string } | null;
    filePath: string;
    lines: number[];
    confidence: string;
  }[];
}

const GRAPH_MISSING_NOTE =
  'Note: this index predates the reference graph — re-run index_folder to get references.';

/**
 * Every tool working on one repo takes either its `repoId` or its `repoName`
 * (resolved by CodeIndexService.resolveRepoId); `repoId` wins when both are set.
 */
const REPO_SELECTOR = {
  repoId: z
    .string()
    .optional()
    .describe('Indexed repository ID (from list_repos). Either repoId or repoName is required'),
  repoName: z
    .string()
    .optional()
    .describe(
      'Repository/project name, e.g. "PulsarTeam" (case-insensitive), resolved to its repoId. Alternative to repoId'
    ),
};

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function detectWorkspaceRoot() {
  const cwd = process.cwd();
  const parent = path.resolve(cwd, '..');

  if (
    (await pathExists(path.join(parent, '.git'))) ||
    (await pathExists(path.join(parent, 'client'))) ||
    (await pathExists(path.join(parent, 'server')))
  ) {
    return parent;
  }

  return cwd;
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function formatRepoSummary(repo: RenderedRepo) {
  return [
    `Repo indexed: ${repo.name}`,
    `Repo ID: ${repo.id}`,
    `Root path: ${repo.rootPath}`,
    `Files indexed: ${repo.filesIndexed}`,
    `Symbols indexed: ${repo.symbolsIndexed}`,
    `Files without symbols: ${repo.filesWithoutSymbols}`,
    `Vector backend: ${repo.vectorBackend}`,
    `Indexed at: ${repo.indexedAt}`,
  ].join('\n');
}

function renderTree(node: RenderedTreeNode, depth = 0): string {
  const prefix = depth === 0 ? '' : '  '.repeat(depth - 1) + '└─ ';
  const icon = node.type === 'directory' ? '📁' : '📄';
  const current = `${prefix}${icon} ${node.name || '.'}`;

  if (!node.children?.length) return current;
  return [current, ...node.children.flatMap(child => renderTree(child, depth + 1))].join('\n');
}

function summarizeOutline(outline: RenderedOutline) {
  if (!outline.symbols?.length) {
    return `File: ${outline.file.path}\nNo symbols detected.`;
  }

  const lines = outline.symbols.map(
    symbol => `- ${symbol.kind} ${symbol.qualifiedName} (${symbol.startLine}-${symbol.endLine})`
  );

  return `File: ${outline.file.path}\nLanguage: ${outline.file.language}\n\n${lines.join('\n')}`;
}

function summarizeSearchResults(results: RenderedSearchHit[]) {
  if (!results.length) return 'No results found.';
  return results
    .map((result, index) => {
      const score = result.score ?? result.vectorScore ?? 0;
      return `${index + 1}. ${result.qualifiedName} [${result.kind}] — ${result.filePath} (score: ${score})`;
    })
    .join('\n');
}

function listChangedPaths(changed: IndexFreshness['changedFiles'], truncated: boolean) {
  const parts = (['modified', 'added', 'deleted'] as const)
    .filter(key => changed[key].length > 0)
    .map(key => `${key}: ${changed[key].join(', ')}`);
  return parts.length ? `${parts.join('; ')}${truncated ? ' (list truncated)' : ''}` : '';
}

function describeGit(git: IndexFreshness['git']) {
  if (!git) return '';
  const short = (commit: string | null) => (commit ? commit.slice(0, 12) : 'unknown');
  const branch = git.branch ? ` on ${git.branch}` : '';
  return git.headMoved
    ? `, git HEAD moved ${short(git.indexedCommit)} → ${short(git.currentCommit)}${branch}`
    : `, commit ${short(git.indexedCommit ?? git.currentCommit)}${branch}`;
}

/** One-line freshness header put on top of search results, or a multi-line warning when stale. */
function summarizeFreshness(freshness: IndexFreshness) {
  const age = `index age ${freshness.indexAge}${describeGit(freshness.git)}`;
  if (freshness.stale === null) {
    return `Index freshness unknown (${age}): ${freshness.error}`;
  }
  if (!freshness.stale) return `Index is fresh (${age}).`;
  return [
    `⚠️ Index is STALE (${age}): ${freshness.changedFileCount} file(s) changed since indexing — results may be outdated.`,
    `Changed: ${listChangedPaths(freshness.changedFiles, freshness.changedFilesTruncated)}`,
    'Run sync (same repoId/repoName) or ensure_indexed to refresh.',
  ].join('\n');
}

function summarizeSync(result: SyncResult) {
  const changed = listChangedPaths(result.changedFiles, result.changedFilesTruncated);
  return [
    `Synced ${result.repo.name} (${result.repoId}) in ${result.durationMs}ms: +${result.added} added, ~${result.updated} updated, -${result.removed} removed, ${result.touched} touched (mtime only), ${result.unchanged} unchanged`,
    ...(changed ? [`Changed: ${changed}`] : []),
    ...(result.git
      ? [
          `Git: ${result.git.commit.slice(0, 12)}${result.git.branch ? ` on ${result.git.branch}` : ''}`,
        ]
      : []),
  ].join('\n');
}

function summarizeEnsureIndexed(result: EnsureIndexedResult) {
  const action = {
    indexed: 'No index existed — indexed it',
    synced: 'Index was out of date — synced it',
    fresh: 'Index already up to date',
  }[result.action];
  return [
    `${action}.`,
    `Repo: ${result.repo.name}`,
    `Repo ID: ${result.repoId}`,
    `Root path: ${result.repo.rootPath}`,
    `Files indexed: ${result.repo.filesIndexed}, symbols: ${result.repo.symbolsIndexed}`,
    ...(result.sync ? [summarizeSync(result.sync)] : []),
    summarizeFreshness(result.freshness),
  ].join('\n');
}

function describeTarget(symbol: RenderedSymbolRef) {
  return `${symbol.qualifiedName} [${symbol.kind}] — ${symbol.filePath}:${symbol.startLine}`;
}

function summarizeReferences(result: RenderedReferences) {
  const header = `References to ${describeTarget(result.symbol)}: ${result.total}${result.truncated ? ` (showing ${result.references.length})` : ''}`;
  if (!result.graphAvailable) return `${header}\n${GRAPH_MISSING_NOTE}`;
  if (!result.references.length) return `${header}\nNo references found.`;
  const lines = result.references.map(ref => {
    const scope = ref.enclosingSymbol ? ` in ${ref.enclosingSymbol.qualifiedName}` : '';
    const preview = ref.preview ? ` — ${ref.preview}` : '';
    return `- ${ref.filePath}:${ref.line} [${ref.kind}, ${ref.confidence}]${scope}${preview}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

function summarizeCallers(result: RenderedCallers) {
  const header = `Callers of ${describeTarget(result.symbol)}: ${result.total} (${result.totalCalls} call sites)${result.truncated ? `, showing ${result.callers.length}` : ''}`;
  if (!result.graphAvailable) return `${header}\n${GRAPH_MISSING_NOTE}`;
  if (!result.callers.length) return `${header}\nNo callers found.`;
  const lines = result.callers.map(entry => {
    const who = entry.caller
      ? `${entry.caller.qualifiedName} [${entry.caller.kind}] (${entry.caller.id})`
      : '<module top level>';
    return `- ${who} — ${entry.filePath} lines ${entry.lines.join(', ')} [${entry.confidence}]`;
  });
  return `${header}\n${lines.join('\n')}`;
}

export function createCodeIndexMcpServer(codeIndexService: CodeIndexService) {
  const server = new McpServer({
    name: 'Code Index',
    version: '1.0.0',
  });

  server.tool(
    'index_folder',
    'Index a local folder on the server host for symbol lookup and semantic code search.',
    {
      path: z
        .string()
        .describe('Absolute path or path relative to the backend process working directory'),
      repoName: z.string().optional().describe('Optional display name for the indexed repo'),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .max(20000)
        .optional()
        .describe('Maximum number of files to index'),
      maxFileSize: z
        .number()
        .int()
        .min(1024)
        .max(5 * 1024 * 1024)
        .optional()
        .describe('Maximum file size in bytes'),
    },
    async ({ path: folderPath, repoName, maxFiles, maxFileSize }) => {
      const repo = await codeIndexService.indexFolder({
        folderPath,
        repoName,
        maxFiles,
        maxFileSize,
      });

      return {
        content: [
          {
            type: 'text',
            text: `${formatRepoSummary(repo)}\n\nJSON:\n${formatJson(repo)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'index_workspace',
    'Index the current application workspace or one of its subpaths.',
    {
      subpath: z
        .string()
        .optional()
        .describe('Optional subpath under the detected workspace root, e.g. "server/src"'),
      repoName: z.string().optional().describe('Optional display name for the indexed repo'),
      maxFiles: z.number().int().min(1).max(20000).optional(),
      maxFileSize: z
        .number()
        .int()
        .min(1024)
        .max(5 * 1024 * 1024)
        .optional(),
    },
    async ({ subpath = '', repoName, maxFiles, maxFileSize }) => {
      const workspaceRoot = await detectWorkspaceRoot();
      const targetPath = subpath ? path.resolve(workspaceRoot, subpath) : workspaceRoot;

      const repo = await codeIndexService.indexFolder({
        folderPath: targetPath,
        repoName: repoName || path.basename(targetPath),
        maxFiles,
        maxFileSize,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Workspace root: ${workspaceRoot}\nTarget path: ${targetPath}\n\n${formatRepoSummary(repo)}\n\nJSON:\n${formatJson(repo)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'list_repos',
    'List all indexed repositories currently available in the code index.',
    {},
    async () => {
      const repos = await codeIndexService.listRepos();
      const summary = repos.length
        ? repos
            .map(
              repo =>
                `- ${repo.name} (${repo.id}) — ${repo.filesIndexed} files, ${repo.symbolsIndexed} symbols`
            )
            .join('\n')
        : 'No indexed repositories.';

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\nJSON:\n${formatJson(repos)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'find_repos_by_project',
    'List the indexed repositories of a project, matched by name (case-insensitive). Use it to check whether the current project is indexed and get its repoId.',
    {
      project: z.string().min(1).describe('Project/repository name, e.g. "PulsarTeam"'),
    },
    async ({ project }) => {
      const repos = await codeIndexService.findReposByProject(project);
      const summary = repos.length
        ? repos
            .map(
              repo =>
                `- ${repo.name} (${repo.id}) — ${repo.rootPath}, ${repo.filesIndexed} files, ${repo.symbolsIndexed} symbols`
            )
            .join('\n')
        : `No indexed repository for project "${project}" — index it with index_folder.`;

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\nJSON:\n${formatJson(repos)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'get_repo_summary',
    'Get metadata and counts for an indexed repository.',
    {
      ...REPO_SELECTOR,
    },
    async ({ repoId: repoIdArg, repoName }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const [summary, freshness] = await Promise.all([
        codeIndexService.getRepoSummary(repoId),
        codeIndexService.getFreshness(repoId),
      ]);
      return {
        content: [
          {
            type: 'text',
            text: `${formatRepoSummary(summary)}\n${summarizeFreshness(freshness)}\n\nJSON:\n${formatJson({ ...summary, freshness })}`,
          },
        ],
      };
    }
  );

  server.tool(
    'get_file_tree',
    'Get the indexed file tree for a repository.',
    {
      ...REPO_SELECTOR,
    },
    async ({ repoId: repoIdArg, repoName }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const tree = await codeIndexService.getFileTree(repoId);
      return {
        content: [
          {
            type: 'text',
            text: `${renderTree(tree)}\n\nJSON:\n${formatJson(tree)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'get_file_outline',
    'Get the symbol outline for a specific indexed file.',
    {
      ...REPO_SELECTOR,
      filePath: z.string().describe('Indexed file path, relative to repo root'),
    },
    async ({ repoId: repoIdArg, repoName, filePath }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const outline = await codeIndexService.getFileOutline(repoId, filePath);
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeOutline(outline)}\n\nJSON:\n${formatJson(outline)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'get_symbol',
    'Get the stored source and metadata for a symbol.',
    {
      ...REPO_SELECTOR,
      symbolId: z.string().describe('Symbol ID returned by outline/search calls'),
      verify: z
        .boolean()
        .optional()
        .describe('Verify live source drift against current filesystem contents'),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe('Extra context lines around the symbol'),
    },
    async ({ repoId: repoIdArg, repoName, symbolId, verify = false, contextLines = 0 }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const symbol = await codeIndexService.getSymbol(repoId, symbolId, { verify, contextLines });
      return {
        content: [
          {
            type: 'text',
            text: `Symbol: ${symbol.qualifiedName}\nKind: ${symbol.kind}\nFile: ${symbol.filePath}\nLines: ${symbol.startLine}-${symbol.endLine}\nDrift detected: ${symbol.driftDetected ? 'yes' : 'no'}\n\nSource:\n${symbol.source}\n\nJSON:\n${formatJson(symbol)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'read_file_range',
    'Read a line range of an indexed file (imports, config, code outside symbols). Always checks the live file against the index and reports drift.',
    {
      ...REPO_SELECTOR,
      filePath: z.string().describe('Indexed file path, relative to repo root'),
      startLine: z.number().int().min(1).describe('First line to read (1-based, inclusive)'),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Last line to read (inclusive, clamped to the file length; default startLine+199, max 2000 lines)'
        ),
    },
    async ({ repoId: repoIdArg, repoName, filePath, startLine, endLine }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const range = await codeIndexService.readFileRange(repoId, filePath, { startLine, endLine });
      const width = String(range.endLine).length;
      const numbered = range.content
        .split('\n')
        .map((line, index) => `${String(range.startLine + index).padStart(width)}  ${line}`)
        .join('\n');
      const drift = range.driftDetected
        ? 'yes (file changed since indexing; run update_files to refresh the index)'
        : 'no';
      const { content: _content, ...meta } = range;
      return {
        content: [
          {
            type: 'text',
            text: `File: ${range.filePath}\nLines: ${range.startLine}-${range.endLine} of ${range.totalLines}${range.endLineClamped ? ' (endLine clamped to end of file)' : ''}\nDrift detected: ${drift}\n\n${numbered}\n\nJSON:\n${formatJson(meta)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'search_symbols',
    'Perform lexical symbol search by name/signature/summary. The response starts with the index freshness (age, git commit, files changed since indexing); when it says STALE, run sync first.',
    {
      ...REPO_SELECTOR,
      query: z.string().describe('Search query'),
      kind: z
        .enum(['function', 'class', 'method'])
        .optional()
        .describe('Optional symbol kind filter'),
      topK: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
    },
    async ({ repoId: repoIdArg, repoName, query, kind, topK = 10 }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const [results, freshness] = await Promise.all([
        codeIndexService.searchSymbols(repoId, { query, kind, topK }),
        codeIndexService.getFreshness(repoId),
      ]);
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeFreshness(freshness)}\n\n${summarizeSearchResults(results)}\n\nJSON:\n${formatJson({ freshness, results })}`,
          },
        ],
      };
    }
  );

  server.tool(
    'search_semantic',
    'Perform semantic code search over indexed symbols. The response starts with the index freshness (age, git commit, files changed since indexing); when it says STALE, run sync first.',
    {
      ...REPO_SELECTOR,
      query: z.string().describe('Semantic search query'),
      topK: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
    },
    async ({ repoId: repoIdArg, repoName, query, topK = 10 }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const [results, freshness] = await Promise.all([
        codeIndexService.searchSemantic(repoId, { query, topK }),
        codeIndexService.getFreshness(repoId),
      ]);
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeFreshness(freshness)}\n\n${summarizeSearchResults(results)}\n\nJSON:\n${formatJson({ freshness, results })}`,
          },
        ],
      };
    }
  );

  server.tool(
    'search_text',
    'Perform exact text-style search over indexed symbol bodies and summaries. The response starts with the index freshness (age, git commit, files changed since indexing); when it says STALE, run sync first.',
    {
      ...REPO_SELECTOR,
      query: z.string().describe('Text search query'),
      topK: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
    },
    async ({ repoId: repoIdArg, repoName, query, topK = 10 }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const [results, freshness] = await Promise.all([
        codeIndexService.searchText(repoId, { query, topK }),
        codeIndexService.getFreshness(repoId),
      ]);
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeFreshness(freshness)}\n\n${summarizeSearchResults(results)}\n\nJSON:\n${formatJson({ freshness, results })}`,
          },
        ],
      };
    }
  );

  const confidenceSchema = z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe(
      'Drop matches below this confidence (default "low" = everything). "high" keeps only matches resolved through imports or the same file/class'
    );
  const limitSchema = z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Maximum number of results (default 100)');

  server.tool(
    'find_references',
    'Find every place that references a symbol (call sites, imports, other uses), resolved through the import/call graph built at indexing. Use it before renaming or changing a signature to see what would break. Each hit has file, line, kind (call/import/reference), confidence (high/medium/low) and the enclosing symbol.',
    {
      ...REPO_SELECTOR,
      symbolId: z.string().describe('Symbol ID returned by outline/search calls'),
      limit: limitSchema,
      minConfidence: confidenceSchema,
      includeImports: z
        .boolean()
        .optional()
        .describe('Include import/re-export statements (default true)'),
    },
    async ({ repoId: repoIdArg, repoName, symbolId, limit, minConfidence, includeImports }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const result = await codeIndexService.findReferences(repoId, symbolId, {
        limit,
        minConfidence,
        includeImports,
      });
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeReferences(result)}\n\nJSON:\n${formatJson(result)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'find_callers',
    'Find the functions/methods that call a symbol (function, method or class constructor), one entry per caller with its call lines. Callers carry a symbolId, so the call graph can be walked upwards by calling find_callers again.',
    {
      ...REPO_SELECTOR,
      symbolId: z.string().describe('Symbol ID returned by outline/search calls'),
      limit: limitSchema,
      minConfidence: confidenceSchema,
    },
    async ({ repoId: repoIdArg, repoName, symbolId, limit, minConfidence }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const result = await codeIndexService.findCallers(repoId, symbolId, { limit, minConfidence });
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeCallers(result)}\n\nJSON:\n${formatJson(result)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'ensure_indexed',
    'One call to make a folder searchable and get its repoId: indexes it if no index exists for that folder, syncs it incrementally if files changed (or git HEAD moved) since, otherwise does nothing. Idempotent — call it at the start of a task instead of list_repos + index_folder.',
    {
      path: z
        .string()
        .describe('Absolute path or path relative to the backend process working directory'),
      repoName: z
        .string()
        .optional()
        .describe(
          'Display name when a new index is created (default: folder name); also picks among several indexes of the same folder'
        ),
    },
    async ({ path: folderPath, repoName }) => {
      const result = await codeIndexService.ensureIndexed({ folderPath, repoName });
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeEnsureIndexed(result)}\n\nJSON:\n${formatJson(result)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'sync',
    'Incrementally re-index a repository from disk: only files whose size/mtime and content hash changed are re-parsed, new files are added, deleted ones dropped, and the git HEAD is recorded. Use it when a search reports a STALE index.',
    {
      ...REPO_SELECTOR,
    },
    async ({ repoId: repoIdArg, repoName }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const result = await codeIndexService.syncRepo(repoId);
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeSync(result)}\n\nJSON:\n${formatJson(result)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'check_freshness',
    'Report how current an index is without changing it: index age, indexed vs current git commit, and the files modified/added/deleted on disk since indexing.',
    {
      ...REPO_SELECTOR,
    },
    async ({ repoId: repoIdArg, repoName }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const freshness = await codeIndexService.getFreshness(repoId, { useCache: false });
      return {
        content: [
          {
            type: 'text',
            text: `${summarizeFreshness(freshness)}\n\nJSON:\n${formatJson(freshness)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'update_files',
    'Incrementally update specific files in an indexed repository without full re-indexing.',
    {
      ...REPO_SELECTOR,
      files: z
        .array(
          z.object({
            path: z.string().describe('Relative file path (posix-style, e.g. "src/index.js")'),
            content: z
              .string()
              .optional()
              .describe('New file content — if omitted, the file is read from disk'),
          })
        )
        .min(1)
        .max(100)
        .describe('Files to update'),
    },
    async ({ repoId: repoIdArg, repoName, files }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const result = await codeIndexService.updateFiles(repoId, files);
      return {
        content: [
          {
            type: 'text',
            text: `Updated index ${repoId}: +${result.added} added, ~${result.updated} updated, -${result.removed} removed\n\nJSON:\n${formatJson(result)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'delete_repo',
    'Delete an indexed repository from the code index.',
    {
      ...REPO_SELECTOR,
    },
    async ({ repoId: repoIdArg, repoName }) => {
      const repoId = await codeIndexService.resolveRepoId({ repoId: repoIdArg, repoName });
      const result = await codeIndexService.invalidate(repoId);
      return {
        content: [
          {
            type: 'text',
            text: `Deleted indexed repo ${repoId}.\n\nJSON:\n${formatJson(result)}`,
          },
        ],
      };
    }
  );

  return server;
}

export function createCodeIndexMcpHandler(codeIndexService: CodeIndexService) {
  return createMcpHttpHandler('Code Index', () => createCodeIndexMcpServer(codeIndexService));
}
