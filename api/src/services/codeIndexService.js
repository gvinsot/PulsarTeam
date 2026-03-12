import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { createHashedEmbedding, EMBEDDING_DIMENSION, normalizeText } from './codeSearch/embedding.js';
import { extractSymbolsFromContent } from './codeSearch/symbolExtractor.js';
import { createVectorStore } from './codeSearch/vectorStore.js';

const DEFAULT_MAX_FILES = Number.parseInt(process.env.CODE_SEARCH_MAX_FILES || '5000', 10);
const DEFAULT_MAX_FILE_SIZE = Number.parseInt(process.env.CODE_SEARCH_MAX_FILE_SIZE || String(512 * 1024), 10);
const DEFAULT_STORAGE_ROOT = path.resolve(process.cwd(), '.data', 'code-index');
const DEFAULT_ALLOWED_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx',
  '.py',
  '.go',
  '.java',
  '.rb',
  '.rs',
  '.c', '.cc', '.cpp', '.cxx',
  '.h', '.hpp',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'target',
  'out',
]);

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function hashContent(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createRepoId(repoName, rootPath) {
  const slug = String(repoName || path.basename(rootPath) || 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'repo';

  const suffix = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 10);
  return `${slug}-${suffix}`;
}

function sortTreeNode(node) {
  if (!node.children) return node;
  node.children.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const child of node.children) sortTreeNode(child);
  return node;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreTextMatch(query, symbol) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

  const haystacks = [
    symbol.name,
    symbol.qualifiedName,
    symbol.signature,
    symbol.summary,
    symbol.filePath,
    symbol.source.slice(0, 800),
  ].map((value) => normalizeText(value || ''));

  let score = 0;
  for (const haystack of haystacks) {
    if (!haystack) continue;
    if (haystack === normalizedQuery) score += 10;
    if (haystack.startsWith(normalizedQuery)) score += 6;
    if (haystack.includes(normalizedQuery)) score += 4;
  }

  for (const token of normalizedQuery.split(' ')) {
    if (token.length < 2) continue;
    for (const haystack of haystacks) {
      if (haystack.includes(token)) score += 1;
    }
  }

  return score;
}

function createPreview(source, query = '') {
  const snippet = source.trim().slice(0, 240);
  if (!query) return snippet;

  const regex = new RegExp(escapeRegExp(query), 'i');
  const match = source.match(regex);
  if (!match || match.index == null) return snippet;

  const start = Math.max(0, match.index - 80);
  const end = Math.min(source.length, match.index + query.length + 120);
  return source.slice(start, end).trim();
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export class CodeIndexService {
  constructor({
    storageRoot = process.env.CODE_SEARCH_INDEX_ROOT || DEFAULT_STORAGE_ROOT,
    allowedRoots = null,
    vectorStoreFactory = null,
    maxFiles = DEFAULT_MAX_FILES,
    maxFileSize = DEFAULT_MAX_FILE_SIZE,
    embeddingDimension = EMBEDDING_DIMENSION,
  } = {}) {
    this.storageRoot = path.resolve(storageRoot);
    const defaultRoots = process.env.CODE_SEARCH_ALLOWED_ROOTS
      ? process.env.CODE_SEARCH_ALLOWED_ROOTS.split(',')
      : [process.cwd(), path.resolve(process.cwd(), '..')];
    if (process.env.REPOS_BASE_DIR) defaultRoots.push(process.env.REPOS_BASE_DIR);
    this.allowedRoots = (allowedRoots || Array.from(new Set(defaultRoots)))
      .map((root) => path.resolve(root.trim()))
      .filter(Boolean);
    this.maxFiles = maxFiles;
    this.maxFileSize = maxFileSize;
    this.embeddingDimension = embeddingDimension;
    this.vectorStoreFactory = vectorStoreFactory || (() => createVectorStore({
      rootDir: path.join(this.storageRoot, 'vectors'),
      dimension: this.embeddingDimension,
    }));
    this.vectorStorePromise = null;
  }

  async getVectorStore() {
    if (!this.vectorStorePromise) {
      this.vectorStorePromise = this.vectorStoreFactory();
    }
    return this.vectorStorePromise;
  }

  isPathAllowed(targetPath) {
    return this.allowedRoots.some((root) => {
      const relative = path.relative(root, targetPath);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  }

  async resolveInputFolder(folderPath) {
    const direct = path.resolve(folderPath);
    if (await pathExists(direct)) return direct;

    if (!path.isAbsolute(folderPath)) {
      const parentRelative = path.resolve(process.cwd(), '..', folderPath);
      if (await pathExists(parentRelative)) return parentRelative;
    }

    return direct;
  }

  async ensureStorageRoot() {
    await fs.mkdir(this.storageRoot, { recursive: true });
  }

  repoDir(repoId) {
    return path.join(this.storageRoot, repoId);
  }

  repoIndexPath(repoId) {
    return path.join(this.repoDir(repoId), 'index.json');
  }

  async listRepoIds() {
    await this.ensureStorageRoot();
    const entries = await fs.readdir(this.storageRoot, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'vectors')
      .map((entry) => entry.name)
      .sort();
  }

  async loadRepo(repoId) {
    const filePath = this.repoIndexPath(repoId);
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  async saveRepo(repo) {
    const repoDirectory = this.repoDir(repo.repo.id);
    await fs.mkdir(repoDirectory, { recursive: true });
    await fs.writeFile(this.repoIndexPath(repo.repo.id), JSON.stringify(repo, null, 2));
  }

  async discoverFiles(rootPath, { maxFiles = this.maxFiles, maxFileSize = this.maxFileSize } = {}) {
    const results = [];
    const skipped = {
      ignoredDirectory: 0,
      unsupportedExtension: 0,
      tooLarge: 0,
      symlink: 0,
    };
    const queue = [rootPath];

    while (queue.length > 0) {
      const current = queue.pop();
      const entries = await fs.readdir(current, { withFileTypes: true });

      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        const relativePath = toPosixPath(path.relative(rootPath, absolutePath));

        if (entry.isSymbolicLink()) {
          skipped.symlink += 1;
          continue;
        }

        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) {
            skipped.ignoredDirectory += 1;
            continue;
          }
          queue.push(absolutePath);
          continue;
        }

        if (!entry.isFile()) continue;

        const extension = path.extname(entry.name).toLowerCase();
        if (!DEFAULT_ALLOWED_EXTENSIONS.has(extension)) {
          skipped.unsupportedExtension += 1;
          continue;
        }

        const stat = await fs.stat(absolutePath);
        if (stat.size > maxFileSize) {
          skipped.tooLarge += 1;
          continue;
        }

        results.push({
          absolutePath,
          relativePath,
          size: stat.size,
        });

        if (results.length >= maxFiles) {
          return {
            files: results.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
            skipped,
            truncated: true,
          };
        }
      }
    }

    return {
      files: results.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      skipped,
      truncated: false,
    };
  }

  buildSymbolRecord(fileRecord, symbol) {
    const id = `${fileRecord.path}::${symbol.qualifiedName}#${symbol.kind}`;
    const sourceHash = hashContent(symbol.source);

    return {
      id,
      filePath: fileRecord.path,
      language: fileRecord.language,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      signature: symbol.signature,
      summary: symbol.summary,
      parentName: symbol.parentName || null,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      lineCount: symbol.endLine - symbol.startLine + 1,
      source: symbol.source,
      sourceHash,
    };
  }

  createEmbeddingText(symbol) {
    return [
      symbol.qualifiedName,
      symbol.kind,
      symbol.signature,
      symbol.summary,
      symbol.filePath,
      symbol.source.slice(0, 1200),
    ]
      .filter(Boolean)
      .join('\n');
  }

  async indexFolder({
    folderPath,
    repoName = null,
    maxFiles = this.maxFiles,
    maxFileSize = this.maxFileSize,
  }) {
    await this.ensureStorageRoot();

    const absoluteRoot = await this.resolveInputFolder(folderPath);
    if (!this.isPathAllowed(absoluteRoot)) {
      throw new Error(`Path "${absoluteRoot}" is outside allowed roots`);
    }

    const stat = await fs.stat(absoluteRoot).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Folder "${absoluteRoot}" does not exist or is not a directory`);
    }

    const safeRepoName = repoName || path.basename(absoluteRoot);
    const repoId = createRepoId(safeRepoName, absoluteRoot);
    const repoDirectory = this.repoDir(repoId);

    await fs.rm(repoDirectory, { recursive: true, force: true });

    const discovery = await this.discoverFiles(absoluteRoot, { maxFiles, maxFileSize });
    const symbols = [];
    const files = [];
    const vectorDocs = [];

    for (const file of discovery.files) {
      const content = await fs.readFile(file.absolutePath, 'utf8');
      const { language, symbols: extracted } = extractSymbolsFromContent(file.relativePath, content);

      const fileRecord = {
        path: file.relativePath,
        language,
        size: file.size,
        contentHash: hashContent(content),
        symbolIds: [],
      };

      for (const symbol of extracted) {
        const symbolRecord = this.buildSymbolRecord(fileRecord, symbol);
        fileRecord.symbolIds.push(symbolRecord.id);
        symbols.push(symbolRecord);
        vectorDocs.push({
          id: symbolRecord.id,
          vector: createHashedEmbedding(this.createEmbeddingText(symbolRecord), this.embeddingDimension),
          fields: {
            kind: symbolRecord.kind,
            filePath: symbolRecord.filePath,
          },
        });
      }

      files.push(fileRecord);
    }

    const vectorStore = await this.getVectorStore();
    await vectorStore.resetCollection(repoId);
    if (vectorDocs.length > 0) {
      await vectorStore.upsert(repoId, vectorDocs);
    }

    const repo = {
      repo: {
        id: repoId,
        name: safeRepoName,
        rootPath: absoluteRoot,
        indexedAt: new Date().toISOString(),
        filesIndexed: files.length,
        symbolsIndexed: symbols.length,
        filesWithoutSymbols: files.filter((file) => file.symbolIds.length === 0).length,
        vectorBackend: vectorStore.backend,
      },
      stats: {
        skipped: discovery.skipped,
        truncated: discovery.truncated,
      },
      files,
      symbols,
    };

    await this.saveRepo(repo);
    return repo.repo;
  }

  async listRepos() {
    const repoIds = await this.listRepoIds();
    const repos = [];

    for (const repoId of repoIds) {
      const repo = await this.loadRepo(repoId).catch(() => null);
      if (repo?.repo) repos.push(repo.repo);
    }

    return repos.sort((left, right) => right.indexedAt.localeCompare(left.indexedAt));
  }

  async getRepoSummary(repoId) {
    const repo = await this.loadRepo(repoId);
    const byKind = {};
    const byLanguage = {};

    for (const symbol of repo.symbols) {
      byKind[symbol.kind] = (byKind[symbol.kind] || 0) + 1;
      byLanguage[symbol.language] = (byLanguage[symbol.language] || 0) + 1;
    }

    return {
      ...repo.repo,
      counts: {
        files: repo.files.length,
        symbols: repo.symbols.length,
        byKind,
        byLanguage,
      },
      filesWithoutSymbols: repo.files
        .filter((file) => file.symbolIds.length === 0)
        .map((file) => file.path),
      stats: repo.stats,
    };
  }

  async getFileTree(repoId) {
    const repo = await this.loadRepo(repoId);
    const root = {
      name: repo.repo.name,
      path: '',
      type: 'directory',
      children: [],
    };

    for (const file of repo.files) {
      const parts = file.path.split('/');
      let cursor = root;
      let currentPath = '';

      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const isLeaf = index === parts.length - 1;
        let next = cursor.children.find((child) => child.name === part);

        if (!next) {
          next = {
            name: part,
            path: currentPath,
            type: isLeaf ? 'file' : 'directory',
          };
          if (!isLeaf) next.children = [];
          cursor.children.push(next);
        }

        if (isLeaf) {
          next.language = file.language;
          next.symbolCount = file.symbolIds.length;
          next.size = file.size;
        } else {
          cursor = next;
        }
      }
    }

    return sortTreeNode(root);
  }

  async getFileOutline(repoId, filePath) {
    const repo = await this.loadRepo(repoId);
    const normalizedPath = toPosixPath(filePath);
    const file = repo.files.find((entry) => entry.path === normalizedPath);
    if (!file) {
      throw new Error(`File "${normalizedPath}" not found in repo "${repoId}"`);
    }

    return {
      repo: repo.repo,
      file,
      symbols: repo.symbols.filter((symbol) => symbol.filePath === normalizedPath),
    };
  }

  async getSymbol(repoId, symbolId, { verify = false, contextLines = 0 } = {}) {
    const repo = await this.loadRepo(repoId);
    const symbol = repo.symbols.find((entry) => entry.id === symbolId);
    if (!symbol) {
      throw new Error(`Symbol "${symbolId}" not found in repo "${repoId}"`);
    }

    const response = {
      ...symbol,
      repo: repo.repo,
      driftDetected: false,
    };

    if (!verify && contextLines === 0) {
      return response;
    }

    const absolutePath = path.resolve(repo.repo.rootPath, symbol.filePath);
    const currentFile = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (!currentFile) {
      response.liveSourceAvailable = false;
      return response;
    }

    const lines = currentFile.replace(/\r\n/g, '\n').split('\n');
    const startLine = Math.max(1, symbol.startLine - contextLines);
    const endLine = Math.min(lines.length, symbol.endLine + contextLines);
    const currentSource = lines.slice(startLine - 1, endLine).join('\n').trimEnd();
    const exactCurrentSource = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n').trimEnd();

    response.liveSourceAvailable = true;
    response.currentSource = currentSource;
    response.driftDetected = verify ? hashContent(exactCurrentSource) !== symbol.sourceHash : false;

    return response;
  }

  async searchSymbols(repoId, { query, kind = null, topK = 10 } = {}) {
    const repo = await this.loadRepo(repoId);
    return repo.symbols
      .filter((symbol) => !kind || symbol.kind === kind)
      .map((symbol) => ({
        ...symbol,
        score: scoreTextMatch(query, symbol),
      }))
      .filter((symbol) => symbol.score > 0)
      .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath))
      .slice(0, topK)
      .map((symbol) => ({
        id: symbol.id,
        filePath: symbol.filePath,
        kind: symbol.kind,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        summary: symbol.summary,
        score: symbol.score,
        preview: createPreview(symbol.source, query),
      }));
  }

  async searchText(repoId, { query, topK = 10 } = {}) {
    const repo = await this.loadRepo(repoId);
    const normalizedQuery = normalizeText(query);

    return repo.symbols
      .map((symbol) => {
        const haystack = normalizeText(`${symbol.signature}\n${symbol.summary}\n${symbol.source}`);
        const occurrences = normalizedQuery ? haystack.split(normalizedQuery).length - 1 : 0;
        return {
          symbol,
          score: occurrences,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map(({ symbol, score }) => ({
        id: symbol.id,
        filePath: symbol.filePath,
        kind: symbol.kind,
        qualifiedName: symbol.qualifiedName,
        score,
        preview: createPreview(symbol.source, query),
      }));
  }

  async searchSemantic(repoId, { query, topK = 10 } = {}) {
    const repo = await this.loadRepo(repoId);
    const vectorStore = await this.getVectorStore();
    const queryVector = createHashedEmbedding(query, this.embeddingDimension);
    const vectorMatches = await vectorStore.query(repoId, queryVector, Math.max(topK * 3, topK));
    const lexicalScores = new Map(repo.symbols.map((symbol) => [symbol.id, scoreTextMatch(query, symbol)]));
    const symbolById = new Map(repo.symbols.map((symbol) => [symbol.id, symbol]));

    return vectorMatches
      .map((match) => {
        const symbol = symbolById.get(match.id);
        if (!symbol) return null;

        const lexicalScore = lexicalScores.get(match.id) || 0;
        return {
          id: symbol.id,
          filePath: symbol.filePath,
          kind: symbol.kind,
          qualifiedName: symbol.qualifiedName,
          signature: symbol.signature,
          summary: symbol.summary,
          vectorScore: Number(match.score.toFixed(6)),
          score: Number((match.score + lexicalScore * 0.05).toFixed(6)),
          preview: createPreview(symbol.source, query),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }

  async invalidate(repoId) {
    const vectorStore = await this.getVectorStore();
    await vectorStore.resetCollection(repoId);
    await fs.rm(this.repoDir(repoId), { recursive: true, force: true });
    return { success: true };
  }
}