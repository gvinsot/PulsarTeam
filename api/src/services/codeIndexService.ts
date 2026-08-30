import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  createHashedEmbedding,
  EMBEDDING_DIMENSION,
  normalizeText,
} from './codeSearch/embedding.js';
import { extractSymbolsFromContent, type ExtractedSymbol } from './codeSearch/symbolExtractor.js';
import { createVectorStore } from './codeSearch/vectorStore.js';
import { errorMessage } from '../lib/errors.js';

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
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
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.java',
  '.rb',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
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

/** A file kept by discoverFiles, after its stat call succeeded. */
interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

/** The `repo` header stored in every index file, and the shape listRepos returns. */
interface RepoInfo {
  id: string;
  name: string;
  rootPath: string;
  indexedAt: string;
  filesIndexed: number;
  symbolsIndexed: number;
  filesWithoutSymbols: number;
  vectorBackend: string;
  /** Only present on repos that went through an incremental updateFiles pass. */
  lastUpdatedAt?: string;
}

/** One entry of `files` in an index (built by _indexFileContent). */
interface FileRecord {
  path: string;
  language: string;
  size: number;
  contentHash: string;
  symbolIds: string[];
}

/** One entry of `symbols` in an index (built by buildSymbolRecord). */
interface SymbolRecord {
  id: string;
  filePath: string;
  language: string;
  name: string;
  qualifiedName: string;
  kind: string;
  signature: string;
  summary: string;
  parentName: string | null;
  startLine: number;
  endLine: number;
  lineCount: number;
  source: string;
  sourceHash: string;
  sourceTruncated: boolean;
}

/** Document handed to the vector store for one symbol (mirrors its VectorDoc shape). */
interface SymbolVectorDoc {
  id: string;
  vector: number[];
  fields: { kind: string; filePath: string };
}

/** A node of the tree built by getFileTree: `children` is set on directories only. */
interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  language?: string;
  symbolCount?: number;
  size?: number;
}

/** A symbol kept by the lexical searches, with the score that selected it. */
interface ScoredSymbol {
  symbol: SymbolRecord;
  score: number;
}

/** Why discoverFiles left an entry out — counters only, stored under `stats`. */
interface SkipCounts {
  ignoredDirectory: number;
  unsupportedExtension: number;
  tooLarge: number;
  symlink: number;
  unreadableDirectory: number;
}

/**
 * The whole `index.json` document: what saveIndex writes and what loadIndex
 * reads back. The file is written by this class alone, so the parse result is
 * taken at this shape rather than re-validated at every read.
 */
interface RepoIndex {
  repo: RepoInfo;
  stats: { skipped: SkipCounts; truncated: boolean };
  files: FileRecord[];
  symbols: SymbolRecord[];
}

/**
 * What getSymbol returns: the stored record plus its repo header. The three live
 * fields are only filled in on the path that re-reads the file from disk, so a
 * cheap lookup (no verify, no context, untruncated source) returns without them.
 */
interface SymbolDetail extends SymbolRecord {
  repo: RepoInfo;
  driftDetected: boolean;
  liveSourceAvailable?: boolean;
  currentSource?: string;
}

/** The score bag folded into a hit by toSearchHit; `vectorScore` is semantic-only. */
interface SearchScores {
  score: number;
  vectorScore?: number;
}

/** Whatever `createVectorStore` hands back — the in-memory or the zvec backend. */
type VectorStore = Awaited<ReturnType<typeof createVectorStore>>;

/** One file to re-index incrementally; `content` short-circuits the disk read. */
interface FileUpdateEntry {
  path: string;
  content?: string | null;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function hashContent(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createRepoId(repoName: string, rootPath: string): string {
  const slug =
    String(repoName || path.basename(rootPath) || 'repo')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'repo';

  const suffix = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 10);
  return `${slug}-${suffix}`;
}

// Generic so the caller keeps whatever it passed in — getFileTree hands over a
// node whose `children` is known to exist, and must get that same type back.
function sortTreeNode<T extends FileTreeNode>(node: T): T {
  if (!node.children) return node;
  node.children.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const child of node.children) sortTreeNode(child);
  return node;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreTextMatch(query: string, symbol: SymbolRecord): number {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

  const haystacks = [
    symbol.name,
    symbol.qualifiedName,
    symbol.signature,
    symbol.summary,
    symbol.filePath,
    symbol.source.slice(0, 800),
  ].map(value => normalizeText(value || ''));

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

function createPreview(source: string, query = '') {
  const snippet = source.trim().slice(0, 240);
  if (!query) return snippet;

  const regex = new RegExp(escapeRegExp(query), 'i');
  const match = source.match(regex);
  if (!match || match.index == null) return snippet;

  const start = Math.max(0, match.index - 80);
  const end = Math.min(source.length, match.index + query.length + 120);
  return source.slice(start, end).trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toSearchHit(
  symbol: SymbolRecord,
  query: string,
  scores: SearchScores,
  { withDoc = true }: { withDoc?: boolean } = {}
) {
  return {
    id: symbol.id,
    filePath: symbol.filePath,
    kind: symbol.kind,
    qualifiedName: symbol.qualifiedName,
    ...(withDoc ? { signature: symbol.signature, summary: symbol.summary } : {}),
    ...scores,
    preview: createPreview(symbol.source, query),
  };
}

export class CodeIndexService {
  storageRoot: string;
  allowedRoots: string[];
  maxFiles: number;
  maxFileSize: number;
  embeddingDimension: number;
  vectorStoreFactory: () => VectorStore | Promise<VectorStore>;
  vectorStorePromise: Promise<VectorStore> | VectorStore | null;
  _repoCache: Map<string, { data: RepoIndex; ts: number }>;
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
    vectorStoreFactory?: (() => VectorStore | Promise<VectorStore>) | null;
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
      .map(root => path.resolve(root.trim()))
      .filter(Boolean);
    this.maxFiles = maxFiles;
    this.maxFileSize = maxFileSize;
    this.embeddingDimension = embeddingDimension;
    this.vectorStoreFactory =
      vectorStoreFactory ||
      (() =>
        createVectorStore({
          rootDir: path.join(this.storageRoot, 'vectors'),
          dimension: this.embeddingDimension,
        }));
    this.vectorStorePromise = null;
    this._repoCache = new Map();
    this._repoLocks = new Map();
    this._memoryVectorRebuilds = new Map();
  }

  _withRepoLock<T>(repoId: string, task: () => Promise<T>): Promise<T> {
    const previous = this._repoLocks.get(repoId) || Promise.resolve();
    const run = previous.then(() => task());
    const tail = run.catch(() => {});
    this._repoLocks.set(repoId, tail);
    tail.then(() => {
      if (this._repoLocks.get(repoId) === tail) this._repoLocks.delete(repoId);
    });
    return run;
  }

  _getCachedRepo(repoId: string) {
    const entry = this._repoCache.get(repoId);
    if (entry && Date.now() - entry.ts < REPO_CACHE_TTL_MS) return entry.data;
    if (entry) this._repoCache.delete(repoId);
    return null;
  }

  _setCachedRepo(repoId: string, data: RepoIndex) {
    this._repoCache.set(repoId, { data, ts: Date.now() });
    const timer = setTimeout(() => {
      const entry = this._repoCache.get(repoId);
      if (entry && Date.now() - entry.ts >= REPO_CACHE_TTL_MS) this._repoCache.delete(repoId);
    }, REPO_CACHE_TTL_MS + 1000);
    timer.unref?.();
  }

  _invalidateCache(repoId?: string | null) {
    if (repoId) this._repoCache.delete(repoId);
    else this._repoCache.clear();
  }

  async getVectorStore() {
    if (!this.vectorStorePromise) {
      this.vectorStorePromise = this.vectorStoreFactory();
    }
    return this.vectorStorePromise;
  }

  isPathAllowed(targetPath: string): boolean {
    return this.allowedRoots.some(root => {
      const relative = path.relative(root, targetPath);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  }

  async resolveInputFolder(folderPath: string): Promise<string> {
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

  repoDir(repoId: string): string {
    return path.join(this.storageRoot, repoId);
  }

  repoIndexPath(repoId: string): string {
    return path.join(this.repoDir(repoId), 'index.json');
  }

  async listRepoIds() {
    await this.ensureStorageRoot();
    const entries = await fs.readdir(this.storageRoot, { withFileTypes: true }).catch(() => []);
    return entries
      .filter(entry => entry.isDirectory() && entry.name !== 'vectors')
      .map(entry => entry.name)
      .sort();
  }

  async loadIndex(repoId: string) {
    const cached = this._getCachedRepo(repoId);
    if (cached) return cached;
    const filePath = this.repoIndexPath(repoId);
    const raw = await fs.readFile(filePath, 'utf8');
    let repoIndex: RepoIndex;
    try {
      repoIndex = JSON.parse(raw);
    } catch (error) {
      console.error(
        `Code index: corrupt index file for repo "${repoId}" at ${filePath}: ${errorMessage(error)}`
      );
      throw error;
    }
    this._setCachedRepo(repoId, repoIndex);
    return repoIndex;
  }

  async saveIndex(repoIndex: RepoIndex) {
    const repoDirectory = this.repoDir(repoIndex.repo.id);
    await fs.mkdir(repoDirectory, { recursive: true });
    const indexPath = this.repoIndexPath(repoIndex.repo.id);
    const tempPath = `${indexPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(repoIndex));
      await fs.rename(tempPath, indexPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async discoverFiles(
    rootPath: string,
    { maxFiles = this.maxFiles, maxFileSize = this.maxFileSize } = {}
  ) {
    const results: DiscoveredFile[] = [];
    const skipped: SkipCounts = {
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
      // The `queue.length > 0` guard above already rules this out; it is here so the
      // string reaches readdir without an assertion.
      if (current === undefined) break;
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => {
        // An unreadable root would otherwise produce an empty index that replaces a good one
        if (current === rootPath) throw error;
        skipped.unreadableDirectory += 1;
        return [];
      });

      const fileCandidates: Omit<DiscoveredFile, 'size'>[] = [];
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
        const stats = await Promise.all(batch.map(f => fs.stat(f.absolutePath).catch(() => null)));
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

  buildSymbolRecord(fileRecord: FileRecord, symbol: ExtractedSymbol): SymbolRecord {
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

  createEmbeddingText(symbol: SymbolRecord): string {
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

  _toVectorDoc(symbol: SymbolRecord): SymbolVectorDoc {
    return {
      id: symbol.id,
      vector: createHashedEmbedding(this.createEmbeddingText(symbol), this.embeddingDimension),
      fields: {
        kind: symbol.kind,
        filePath: symbol.filePath,
      },
    };
  }

  _indexFileContent(relativePath: string, content: string, size: number) {
    const { language, symbols: extracted } = extractSymbolsFromContent(relativePath, content);
    const fileRecord: FileRecord = {
      path: relativePath,
      language,
      size,
      contentHash: hashContent(content),
      symbolIds: [],
    };

    const symbolRecords: SymbolRecord[] = [];
    const vectorDocs: SymbolVectorDoc[] = [];
    for (const symbol of extracted) {
      const symbolRecord = this.buildSymbolRecord(fileRecord, symbol);
      fileRecord.symbolIds.push(symbolRecord.id);
      symbolRecords.push(symbolRecord);
      vectorDocs.push(this._toVectorDoc(symbolRecord));
    }

    return { fileRecord, symbolRecords, vectorDocs };
  }

  async indexFolder({
    folderPath,
    repoName = null,
    maxFiles = this.maxFiles,
    maxFileSize = this.maxFileSize,
  }: {
    folderPath: string;
    repoName?: string | null;
    maxFiles?: number;
    maxFileSize?: number;
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

    return this._withRepoLock(repoId, () =>
      this._indexFolderLocked({
        absoluteRoot,
        safeRepoName,
        repoId,
        maxFiles,
        maxFileSize,
      })
    );
  }

  async _indexFolderLocked({
    absoluteRoot,
    safeRepoName,
    repoId,
    maxFiles,
    maxFileSize,
  }: {
    absoluteRoot: string;
    safeRepoName: string;
    repoId: string;
    maxFiles: number;
    maxFileSize: number;
  }) {
    const discovery = await this.discoverFiles(absoluteRoot, { maxFiles, maxFileSize });
    const symbols: SymbolRecord[] = [];
    const files: FileRecord[] = [];
    const vectorDocs: SymbolVectorDoc[] = [];

    // Read and parse files in parallel batches
    for (let i = 0; i < discovery.files.length; i += FILE_IO_CONCURRENCY) {
      const batch = discovery.files.slice(i, i + FILE_IO_CONCURRENCY);
      const contents = await Promise.all(
        batch.map(f => fs.readFile(f.absolutePath, 'utf8').catch(() => null))
      );

      for (let j = 0; j < batch.length; j++) {
        const content = contents[j];
        if (content === null) continue;
        const file = batch[j];
        const {
          fileRecord,
          symbolRecords,
          vectorDocs: fileVectorDocs,
        } = this._indexFileContent(file.relativePath, content, file.size);

        for (const symbolRecord of symbolRecords) symbols.push(symbolRecord);
        for (const vectorDoc of fileVectorDocs) vectorDocs.push(vectorDoc);
        files.push(fileRecord);
      }

      // Let the event loop breathe between parse batches — extraction is CPU-bound
      await new Promise(resolve => setImmediate(resolve));
    }

    const vectorStore = await this.getVectorStore();
    await vectorStore.resetCollection(repoId);
    if (vectorDocs.length > 0) {
      await vectorStore.upsert(repoId, vectorDocs);
    }

    const repoIndex: RepoIndex = {
      repo: {
        id: repoId,
        name: safeRepoName,
        rootPath: absoluteRoot,
        indexedAt: new Date().toISOString(),
        filesIndexed: files.length,
        symbolsIndexed: symbols.length,
        filesWithoutSymbols: files.filter(file => file.symbolIds.length === 0).length,
        vectorBackend: vectorStore.backend,
      },
      stats: {
        skipped: discovery.skipped,
        truncated: discovery.truncated,
      },
      files,
      symbols,
    };

    await this.saveIndex(repoIndex);
    this._setCachedRepo(repoId, repoIndex);
    this._memoryVectorRebuilds.delete(repoId);
    return repoIndex.repo;
  }

  async listRepos() {
    const repoIds = await this.listRepoIds();
    const repos: RepoInfo[] = [];

    for (const repoId of repoIds) {
      const repoIndex = await this.loadIndex(repoId).catch(() => null);
      if (repoIndex?.repo) repos.push(repoIndex.repo);
    }

    return repos.sort((left, right) => right.indexedAt.localeCompare(left.indexedAt));
  }

  async getRepoSummary(repoId: string) {
    const repoIndex = await this.loadIndex(repoId);
    const byKind: Record<string, number> = {};
    const byLanguage: Record<string, number> = {};

    for (const symbol of repoIndex.symbols) {
      byKind[symbol.kind] = (byKind[symbol.kind] || 0) + 1;
      byLanguage[symbol.language] = (byLanguage[symbol.language] || 0) + 1;
    }

    return {
      ...repoIndex.repo,
      counts: {
        files: repoIndex.files.length,
        symbols: repoIndex.symbols.length,
        byKind,
        byLanguage,
      },
      filesWithoutSymbols: repoIndex.files
        .filter(file => file.symbolIds.length === 0)
        .map(file => file.path),
      stats: repoIndex.stats,
    };
  }

  async getFileTree(repoId: string) {
    const repoIndex = await this.loadIndex(repoId);
    const root: FileTreeNode & { children: FileTreeNode[] } = {
      name: repoIndex.repo.name,
      path: '',
      type: 'directory',
      children: [],
    };

    for (const file of repoIndex.files) {
      const parts = file.path.split('/');
      // Track the child list rather than the node: only `children` is ever read here,
      // and a directory node always has one.
      let cursor = root.children;
      let currentPath = '';

      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const isLeaf = index === parts.length - 1;
        let next: FileTreeNode | undefined = cursor.find(child => child.name === part);

        if (!next) {
          next = {
            name: part,
            path: currentPath,
            type: isLeaf ? 'file' : 'directory',
          };
          if (!isLeaf) next.children = [];
          cursor.push(next);
        }

        if (isLeaf) {
          next.language = file.language;
          next.symbolCount = file.symbolIds.length;
          next.size = file.size;
        } else {
          // Non-leaf nodes are created with a child list just above; this only fires
          // when the index holds a path used both as a file and as a directory.
          if (!next.children) next.children = [];
          cursor = next.children;
        }
      }
    }

    return sortTreeNode(root);
  }

  async getFileOutline(repoId: string, filePath: string) {
    const repoIndex = await this.loadIndex(repoId);
    const normalizedPath = toPosixPath(filePath);
    const file = repoIndex.files.find(entry => entry.path === normalizedPath);
    if (!file) {
      throw new Error(`File "${normalizedPath}" not found in repo "${repoId}"`);
    }

    return {
      repo: repoIndex.repo,
      file,
      symbols: repoIndex.symbols.filter(symbol => symbol.filePath === normalizedPath),
    };
  }

  async getSymbol(
    repoId: string,
    symbolId: string,
    { verify = false, contextLines = 0 }: { verify?: boolean; contextLines?: number } = {}
  ) {
    const repoIndex = await this.loadIndex(repoId);
    const symbol = repoIndex.symbols.find(entry => entry.id === symbolId);
    if (!symbol) {
      throw new Error(`Symbol "${symbolId}" not found in repo "${repoId}"`);
    }

    const response: SymbolDetail = {
      ...symbol,
      repo: repoIndex.repo,
      driftDetected: false,
    };

    if (!verify && contextLines === 0 && !symbol.sourceTruncated) {
      return response;
    }

    const absolutePath = path.resolve(repoIndex.repo.rootPath, symbol.filePath);
    const currentFile = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (!currentFile) {
      response.liveSourceAvailable = false;
      return response;
    }

    const lines = currentFile.replace(/\r\n/g, '\n').split('\n');
    const startLine = Math.max(1, symbol.startLine - contextLines);
    const endLine = Math.min(lines.length, symbol.endLine + contextLines);
    const currentSource = lines
      .slice(startLine - 1, endLine)
      .join('\n')
      .trimEnd();
    const exactCurrentSource = lines
      .slice(symbol.startLine - 1, symbol.endLine)
      .join('\n')
      .trimEnd();

    if (symbol.sourceTruncated && hashContent(exactCurrentSource) === symbol.sourceHash) {
      response.source = exactCurrentSource;
      response.sourceTruncated = false;
    }

    response.liveSourceAvailable = true;
    response.currentSource = currentSource;
    response.driftDetected = verify ? hashContent(exactCurrentSource) !== symbol.sourceHash : false;

    return response;
  }

  async searchSymbols(
    repoId: string,
    { query, kind = null, topK = 10 }: { query: string; kind?: string | null; topK?: number } = {
      query: '',
    }
  ) {
    const repoIndex = await this.loadIndex(repoId);
    const scored: ScoredSymbol[] = [];
    for (const symbol of repoIndex.symbols) {
      if (kind && symbol.kind !== kind) continue;
      const score = scoreTextMatch(query, symbol);
      if (score > 0) scored.push({ symbol, score });
    }

    scored.sort(
      (left, right) =>
        right.score - left.score || left.symbol.filePath.localeCompare(right.symbol.filePath)
    );

    return scored.slice(0, topK).map(({ symbol, score }) => toSearchHit(symbol, query, { score }));
  }

  async searchText(
    repoId: string,
    { query, topK = 10 }: { query: string; topK?: number } = { query: '' }
  ) {
    const repoIndex = await this.loadIndex(repoId);
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return [];

    const scored: ScoredSymbol[] = [];
    for (const symbol of repoIndex.symbols) {
      const haystack = normalizeText(`${symbol.signature}\n${symbol.summary}\n${symbol.source}`);
      const occurrences = haystack.split(normalizedQuery).length - 1;
      if (occurrences > 0) {
        scored.push({ symbol, score: occurrences });
      }
    }

    scored.sort((left, right) => right.score - left.score);

    return scored
      .slice(0, topK)
      .map(({ symbol, score }) => toSearchHit(symbol, query, { score }, { withDoc: false }));
  }

  // The in-memory vector backend loses its collections on restart while index.json
  // persists — rebuild the collection from stored symbols when it falls out of sync.
  async _ensureMemoryVectors(repoId: string, repoIndex: RepoIndex, vectorStore: VectorStore) {
    if (typeof vectorStore.backend !== 'string' || !vectorStore.backend.startsWith('memory'))
      return;
    if (!Array.isArray(repoIndex.symbols) || repoIndex.symbols.length === 0) return;
    const collectionSize = vectorStore.collections?.get(repoId)?.size ?? 0;
    if (collectionSize >= repoIndex.symbols.length) return;

    let rebuild = this._memoryVectorRebuilds.get(repoId);
    if (!rebuild) {
      rebuild = (async () => {
        console.info(
          `Code index: rebuilding in-memory vectors for repo "${repoId}" (${repoIndex.symbols.length} symbols)`
        );
        const docs = repoIndex.symbols.map(symbol => this._toVectorDoc(symbol));
        await vectorStore.upsert(repoId, docs);
      })();
      this._memoryVectorRebuilds.set(repoId, rebuild);
      rebuild.catch(() => this._memoryVectorRebuilds.delete(repoId));
    }
    await rebuild;
  }

  async searchSemantic(
    repoId: string,
    { query, topK = 10 }: { query: string; topK?: number } = { query: '' }
  ) {
    const [repoIndex, vectorStore] = await Promise.all([
      this.loadIndex(repoId),
      this.getVectorStore(),
    ]);
    await this._ensureMemoryVectors(repoId, repoIndex, vectorStore);
    const queryVector = createHashedEmbedding(query, this.embeddingDimension);
    const vectorMatches = await vectorStore.query(repoId, queryVector, topK * 3);

    // Build symbol lookup only for matched IDs
    const matchedIds = new Set(vectorMatches.map(m => m.id));
    const symbolById = new Map();
    for (const symbol of repoIndex.symbols) {
      if (matchedIds.has(symbol.id)) symbolById.set(symbol.id, symbol);
    }

    // toSearchHit folds an open `scores` object into its result, so its shape is not fixed here.
    const results: ReturnType<typeof toSearchHit>[] = [];
    for (const match of vectorMatches) {
      const symbol = symbolById.get(match.id);
      if (!symbol) continue;
      const lexicalScore = scoreTextMatch(query, symbol);
      results.push(
        toSearchHit(symbol, query, {
          vectorScore: Number(match.score.toFixed(6)),
          score: Number((match.score + lexicalScore * 0.05).toFixed(6)),
        })
      );
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
  async updateFiles(repoId: string, fileEntries: FileUpdateEntry[]) {
    return this._withRepoLock(repoId, () => this._updateFilesLocked(repoId, fileEntries));
  }

  async _updateFilesLocked(repoId: string, fileEntries: FileUpdateEntry[]) {
    try {
      return await this._applyFileUpdates(repoId, fileEntries);
    } catch (error) {
      // The cached repo object may hold half-applied mutations — force a reload from disk
      this._invalidateCache(repoId);
      throw error;
    }
  }

  async _applyFileUpdates(repoId: string, fileEntries: FileUpdateEntry[]) {
    const repoIndex = await this.loadIndex(repoId);
    const rootPath = repoIndex.repo.rootPath;
    const vectorStore = await this.getVectorStore();

    let updated = 0;
    let removed = 0;
    let added = 0;

    for (const entry of fileEntries) {
      const filePath = toPosixPath(entry.path);
      const extension = path.extname(filePath).toLowerCase();

      // Remove old file data
      const oldFileIdx = repoIndex.files.findIndex(f => f.path === filePath);
      const oldSymbolIds = oldFileIdx >= 0 ? repoIndex.files[oldFileIdx].symbolIds : [];
      if (oldFileIdx >= 0) {
        repoIndex.files.splice(oldFileIdx, 1);
      }
      // Remove old symbols
      repoIndex.symbols = repoIndex.symbols.filter(s => s.filePath !== filePath);
      // Remove old vectors
      if (oldSymbolIds.length > 0) {
        await vectorStore.remove(repoId, oldSymbolIds).catch(() => {});
      }

      // Get content: use provided content or read from disk
      let content = entry.content ?? null;
      if (content === null) {
        content = await fs.readFile(path.resolve(rootPath, filePath), 'utf8').catch(() => null);
      }
      const fileSize = content !== null ? Buffer.byteLength(content) : 0;
      const indexable =
        content && DEFAULT_ALLOWED_EXTENSIONS.has(extension) && fileSize <= this.maxFileSize;
      // `content === null` is already covered by `!indexable` (null is falsy); it is
      // repeated so the narrowing survives to the _indexFileContent call below.
      if (!indexable || content === null) {
        if (oldFileIdx >= 0) removed++;
        continue;
      }

      // Extract symbols from updated content
      const { fileRecord, symbolRecords, vectorDocs } = this._indexFileContent(
        filePath,
        content,
        fileSize
      );
      for (const symbolRecord of symbolRecords) repoIndex.symbols.push(symbolRecord);

      repoIndex.files.push(fileRecord);
      if (vectorDocs.length > 0) {
        await vectorStore.upsert(repoId, vectorDocs);
      }

      if (oldFileIdx >= 0) updated++;
      else added++;
    }

    // Update repo metadata
    repoIndex.repo.filesIndexed = repoIndex.files.length;
    repoIndex.repo.symbolsIndexed = repoIndex.symbols.length;
    repoIndex.repo.filesWithoutSymbols = repoIndex.files.filter(
      f => f.symbolIds.length === 0
    ).length;
    repoIndex.repo.lastUpdatedAt = new Date().toISOString();

    await this.saveIndex(repoIndex);
    this._setCachedRepo(repoId, repoIndex);

    return { updated, removed, added };
  }

  /**
   * Find indexed repos matching a project name.
   * @param {string} projectName
   * @returns {Promise<Array<{ id: string, name: string, rootPath: string }>>}
   */
  async findReposByProject(projectName: string) {
    const repos = await this.listRepos();
    const normalizedName = projectName.toLowerCase();
    return repos.filter(r => r.name.toLowerCase() === normalizedName);
  }

  async invalidate(repoId: string) {
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
