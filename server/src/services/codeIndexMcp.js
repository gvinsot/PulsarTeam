import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

async function pathExists(targetPath) {
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
    await pathExists(path.join(parent, '.git')) ||
    await pathExists(path.join(parent, 'client')) ||
    await pathExists(path.join(parent, 'server'))
  ) {
    return parent;
  }

  return cwd;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function formatRepoSummary(repo) {
  return [
    `Repo indexed: ${repo.name}`,
    `Repo ID: ${repo.id}`,
    `Root path: ${repo.rootPath}`,
    `Files indexed: ${repo.filesIndexed}`,
    `Symbols indexed: ${repo.symbolsIndexed}`,
    `Files without symbols: ${repo.filesWithoutSymbols}`,
    `Vector backend: ${repo.vectorBackend}`,
    `Indexed at: ${repo.indexedAt}`,
  ].join('\\n');
}

function renderTree(node, depth = 0) {
  const prefix = depth === 0 ? '' : '  '.repeat(depth - 1) + '└─ ';
  const icon = node.type === 'directory' ? '📁' : '📄';
  const current = `${prefix}${icon} ${node.name || '.'}`;

  if (!node.children?.length) return current;
  return [
    current,
    ...node.children.flatMap((child) => renderTree(child, depth + 1)),
  ].join('\\n');
}

function summarizeOutline(outline) {
  if (!outline.symbols?.length) {
    return `File: ${outline.file.path}\\nNo symbols detected.`;
  }

  const lines = outline.symbols.map((symbol) =>
    `- ${symbol.kind} ${symbol.qualifiedName} (${symbol.startLine}-${symbol.endLine})`
  );

  return `File: ${outline.file.path}\\nLanguage: ${outline.file.language}\\n\\n${lines.join('\\n')}`;
}

function summarizeSearchResults(results) {
  if (!results.length) return 'No results found.';
  return results
    .map((result, index) => {
      const score = result.score ?? result.vectorScore ?? 0;
      return `${index + 1}. ${result.qualifiedName} [${result.kind}] — ${result.filePath} (score: ${score})`;
    })
    .join('\\n');
}

export function createCodeIndexMcpServer(codeIndexService) {
  const server = new McpServer({
    name: 'Code Index',
    version: '1.0.0',
  });

  server.tool(
    'index_folder',
    'Index a local folder on the server host for symbol lookup and semantic code search.',
    {
      path: z.string().describe('Absolute path or path relative to the backend process working directory'),
      repoName: z.string().optional().describe('Optional display name for the indexed repo'),
      maxFiles: z.number().int().min(1).max(20000).optional().describe('Maximum number of files to index'),
      maxFileSize: z.number().int().min(1024).max(5 * 1024 * 1024).optional().describe('Maximum file size in bytes'),
    },
    async ({ path: folderPath, repoName, maxFiles, maxFileSize }) => {
      const repo = await codeIndexService.indexFolder({
        folderPath,
        repoName,
        maxFiles,
        maxFileSize,
      });

      return {
        content: [{
          type: 'text',
          text: `${formatRepoSummary(repo)}\\n\\nJSON:\\n${formatJson(repo)}`,
        }],
      };
    }
  );

  server.tool(
    'index_workspace',
    'Index the current application workspace or one of its subpaths.',
    {
      subpath: z.string().optional().describe('Optional subpath under the detected workspace root, e.g. "server/src"'),
      repoName: z.string().optional().describe('Optional display name for the indexed repo'),
      maxFiles: z.number().int().min(1).max(20000).optional(),
      maxFileSize: z.number().int().min(1024).max(5 * 1024 * 1024).optional(),
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
        content: [{
          type: 'text',
          text: `Workspace root: ${workspaceRoot}\\nTarget path: ${targetPath}\\n\\n${formatRepoSummary(repo)}\\n\\nJSON:\\n${formatJson(repo)}`,
        }],
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
        ? repos.map((repo) => `- ${repo.name} (${repo.id}) — ${repo.filesIndexed} files, ${repo.symbolsIndexed} symbols`).join('\\n')
        : 'No indexed repositories.';

      return {
        content: [{
          type: 'text',
          text: `${summary}\\n\\nJSON:\\n${formatJson(repos)}`,
        }],
      };
    }
  );

  server.tool(
    'get_repo_summary',
    'Get metadata and counts for an indexed repository.',
    {
      repoId: z.string().describe('Indexed repository ID'),
    },
    async ({ repoId }) => {
      const summary = await codeIndexService.getRepoSummary(repoId);
      return {
        content: [{
          type: 'text',
          text: `${formatRepoSummary(summary)}\\n\\nJSON:\\n${formatJson(summary)}`,
        }],
      };
    }
  );

  server.tool(
    'get_file_tree',
    'Get the indexed file tree for a repository.',
    {
      repoId: z.string().describe('Indexed repository ID'),
    },
    async ({ repoId }) => {
      const tree = await codeIndexService.getFileTree(repoId);
      return {
        content: [{
          type: 'text',
          text: `${renderTree(tree)}\\n\\nJSON:\\n${formatJson(tree)}`,
        }],
      };
    }
  );

  server.tool(
    'get_file_outline',
    'Get the symbol outline for a specific indexed file.',
    {
      repoId: z.string().describe('Indexed repository ID'),
      filePath: z.string().describe('Indexed file path, relative to repo root'),
    },
    async ({ repoId, filePath }) => {
      const outline = await codeIndexService.getFileOutline(repoId, filePath);
      return {
        content: [{
          type: 'text',
          text: `${summarizeOutline(outline)}\\n\\nJSON:\\n${formatJson(outline)}`,
        }],
      };
    }
  );

  server.tool(
    'get_symbol',
    'Get the stored source and metadata for a symbol.',
    {
      repoId: z.string().describe('Indexed repository ID'),
      symbolId: z.string().describe('Symbol ID returned by outline/search calls'),
      verify: z.boolean().optional().describe('Verify live source drift against current filesystem contents'),
      contextLines: z.number().int().min(0).max(50).optional().describe('Extra context lines around the symbol'),
    },
    async ({ repoId, symbolId, verify = false, contextLines = 0 }) => {
      const symbol = await codeIndexService.getSymbol(repoId, symbolId, { verify, contextLines });
      return {
        content: [{
          type: 'text',
          text: `Symbol: ${symbol.qualifiedName}\\nKind: ${symbol.kind}\\nFile: ${symbol.filePath}\\nLines: ${symbol.startLine}-${symbol.endLine}\\nDrift detected: ${symbol.driftDetected ? 'yes' : 'no'}\\n\\nSource:\\n${symbol.source}\\n\\nJSON:\\n${formatJson(symbol)}`,
        }],
      };
    }
  );

  server.tool(
    'search_symbols',
    'Perform lexical symbol search by name/signature/summary.',
    {
      repoId: z.string().describe('Indexed repository ID'),
      query: z.string().describe('Search query'),
      kind: z.enum(['function', 'class', 'method']).optional().describe('Optional symbol kind filter'),
      topK: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
    },
    async ({ repoId, query, kind, topK = 10 }) => {
      const results = await codeIndexService.searchSymbols(repoId, { query, kind, topK });
      return {
        content: [{
          type: 'text',
          text: `${summarizeSearchResults(results)}\\n\\nJSON:\\n${formatJson(results)}`,
        }],
      };
    }
  );

  server.tool(
    'search_semantic',
    'Perform semantic code search over indexed symbols.',
    {
      repoId: z.string().describe('Indexed repository ID'),
      query: z.string().describe('Semantic search query'),
      topK: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
    },
    async ({ repoId, query, topK = 10 }) => {
      const results = await codeIndexService.searchSemantic(repoId, { query, topK });
      return {
        content: [{
          type: 'text',
          text: `${summarizeSearchResults(results)}\\n\\nJSON:\\n${formatJson(results)}`,
        }],
      };
    }
  );

  server.tool(
    'search_text',
    'Perform exact text-style search over indexed symbol bodies and summaries.',
    {
      repoId: z.string().describe('Indexed repository ID'),
      query: z.string().describe('Text search query'),
      topK: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
    },
    async ({ repoId, query, topK = 10 }) => {
      const results = await codeIndexService.searchText(repoId, { query, topK });
      return {
        content: [{
          type: 'text',
          text: `${summarizeSearchResults(results)}\\n\\nJSON:\\n${formatJson(results)}`,
        }],
      };
    }
  );

  server.tool(
    'delete_repo',
    'Delete an indexed repository from the code index.',
    {
      repoId: z.string().describe('Indexed repository ID'),
    },
    async ({ repoId }) => {
      const result = await codeIndexService.invalidate(repoId);
      return {
        content: [{
          type: 'text',
          text: `Deleted indexed repo ${repoId}.\\n\\nJSON:\\n${formatJson(result)}`,
        }],
      };
    }
  );

  return server;
}

export function createCodeIndexMcpHandler(codeIndexService) {
  const mcpServer = createCodeIndexMcpServer(codeIndexService);
  const transports = new Map();

  return async (req, res) => {
    try {
      if (req.method === 'GET') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        transports.set(transport.sessionId, transport);

        res.on('close', () => {
          transports.delete(transport.sessionId);
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      transports.set(transport.sessionId, transport);

      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[Code Index MCP] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  };
}