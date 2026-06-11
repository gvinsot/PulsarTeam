import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { createHashedEmbedding, EMBEDDING_DIMENSION, normalizeText } from './codeSearch/embedding.js';
import { extractSymbolsFromContent } from './codeSearch/symbolExtractor.js';
import { createVectorStore } from './codeSearch/vectorStore.js';

function parsePositiveInt(rawValue, fallback) {
  if (rawValue == null || rawValue === '') return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`Code index: ignoring invalid limit "${rawValue}", using default ${fallback}`);
  return fallback;
}

const DEFAULT_MAX_FILES = parsePositiveInt(process.env.CODE_SEARCH_MAX_FILES, 5000);
const DEFAULT_MAX_FILE_SIZE = parsePositiveInt(process.env.CODE_SEARCH_MAX_FILE_SIZE, 512 * 1024);
const DEFAULT_STORAGE_ROOT = path.resolve(process.cwd(), '.data', 'code-index');
const REPO_CACHE_TTL_MS = 60_000;
const FILE_IO_CONCURRENCY = 32;
const MAX_STORED_SOURCE_LENGTH = 16384;
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
  storageRoot: string;
  allowedRoots: string[];
  maxFiles: number;
  maxFileSize: number;
  embeddingDimension: number;
  vectorStoreFactory: () => any;
  vectorStorePromise: Promise<any> | null;
  _repoCache: Map<string, any>;
  _repoLocks: Map<string, Promise<any>>;
  _memoryVectorRebuilds: Map<string, Promise<void>>;

  constructor({
    storageRoot = process.env.CODE_SEARCH_INDEX_ROOT || DEFAULT_STORAGE_ROOT,
    allowedRoots = null,
    vectorStoreFactory = null,
    maxFiles = DEFAULT_MAX_FILES,
    maxFileSize = DEFAULT_MAX_FILE_SIZE,
    embeddingDimension = EMBEDDING_DIMENSION,
  }: {
    storageRoot?: string;
    allowedRoots?: string[] | null;
    vectorStoreFactory?: (() => any) | null;
    maxFiles?: number;
    maxFileSize?: number;
    embeddingDimension?: number;
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
    this._repoCache = new Map();
    this._repoLocks = new Map();
    this._memoryVectorRebuilds = new Map();
  }

  _withRepoLock(repoId, task) {
    const previous = this._repoLocks.get(repoId) || Promise.resolve();
    const run = previous.then(() => task());
    const tail = run.catch(() => {});
    this._repoLocks.set(repoId, tail);
    tail.then(() => {
      if (this._repoLocks.get(repoId) === tail) this._repoLocks.delete(repoId);
    });
    return run;
  }

  _getCachedRepo(repoId) {
    const entry = this._repoCache.get(repoId);
    if (entry && Date.now() - entry.ts < REPO_CACHE_TTL_MS) return entry.data;
    if (entry) this._repoCache.delete(repoId);
    return null;
  }

  _setCachedRepo(repoId, data) {
    this._repoCache.set(repoId, { data, ts: Date.now() });
    const timer = setTimeout(() => {
      const entry = this._repoCache.get(repoId);
      if (entry && Date.now() - entry.ts >= REPO_CACHE_TTL_MS) this._repoCache.delete(repoId);
    }, REPO_CACHE_TTL_MS + 1000);
    timer.unref?.();
  }

  _invalidateCache(repoId) {
    if (repoId) this._repoCache.delete(repoId);
    else this._repoCache.clear();
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
    const cached = this._getCachedRepo(repoId);
    if (cached) return cached;
    const filePath = this.repoIndexPath(repoId);
    const raw = await fs.readFile(filePath, 'utf8');
    let repo;
    try {
      repo = JSON.parse(raw);
    } catch (error) {
      console.error(`Code index: corrupt index file for repo "${repoId}" at ${filePath}: ${error.message}`);
      throw error;
    }
    this._setCachedRepo(repoId, repo);
    return repo;
  }

  async saveRepo(repo) {
    const repoDirectory = this.repoDir(repo.repo.id);
    await fs.mkdir(repoDirectory, { recursive: true });
    const indexPath = this.repoIndexPath(repo.repo.id);
    const tempPath = `${indexPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(repo));
      await fs.rename(tempPath, indexPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async discoverFiles(rootPath, { maxFiles = this.maxFiles, maxFileSize = this.maxFileSize } = {}) {
    const results = [];
    const skipped = {
      ignoredDirectory: 0,
      unsupportedExtension: 0,
      tooLarge: 0,
      symlink: 0,
      unreadableDirectory: 0,
    };
    const queue = [rootPath];
    let truncated = false;

    while (queue.length > 0 && !truncated) {
      const current = queue.pop();
      const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
        // An unreadable root would otherwise produce an empty index that replaces a good one
        if (current === rootPath) throw error;
        skipped.unreadableDirectory += 1;
        return [];
      });

      const fileCandidates = [];
      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);

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

        fileCandidates.push({
          absolutePath,
          relativePath: toPosixPath(path.relative(rootPath, absolutePath)),
        });
      }

      // Batch stat calls in parallel
      for (let i = 0; i < fileCandidates.length && !truncated; i += FILE_IO_CONCURRENCY) {
        const batch = fileCandidates.slice(i, i + FILE_IO_CONCURRENCY);
        const stats = await Promise.all(
          batch.map((f) => fs.stat(f.absolutePath).catch(() => null))
        );
        for (let j = 0; j < batch.length; j++) {
          const stat = stats[j];
          if (!stat) continue;
          if (stat.size > maxFileSize) {
            skipped.tooLarge += 1;
            continue;
          }
          results.push({
            absolutePath: batch[j].absolutePath,
            relativePath: batch[j].relativePath,
            size: stat.size,
          });
          if (results.length >= maxFiles) {
            truncated = true;
            break;
          }
        }
      }
    }

    return {
      files: results.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      skipped,
      truncated,
    };
  }

  buildSymbolRecord(fileRecord, symbol) {
    const id = `${fileRecord.path}::${symbol.qualifiedName}#${symbol.kind}`;
    // Hash the full source so drift verification stays correct even when storage is truncated
    const sourceHash = hashContent(symbol.source);
    const sourceTruncated = symbol.source.length > MAX_STORED_SOURCE_LENGTH;

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
      source: sourceTruncated ? symbol.source.slice(0, MAX_STORED_SOURCE_LENGTH) : symbol.source,
      sourceHash,
      sourceTruncated,
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

    return this._withRepoLock(repoId, () => this._indexFolderLocked({
      absoluteRoot,
      safeRepoName,
      repoId,
      maxFiles,
      maxFileSize,
    }));
  }

  async _indexFolderLocked({ absoluteRoot, safeRepoName, repoId, maxFiles, maxFileSize }) {
    const discovery = await this.discoverFiles(absoluteRoot, { maxFiles, maxFileSize });
    const symbols = [];
    const files = [];
    const vectorDocs = [];

    // Read and parse files in parallel batches
    for (let i = 0; i < discovery.files.length; i += FILE_IO_CONCURRENCY) {
      const batch = discovery.files.slice(i, i + FILE_IO_CONCURRENCY);
      const contents = await Promise.all(
        batch.map((f) => fs.readFile(f.absolutePath, 'utf8').catch(() => null))
      );

      for (let j = 0; j < batch.length; j++) {
        const content = contents[j];
        if (content === null) continue;
        const file = batch[j];
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

      // Let the event loop breathe between parse batches — extraction is CPU-bound
      await new Promise((resolve) => setImmediate(resolve));
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
    this._invalidateCache(repoId);
    this._setCachedRepo(repoId, repo);
    this._memoryVectorRebuilds.delete(repoId);
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

    if (!verify && contextLines === 0 && !symbol.sourceTruncated) {
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

    if (symbol.sourceTruncated && hashContent(exactCurrentSource) === symbol.sourceHash) {
      response.source = exactCurrentSource;
      response.sourceTruncated = false;
    }

    response.liveSourceAvailable = true;
    response.currentSource = currentSource;
    response.driftDetected = verify ? hashContent(exactCurrentSource) !== symbol.sourceHash : false;

    return response;
  }

  async searchSymbols(repoId: string, { query, kind = null, topK = 10 }: { query: string; kind?: string | null; topK?: number } = { query: '' }) {
    const repo = await this.loadRepo(repoId);
    const scored = [];
    for (const symbol of repo.symbols) {
      if (kind && symbol.kind !== kind) continue;
      const score = scoreTextMatch(query, symbol);
      if (score > 0) scored.push({ symbol, score });
    }

    scored.sort((left, right) => right.score - left.score || left.symbol.filePath.localeCompare(right.symbol.filePath));

    return scored
      .slice(0, topK)
      .map(({ symbol, score }) => ({
        id: symbol.id,
        filePath: symbol.filePath,
        kind: symbol.kind,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        summary: symbol.summary,
        score,
        preview: createPreview(symbol.source, query),
      }));
  }

  async searchText(repoId: string, { query, topK = 10 }: { query: string; topK?: number } = { query: '' }) {
    const repo = await this.loadRepo(repoId);
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return [];

    const scored = [];
    for (const symbol of repo.symbols) {
      const haystack = normalizeText(`${symbol.signature}\n${symbol.summary}\n${symbol.source}`);
      const occurrences = haystack.split(normalizedQuery).length - 1;
      if (occurrences > 0) {
        scored.push({ symbol, score: occurrences });
      }
    }

    scored.sort((left, right) => right.score - left.score);

    return scored
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

  // The in-memory vector backend loses its collections on restart while index.json
  // persists — rebuild the collection from stored symbols when it falls out of sync.
  async _ensureMemoryVectors(repoId, repo, vectorStore) {
    if (typeof vectorStore.backend !== 'string' || !vectorStore.backend.startsWith('memory')) return;
    if (!Array.isArray(repo.symbols) || repo.symbols.length === 0) return;
    const collectionSize = vectorStore.collections?.get(repoId)?.size ?? 0;
    if (collectionSize >= repo.symbols.length) return;

    let rebuild = this._memoryVectorRebuilds.get(repoId);
    if (!rebuild) {
      rebuild = (async () => {
        console.info(`Code index: rebuilding in-memory vectors for repo "${repoId}" (${repo.symbols.length} symbols)`);
        const docs = repo.symbols.map((symbol) => ({
          id: symbol.id,
          vector: createHashedEmbedding(this.createEmbeddingText(symbol), this.embeddingDimension),
          fields: {
            kind: symbol.kind,
            filePath: symbol.filePath,
          },
        }));
        await vectorStore.upsert(repoId, docs);
      })();
      this._memoryVectorRebuilds.set(repoId, rebuild);
      rebuild.catch(() => this._memoryVectorRebuilds.delete(repoId));
    }
    await rebuild;
  }

  async searchSemantic(repoId: string, { query, topK = 10 }: { query: string; topK?: number } = { query: '' }) {
    const [repo, vectorStore] = await Promise.all([
      this.loadRepo(repoId),
      this.getVectorStore(),
    ]);
    await this._ensureMemoryVectors(repoId, repo, vectorStore);
    const queryVector = createHashedEmbedding(query, this.embeddingDimension);
    const vectorMatches = await vectorStore.query(repoId, queryVector, topK * 3);

    // Build symbol lookup only for matched IDs
    const matchedIds = new Set(vectorMatches.map((m) => m.id));
    const symbolById = new Map();
    for (const symbol of repo.symbols) {
      if (matchedIds.has(symbol.id)) symbolById.set(symbol.id, symbol);
    }

    const results = [];
    for (const match of vectorMatches) {
      const symbol = symbolById.get(match.id);
      if (!symbol) continue;
      const lexicalScore = scoreTextMatch(query, symbol);
      results.push({
        id: symbol.id,
        filePath: symbol.filePath,
        kind: symbol.kind,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        summary: symbol.summary,
        vectorScore: Number(match.score.toFixed(6)),
        score: Number((match.score + lexicalScore * 0.05).toFixed(6)),
        preview: createPreview(symbol.source, query),
      });
    }

    results.sort((left, right) => right.score - left.score);
    return results.slice(0, topK);
  }

  /**
   * Incrementally update one or more files in an existing index.
   * Much faster than a full re-index — only touches the changed files.
   * @param {string} repoId - The repo to update
   * @param {{ path: string, content?: string }[]} fileEntries - Files to update.
   *   Each entry has a relative `path` (posix-style). If `content` is provided,
   *   it is used directly; otherwise the file is read from disk using the repo rootPath.
   * @returns {{ updated: number, removed: number, added: number }}
   */
  async updateFiles(repoId, fileEntries) {
    return this._withRepoLock(repoId, () => this._updateFilesLocked(repoId, fileEntries));
  }

  async _updateFilesLocked(repoId, fileEntries) {
    try {
      return await this._applyFileUpdates(repoId, fileEntries);
    } catch (error) {
      // The cached repo object may hold half-applied mutations — force a reload from disk
      this._invalidateCache(repoId);
      throw error;
    }
  }

  async _applyFileUpdates(repoId, fileEntries) {
    const repo = await this.loadRepo(repoId);
    const rootPath = repo.repo.rootPath;
    const vectorStore = await this.getVectorStore();

    let updated = 0;
    let removed = 0;
    let added = 0;

    for (const entry of fileEntries) {
      const filePath = toPosixPath(entry.path);
      const extension = path.extname(filePath).toLowerCase();

      // Remove old file data
      const oldFileIdx = repo.files.findIndex(f => f.path === filePath);
      const oldSymbolIds = oldFileIdx >= 0 ? repo.files[oldFileIdx].symbolIds : [];
      if (oldFileIdx >= 0) {
        repo.files.splice(oldFileIdx, 1);
      }
      // Remove old symbols
      repo.symbols = repo.symbols.filter(s => s.filePath !== filePath);
      // Remove old vectors
      if (oldSymbolIds.length > 0) {
        await vectorStore.remove(repoId, oldSymbolIds).catch(() => {});
      }

      // Get content: use provided content or read from disk
      let content = entry.content ?? null;
      let fileSize;
      if (content === null) {
        const absolutePath = path.resolve(rootPath, filePath);
        content = await fs.readFile(absolutePath, 'utf8').catch(() => null);
        const stat = content ? await fs.stat(absolutePath).catch(() => null) : null;
        fileSize = stat?.size ?? (content ? Buffer.byteLength(content) : 0);
        if (!stat || stat.size > this.maxFileSize) {
          if (oldFileIdx >= 0) removed++;
          continue;
        }
      } else {
        fileSize = Buffer.byteLength(content);
      }

      if (!content || !DEFAULT_ALLOWED_EXTENSIONS.has(extension)) {
        if (oldFileIdx >= 0) removed++;
        continue;
      }

      if (fileSize > this.maxFileSize) {
        if (oldFileIdx >= 0) removed++;
        continue;
      }

      // Extract symbols from updated content
      const { language, symbols: extracted } = extractSymbolsFromContent(filePath, content);
      const fileRecord = {
        path: filePath,
        language,
        size: fileSize,
        contentHash: hashContent(content),
        symbolIds: [],
      };

      const vectorDocs = [];
      for (const symbol of extracted) {
        const symbolRecord = this.buildSymbolRecord(fileRecord, symbol);
        fileRecord.symbolIds.push(symbolRecord.id);
        repo.symbols.push(symbolRecord);
        vectorDocs.push({
          id: symbolRecord.id,
          vector: createHashedEmbedding(this.createEmbeddingText(symbolRecord), this.embeddingDimension),
          fields: {
            kind: symbolRecord.kind,
            filePath: symbolRecord.filePath,
          },
        });
      }

      repo.files.push(fileRecord);
      if (vectorDocs.length > 0) {
        await vectorStore.upsert(repoId, vectorDocs);
      }

      if (oldFileIdx >= 0) updated++;
      else added++;
    }

    // Update repo metadata
    repo.repo.filesIndexed = repo.files.length;
    repo.repo.symbolsIndexed = repo.symbols.length;
    repo.repo.filesWithoutSymbols = repo.files.filter(f => f.symbolIds.length === 0).length;
    repo.repo.lastUpdatedAt = new Date().toISOString();

    await this.saveRepo(repo);
    this._invalidateCache(repoId);
    this._setCachedRepo(repoId, repo);

    return { updated, removed, added };
  }

  /**
   * Find indexed repos matching a project name.
   * @param {string} projectName
   * @returns {Promise<Array<{ id: string, name: string, rootPath: string }>>}
   */
  async findReposByProject(projectName) {
    const repos = await this.listRepos();
    const normalizedName = projectName.toLowerCase();
    return repos.filter(r => r.name.toLowerCase() === normalizedName);
  }

  async invalidate(repoId) {
    return this._withRepoLock(repoId, async () => {
      this._invalidateCache(repoId);
      this._memoryVectorRebuilds.delete(repoId);
      const vectorStore = await this.getVectorStore();
      await vectorStore.resetCollection(repoId);
      await fs.rm(this.repoDir(repoId), { recursive: true, force: true });
      return { success: true };
    });
  }
}