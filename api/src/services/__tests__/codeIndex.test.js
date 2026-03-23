import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndexService } from '../codeIndexService.js';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'code-index-data-' + Date.now());
const FIXTURE_DIR = path.join(os.tmpdir(), 'code-index-test-' + Date.now());

let _serviceCounter = 0;
function makeService() {
  _serviceCounter++;
  const serviceDir = path.join(TEST_DATA_DIR, 'svc-' + _serviceCounter);
  return new CodeIndexService({
    storageRoot: serviceDir,
    allowedRoots: [FIXTURE_DIR, os.tmpdir()],
  });
}

const FIXTURES = {
  'src/auth.js': `
import jwt from 'jsonwebtoken';
/**
 * Authenticate a JWT token from the request header
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

export function generateToken(userId, email) {
  return jwt.sign({ id: userId, email }, process.env.JWT_SECRET, { expiresIn: '24h' });
}

export class AuthService {
  constructor(secret) { this.secret = secret; }
  validateUser(username, password) { return { id: 1, username }; }
  refreshToken(oldToken) { return this.generateNewToken(jwt.decode(oldToken)); }
  generateNewToken(payload) { return jwt.sign(payload, this.secret, { expiresIn: '1h' }); }
}
`,
  'src/database.py': `
import sqlite3
from contextlib import contextmanager

class Database:
    """Database connection manager"""
    def __init__(self, db_path):
        self.db_path = db_path

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def execute_query(self, sql, params=None):
        with self.connection() as conn:
            cursor = conn.cursor()
            cursor.execute(sql, params or [])
            return cursor.fetchall()

def create_tables(db):
    db.execute_query("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT)")
`,
  'src/utils/helpers.ts': `
export interface Config { apiUrl: string; timeout: number; }
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export function formatDuration(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  const seconds = Math.floor(ms / 1000);
  return seconds + 's';
}
export function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  let timer: NodeJS.Timeout;
  return ((...args: any[]) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }) as T;
}
`,
  'src/empty.js': '',
};

before(() => {
  for (const [relPath, content] of Object.entries(FIXTURES)) {
    const absPath = path.join(FIXTURE_DIR, relPath);
    fsSync.mkdirSync(path.dirname(absPath), { recursive: true });
    fsSync.writeFileSync(absPath, content);
  }
});

after(() => {
  fsSync.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fsSync.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('CodeIndexService', () => {
  it('should index a folder and return stats', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-repo' });
    assert.ok(result.id, 'Should have repoId');
    assert.ok(result.filesIndexed > 0, 'Should index files');
    assert.ok(result.symbolsIndexed > 0, 'Should find symbols');
  });

  it('should list indexed repos', async () => {
    const service = makeService();
    await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-list' });
    const repos = await service.listRepos();
    assert.ok(repos.length > 0);
    assert.ok(repos[0].repoId, 'Should have repoId');
  });

  it('should return file tree', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-tree' });
    const tree = await service.getFileTree(result.id);
    assert.ok(tree);
    assert.ok(tree.children && tree.children.length > 0, 'Tree should have children');
    const allNames = JSON.stringify(tree);
    assert.ok(allNames.includes('auth.js'), 'Should contain auth.js');
  });

  it('should return file outline with symbols', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-outline' });
    const outline = await service.getFileOutline(result.id, 'src/auth.js');
    assert.ok(outline);
    assert.ok(outline.length > 0);
    const names = outline.map(s => s.name);
    assert.ok(names.includes('authenticateToken'), 'Should find authenticateToken');
  });

  it('should search symbols by name', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-search' });
    const results = await service.searchSymbols(result.id, { query: 'authenticate' });
    assert.ok(results.length > 0, 'Should find matching symbols');
    assert.ok(results[0].qualifiedName.toLowerCase().includes('authenticate'));
  });

  it('should return empty for no matches', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-no-match' });
    const results = await service.searchSymbols(result.id, { query: 'xyzNonExistent123' });
    assert.deepEqual(results, []);
  });

  it('should search semantically', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-semantic' });
    const results = await service.searchSemantic(result.id, { query: 'JWT authentication middleware' });
    assert.ok(results.length > 0);
    const allText = results.map(r => (r.name + ' ' + (r.summary || '')).toLowerCase()).join(' ');
    assert.ok(/auth|token|jwt/.test(allText), 'Should find auth-related symbols');
  });

  it('should search text', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-text' });
    const results = await service.searchText(result.id, { query: 'jwt.verify' });
    assert.ok(results.length > 0);
  });

  it('should retrieve symbol source code', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-symbol' });
    const symbols = await service.searchSymbols(result.id, { query: 'authenticateToken' });
    assert.ok(symbols.length > 0);
    const detail = await service.getSymbol(result.id, symbols[0].id);
    assert.ok(detail);
    assert.ok(detail.source.includes('jwt.verify'));
  });

  it('should index Python files', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-py' });
    const results = await service.searchSymbols(result.id, { query: 'Database' });
    assert.ok(results.length > 0);
  });

  it('should index TypeScript files', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-ts' });
    const results = await service.searchSymbols(result.id, { query: 'formatDuration' });
    assert.ok(results.length > 0);
  });

  it('should reduce tokens vs full file for targeted queries', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-tokens' });
    const fullFile = fsSync.readFileSync(path.join(FIXTURE_DIR, 'src/auth.js'), 'utf8');
    const fullTokens = fullFile.length / 4;
    const results = await service.searchSymbols(result.id, { query: 'authenticateToken', topK: 1 });
    assert.equal(results.length, 1);
    const sym = await service.getSymbol(result.id, results[0].id);
    const indexedTokens = sym.source.length / 4;
    const reduction = 1 - (indexedTokens / fullTokens);
    console.log(`  Token reduction: ${(reduction * 100).toFixed(1)}% (full: ~${Math.round(fullTokens)}, indexed: ~${Math.round(indexedTokens)})`);
    assert.ok(reduction > 0.3, `Expected >30% reduction, got ${(reduction*100).toFixed(1)}%`);
  });

  it('should reduce tokens vs full codebase for semantic queries', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-tokens-sem' });
    let total = '';
    for (const [p, c] of Object.entries(FIXTURES)) {
      if (p.endsWith('.js') || p.endsWith('.py') || p.endsWith('.ts')) total += c;
    }
    const fullTokens = total.length / 4;
    const results = await service.searchSemantic(result.id, { query: 'authentication', topK: 3 });
    let indexed = '';
    for (const r of results) {
      const s = await service.getSymbol(result.id, r.id);
      if (s) indexed += s.source;
    }
    const indexedTokens = indexed.length / 4;
    const reduction = 1 - (indexedTokens / fullTokens);
    console.log(`  Codebase token reduction: ${(reduction * 100).toFixed(1)}% (full: ~${Math.round(fullTokens)}, indexed: ~${Math.round(indexedTokens)})`);
    assert.ok(reduction > 0.5, `Expected >50% reduction, got ${(reduction*100).toFixed(1)}%`);
  });

  it('should index in under 1 second', async () => {
    const service = makeService();
    const start = Date.now();
    await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-perf' });
    const elapsed = Date.now() - start;
    console.log(`  Indexing time: ${elapsed}ms`);
    assert.ok(elapsed < 1000);
  });

  it('should handle repo not found', async () => {
    const service = makeService();
    await assert.rejects(
      () => service.getFileTree('nonexistent'),
      /ENOENT|not found/i
    );
  });

  it('should handle symbol not found', async () => {
    const service = makeService();
    const result = await service.indexFolder({ folderPath: FIXTURE_DIR, repoName: 'test-edge' });
    await assert.rejects(
      () => service.getSymbol(result.id, 'nonexistent-id'),
      /not found/i
    );
  });
});