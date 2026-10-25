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
import {
  decodeReference,
  extractReferencesFromContent,
  languageFamily,
  REF_CALL,
  REF_IMPORT,
  REF_MEMBER,
  SELF_RECEIVERS,
  type FileReferences,
  type ImportRecord,
} from './codeSearch/referenceExtractor.js';
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
  /**
   * The file's side of the reference graph. Absent on indexes written before the
   * graph existed; findReferences reports `graphAvailable: false` for those.
   */
  imports?: ImportRecord[];
  references?: FileReferences;
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

/** How sure findReferences is that an occurrence points at the requested symbol. */
type ReferenceConfidence = 'high' | 'medium' | 'low';
type ReferenceKind = 'call' | 'import' | 'reference';

const CONFIDENCE_RANK: Record<ReferenceConfidence, number> = { high: 3, medium: 2, low: 1 };
const DEFAULT_REFERENCE_LIMIT = 100;
/** readFileRange: lines returned when endLine is omitted, and the hard cap per call. */
const DEFAULT_RANGE_LINES = 200;
const MAX_RANGE_LINES = 2000;
const MAX_REEXPORT_HOPS = 4;
const JS_RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** A symbol as embedded in reference results — just enough to fetch it with get_symbol. */
interface SymbolRef {
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
}

/** One occurrence returned by findReferences. */
interface ReferenceHit {
  filePath: string;
  line: number;
  kind: ReferenceKind;
  confidence: ReferenceConfidence;
  receiver?: string;
  /** Innermost indexed symbol containing the occurrence; null at module level. */
  enclosingSymbol: SymbolRef | null;
  preview?: string;
}

/** One caller returned by findCallers: a symbol (or a file's module scope) and its call lines. */
interface CallerHit {
  caller: SymbolRef | null;
  filePath: string;
  lines: number[];
  confidence: ReferenceConfidence;
}

interface ReferenceQueryOptions {
  limit?: number;
  minConfidence?: ReferenceConfidence;
  includeImports?: boolean;
}

function toSymbolRef(symbol: SymbolRecord): SymbolRef {
  return {
    id: symbol.id,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    filePath: symbol.filePath,
    startLine: symbol.startLine,
  };
}

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

    const { imports, references } = extractReferencesFromContent(content, language, extracted);
    fileRecord.imports = imports;
    fileRecord.references = references;

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

  /**
   * Read a line range of an indexed file from disk. Only files present in the
   * index can be read (so the path cannot escape the repo root), and the live
   * content is always hashed against the indexed `contentHash`: `driftDetected`
   * tells the caller the file changed since indexing and should be re-indexed.
   * Lines are 1-based and inclusive; an `endLine` past the end of the file is
   * clamped (`endLineClamped: true`), a `startLine` past it is an error.
   */
  async readFileRange(
    repoId: string,
    filePath: string,
    { startLine, endLine }: { startLine: number; endLine?: number }
  ) {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error(`Invalid startLine ${startLine}: must be an integer >= 1`);
    }
    const requestedEnd = endLine ?? startLine + DEFAULT_RANGE_LINES - 1;
    if (!Number.isInteger(requestedEnd) || requestedEnd < startLine) {
      throw new Error(
        `Invalid endLine ${requestedEnd}: must be an integer >= startLine (${startLine})`
      );
    }
    if (requestedEnd - startLine + 1 > MAX_RANGE_LINES) {
      throw new Error(
        `Range ${startLine}-${requestedEnd} spans ${requestedEnd - startLine + 1} lines; at most ${MAX_RANGE_LINES} lines can be read at once`
      );
    }

    const repoIndex = await this.loadIndex(repoId);
    const normalizedPath = toPosixPath(filePath).replace(/^\.\//, '');
    const file = repoIndex.files.find(entry => entry.path === normalizedPath);
    if (!file) {
      throw new Error(
        `File "${normalizedPath}" is not indexed in repo "${repoId}" (use get_file_tree to list indexed files, or update_files to index it)`
      );
    }

    const absolutePath = path.resolve(repoIndex.repo.rootPath, file.path);
    const content = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (content === null) {
      throw new Error(
        `File "${file.path}" is indexed in repo "${repoId}" but can no longer be read from disk (deleted or moved?); re-index it with update_files`
      );
    }

    const lines = content.replace(/\r\n/g, '\n').split('\n');
    // A trailing newline does not open an extra (empty) line.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const totalLines = lines.length;
    if (startLine > totalLines) {
      throw new Error(
        `startLine ${startLine} is past the end of "${file.path}" (${totalLines} lines)`
      );
    }
    const effectiveEnd = Math.min(requestedEnd, totalLines);

    return {
      repo: repoIndex.repo,
      filePath: file.path,
      language: file.language,
      startLine,
      endLine: effectiveEnd,
      endLineClamped: effectiveEnd < requestedEnd,
      totalLines,
      content: lines.slice(startLine - 1, effectiveEnd).join('\n'),
      driftDetected: hashContent(content) !== file.contentHash,
      symbols: repoIndex.symbols
        .filter(
          symbol =>
            symbol.filePath === file.path &&
            symbol.startLine <= effectiveEnd &&
            symbol.endLine >= startLine
        )
        .map(toSymbolRef),
    };
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
   * Map an import specifier to an indexed file. JS/TS resolves relative specifiers
   * only (with extension / index / `.js`→`.ts` fallbacks — packages and path
   * aliases stay unresolved); Python resolves relative and absolute dotted modules,
   * falling back to a path-suffix match for `src/`-style layouts.
   */
  _resolveModulePath(
    fromPath: string,
    specifier: string,
    family: string,
    filePaths: Set<string>,
    suffixCache: Map<string, string | null>
  ): string | null {
    const firstExisting = (candidates: string[]) =>
      candidates.find(candidate => filePaths.has(candidate)) ?? null;

    if (family === 'js') {
      if (!specifier.startsWith('.')) return null;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
      const candidates = [
        base,
        ...JS_RESOLVE_EXTENSIONS.map(extension => base + extension),
        ...JS_RESOLVE_EXTENSIONS.map(extension => `${base}/index${extension}`),
      ];
      // TypeScript ESM imports name the emitted file: './x.js' means './x.ts'.
      const emitted = base.match(/\.[mc]?jsx?$/);
      if (emitted) {
        const stem = base.slice(0, -emitted[0].length);
        candidates.push(...JS_RESOLVE_EXTENSIONS.map(extension => stem + extension));
      }
      return firstExisting(candidates);
    }

    if (family === 'python') {
      const dots = specifier.match(/^\.*/)?.[0].length ?? 0;
      const parts = specifier.slice(dots).split('.').filter(Boolean);
      if (dots > 0) {
        let directory = path.posix.dirname(fromPath);
        for (let level = 1; level < dots; level += 1) directory = path.posix.dirname(directory);
        if (parts.length === 0) return firstExisting([path.posix.join(directory, '__init__.py')]);
        const base = path.posix.join(directory, ...parts);
        return firstExisting([`${base}.py`, `${base}/__init__.py`]);
      }
      if (parts.length === 0) return null;
      const relative = parts.join('/');
      const direct = firstExisting([`${relative}.py`, `${relative}/__init__.py`]);
      if (direct) return direct;
      if (!suffixCache.has(relative)) {
        let best: string | null = null;
        for (const candidate of filePaths) {
          if (
            (candidate.endsWith(`/${relative}.py`) ||
              candidate.endsWith(`/${relative}/__init__.py`)) &&
            (!best || candidate.length < best.length)
          ) {
            best = candidate;
          }
        }
        suffixCache.set(relative, best);
      }
      return suffixCache.get(relative) ?? null;
    }

    return null;
  }

  /**
   * Walk every file's stored references and keep the ones that resolve to
   * `target`, each with a confidence level:
   *  - high: same-file use, a use of a name imported from the target's file
   *    (following `export … from` re-exports and Python package imports),
   *    `ns.name` through a namespace import of that file, or for a method a call
   *    through `this`/`self` inside its class or through the class name;
   *  - medium: a name imported from a module that could not be resolved but looks
   *    like the target's file, a method called on another receiver when no other
   *    symbol shares its name, or a same-name use in a language whose imports are
   *    not tracked (Go, Rust, C/C++, Java, Ruby);
   *  - low: anything that merely shares the name (a global, a subclass, …).
   */
  _collectReferences(repoIndex: RepoIndex, target: SymbolRecord): ReferenceHit[] {
    const targetFamily = languageFamily(target.language);
    const isMethod = Boolean(target.parentName);
    const targetIsDefault = /\bexport\s+default\b/.test(target.signature);
    const targetDirName = path.posix.basename(path.posix.dirname(target.filePath));
    const filePaths = new Set(repoIndex.files.map(file => file.path));
    const fileByPath = new Map(repoIndex.files.map(file => [file.path, file]));
    const suffixCache = new Map<string, string | null>();

    const symbolsByFile = new Map<string, SymbolRecord[]>();
    let sameNameCount = 0;
    for (const symbol of repoIndex.symbols) {
      const list = symbolsByFile.get(symbol.filePath);
      if (list) list.push(symbol);
      else symbolsByFile.set(symbol.filePath, [symbol]);
      if (symbol.name === target.name) sameNameCount += 1;
    }
    const parentClass = isMethod
      ? (symbolsByFile.get(target.filePath) || []).find(
          symbol => symbol.kind === 'class' && symbol.qualifiedName === target.parentName
        )
      : undefined;

    const sameLanguage = (language: string) => {
      if (targetFamily !== 'generic') return languageFamily(language) === targetFamily;
      const cFamily = new Set(['c', 'cpp']);
      return (
        language === target.language || (cFamily.has(language) && cFamily.has(target.language))
      );
    };

    const resolve = (fromPath: string, specifier: string, family: string) =>
      this._resolveModulePath(fromPath, specifier, family, filePaths, suffixCache);

    // Where does `name`, as exported by `filePath`, come from? Follows re-exports
    // (and, for Python, plain imports — a package `__init__` re-exports by importing).
    const followExport = (
      filePath: string,
      name: string,
      family: string,
      hops = 0
    ): { path: string; name: string } => {
      const definesIt = (symbolsByFile.get(filePath) || []).some(
        symbol => !symbol.parentName && symbol.name === name
      );
      if (definesIt || hops >= MAX_REEXPORT_HOPS) return { path: filePath, name };
      for (const record of fileByPath.get(filePath)?.imports || []) {
        if (!record.reexport && family !== 'python') continue;
        for (const binding of record.bindings) {
          const forwardsAll = binding.local === '*';
          if (!forwardsAll && binding.local !== name) continue;
          const next = resolve(filePath, record.module, family);
          if (!next || next === filePath) continue;
          const origin = followExport(
            next,
            forwardsAll ? name : binding.imported,
            family,
            hops + 1
          );
          if (!forwardsAll || origin.path !== next || origin.name !== name) return origin;
          if ((symbolsByFile.get(next) || []).some(symbol => symbol.name === name)) return origin;
        }
      }
      return { path: filePath, name };
    };

    const hits = new Map<string, ReferenceHit>();
    const fileSymbolsCache = new Map<string, SymbolRecord[]>();
    const enclosingSymbol = (filePath: string, line: number) => {
      let best: SymbolRecord | null = null;
      for (const symbol of fileSymbolsCache.get(filePath) || []) {
        if (symbol.startLine > line || symbol.endLine < line) continue;
        if (
          !best ||
          symbol.endLine - symbol.startLine < best.endLine - best.startLine ||
          (symbol.endLine - symbol.startLine === best.endLine - best.startLine &&
            symbol.startLine > best.startLine)
        ) {
          best = symbol;
        }
      }
      return best ? toSymbolRef(best) : null;
    };

    for (const file of repoIndex.files) {
      const references = file.references;
      if (!references || !sameLanguage(file.language)) continue;
      const family = languageFamily(file.language);
      const sameFile = file.path === target.filePath;
      const fileSymbols = symbolsByFile.get(file.path) || [];
      fileSymbolsCache.set(file.path, fileSymbols);

      // Local names bound to the target (aliases included) and namespaces of its file.
      const locals = new Map<string, ReferenceConfidence>();
      const namespaces = new Set<string>();
      let importedElsewhere = false;
      if (sameFile && !isMethod) locals.set(target.name, 'high');

      if (!isMethod) {
        for (const record of file.imports || []) {
          const resolved = resolve(file.path, record.module, family);
          for (const binding of record.bindings) {
            if (!resolved) {
              if (binding.imported !== target.name && binding.local !== target.name) continue;
              if (binding.imported === '*' || locals.has(binding.local)) continue;
              const moduleTail = record.module.split(/[/.]/).filter(Boolean).pop();
              const targetStem = path.posix.basename(target.filePath).replace(/\.[^.]+$/, '');
              locals.set(binding.local, moduleTail === targetStem ? 'medium' : 'low');
              continue;
            }
            if (binding.imported === '*') {
              if (binding.local === '*') {
                const origin = followExport(resolved, target.name, family);
                if (origin.path === target.filePath) locals.set(target.name, 'high');
              } else if (resolved === target.filePath) {
                namespaces.add(binding.local);
              }
              continue;
            }
            if (family === 'python') {
              // `from pkg import mod` binds a submodule, used as `mod.name`.
              const submodule = record.module.endsWith('.')
                ? record.module + binding.imported
                : `${record.module}.${binding.imported}`;
              if (resolve(file.path, submodule, family) === target.filePath) {
                namespaces.add(binding.local);
                continue;
              }
            }
            const origin = followExport(resolved, binding.imported, family);
            const isTarget =
              origin.path === target.filePath &&
              (origin.name === target.name || (origin.name === 'default' && targetIsDefault));
            if (isTarget) locals.set(binding.local, 'high');
            else if (binding.local === target.name) importedElsewhere = true;
          }
        }
      }

      // Another top-level definition of the same name in this file shadows the target.
      const shadowed =
        !sameFile && fileSymbols.some(symbol => !symbol.parentName && symbol.name === target.name);

      const names = new Set([target.name, ...locals.keys()]);
      for (const name of names) {
        if (!Object.hasOwn(references, name)) continue;
        for (const entry of references[name]) {
          const { line, flags, receiver } = decodeReference(entry);
          const isImport = (flags & REF_IMPORT) !== 0;
          const isMember = (flags & REF_MEMBER) !== 0;
          if (sameFile && line === target.startLine && !isImport) continue;

          let confidence: ReferenceConfidence | null = null;
          if (isMethod) {
            if (!isMember || name !== target.name) continue;
            if (receiver && SELF_RECEIVERS.has(receiver)) {
              const insideClass =
                sameFile &&
                (!parentClass || (line >= parentClass.startLine && line <= parentClass.endLine));
              confidence = insideClass ? 'high' : 'low';
            } else if (receiver === target.parentName) {
              confidence = 'high';
            } else {
              confidence = sameNameCount === 1 ? 'medium' : 'low';
            }
          } else if (isMember) {
            if (name !== target.name) continue;
            if (receiver && namespaces.has(receiver)) confidence = 'high';
            else if (family === 'generic' && receiver === targetDirName) confidence = 'medium';
            else continue;
          } else if (locals.has(name)) {
            confidence = locals.get(name) ?? null;
          } else if (name === target.name && !importedElsewhere && !shadowed) {
            confidence = family === 'generic' ? 'medium' : 'low';
          }
          if (!confidence) continue;

          const kind: ReferenceKind = isImport ? 'import' : flags & REF_CALL ? 'call' : 'reference';
          const key = `${file.path}\u0000${line}\u0000${kind}`;
          const existing = hits.get(key);
          if (existing && CONFIDENCE_RANK[existing.confidence] >= CONFIDENCE_RANK[confidence]) {
            continue;
          }
          hits.set(key, {
            filePath: file.path,
            line,
            kind,
            confidence,
            ...(receiver ? { receiver } : {}),
            enclosingSymbol: enclosingSymbol(file.path, line),
          });
        }
      }
    }

    return [...hits.values()].sort(
      (left, right) =>
        CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence] ||
        left.filePath.localeCompare(right.filePath) ||
        left.line - right.line
    );
  }

  /** Fill `preview` with the trimmed source line of each hit, read live from disk. */
  async _attachPreviews(rootPath: string, hits: ReferenceHit[]) {
    const byFile = new Map<string, ReferenceHit[]>();
    for (const hit of hits) {
      const list = byFile.get(hit.filePath);
      if (list) list.push(hit);
      else byFile.set(hit.filePath, [hit]);
    }
    const entries = [...byFile.entries()];
    for (let i = 0; i < entries.length; i += FILE_IO_CONCURRENCY) {
      await Promise.all(
        entries.slice(i, i + FILE_IO_CONCURRENCY).map(async ([filePath, fileHits]) => {
          const content = await fs
            .readFile(path.resolve(rootPath, filePath), 'utf8')
            .catch(() => null);
          if (content === null) return;
          const lines = content.replace(/\r\n/g, '\n').split('\n');
          for (const hit of fileHits) {
            const text = lines[hit.line - 1];
            if (text !== undefined) hit.preview = text.trim().slice(0, 240);
          }
        })
      );
    }
  }

  async _loadTargetSymbol(repoId: string, symbolId: string) {
    const repoIndex = await this.loadIndex(repoId);
    const target = repoIndex.symbols.find(entry => entry.id === symbolId);
    if (!target) {
      throw new Error(`Symbol "${symbolId}" not found in repo "${repoId}"`);
    }
    // Indexes written before the reference graph existed carry no `references`.
    const graphAvailable = repoIndex.files.some(file => file.references !== undefined);
    return { repoIndex, target, graphAvailable };
  }

  /**
   * Every place in the repo that references a symbol — call sites, imports and
   * other uses — resolved through the import graph built at indexing time.
   * Results are ranked by confidence (see _collectReferences), then by file/line.
   */
  async findReferences(
    repoId: string,
    symbolId: string,
    {
      limit = DEFAULT_REFERENCE_LIMIT,
      minConfidence = 'low',
      includeImports = true,
    }: ReferenceQueryOptions = {}
  ) {
    const { repoIndex, target, graphAvailable } = await this._loadTargetSymbol(repoId, symbolId);
    const all = this._collectReferences(repoIndex, target).filter(
      hit =>
        CONFIDENCE_RANK[hit.confidence] >= CONFIDENCE_RANK[minConfidence] &&
        (includeImports || hit.kind !== 'import')
    );
    const references = all.slice(0, limit);
    await this._attachPreviews(repoIndex.repo.rootPath, references);

    return {
      symbol: toSymbolRef(target),
      graphAvailable,
      total: all.length,
      truncated: all.length > references.length,
      references,
    };
  }

  /**
   * The symbols that call a function, method or class constructor, one entry per
   * caller with the lines of its calls. Calls made outside any indexed symbol
   * (module top level) are grouped per file with `caller: null`.
   */
  async findCallers(
    repoId: string,
    symbolId: string,
    { limit = DEFAULT_REFERENCE_LIMIT, minConfidence = 'low' }: ReferenceQueryOptions = {}
  ) {
    const { repoIndex, target, graphAvailable } = await this._loadTargetSymbol(repoId, symbolId);
    const calls = this._collectReferences(repoIndex, target).filter(
      hit =>
        hit.kind === 'call' && CONFIDENCE_RANK[hit.confidence] >= CONFIDENCE_RANK[minConfidence]
    );

    const byCaller = new Map<string, CallerHit>();
    for (const call of calls) {
      const key = call.enclosingSymbol?.id ?? `${call.filePath}::<module>`;
      const existing = byCaller.get(key);
      if (!existing) {
        byCaller.set(key, {
          caller: call.enclosingSymbol,
          filePath: call.filePath,
          lines: [call.line],
          confidence: call.confidence,
        });
        continue;
      }
      existing.lines.push(call.line);
      if (CONFIDENCE_RANK[call.confidence] > CONFIDENCE_RANK[existing.confidence]) {
        existing.confidence = call.confidence;
      }
    }

    const callers = [...byCaller.values()]
      .map(caller => ({ ...caller, lines: caller.lines.sort((a, b) => a - b) }))
      .sort(
        (left, right) =>
          CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence] ||
          right.lines.length - left.lines.length ||
          left.filePath.localeCompare(right.filePath)
      );

    return {
      symbol: toSymbolRef(target),
      graphAvailable,
      totalCalls: calls.length,
      total: callers.length,
      truncated: callers.length > limit,
      callers: callers.slice(0, limit),
    };
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

  /**
   * Resolve the repo a tool call targets: an explicit `repoId` wins (and is used
   * as-is, for backward compatibility); otherwise `repoName` is matched
   * case-insensitively against repo names, then against the basename of their
   * root folder. No match or several matches throw an error listing the
   * candidates, so the caller can retry with a precise `repoId`.
   */
  async resolveRepoId({ repoId, repoName }: { repoId?: string | null; repoName?: string | null }) {
    const id = repoId?.trim();
    if (id) return id;
    const name = repoName?.trim();
    if (!name) throw new Error('Either repoId or repoName is required');

    let matches = await this.findReposByProject(name);
    if (matches.length === 0) {
      const normalizedName = name.toLowerCase();
      matches = (await this.listRepos()).filter(
        repo => path.basename(repo.rootPath).toLowerCase() === normalizedName
      );
    }

    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) {
      const known = (await this.listRepos()).map(repo => `"${repo.name}"`);
      throw new Error(
        `No indexed repo named "${name}"${known.length ? ` (indexed repos: ${known.join(', ')})` : ' (no repos indexed yet)'}; index it with index_folder`
      );
    }
    const candidates = matches.map(repo => `${repo.id} (${repo.rootPath})`).join(', ');
    throw new Error(`Repo name "${name}" is ambiguous: ${candidates}; pass repoId instead`);
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
