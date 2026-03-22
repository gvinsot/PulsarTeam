import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndexService } from '../codeIndexService.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const FIXTURE_DIR = path.join(os.tmpdir(), 'code-index-test-' + Date.now());

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
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
});

after(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('CodeIndexService', () => {
  it('should index a folder and return stats', () => {
    const service = new CodeIndexService();
    const result = service.indexFolder(FIXTURE_DIR, 'test-repo');
    assert.equal(result.repoId, 'test-repo');
    assert.ok(result.filesIndexed > 0, 'Should index files');
    assert.ok(result.symbolCount > 0, 'Should find symbols');
  });

  it('should list indexed repos', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-list');
    const repos = service.listRepos();
    assert.ok(repos.length > 0);
    assert.equal(repos[0].repoId, 'test-list');
  });

  it('should return file tree', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-tree');
    const tree = service.getFileTree('test-tree');
    assert.ok(tree);
    assert.ok(tree.length > 0);
    assert.ok(tree.some(f => f.includes('auth.js')));
  });

  it('should return file outline with symbols', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-outline');
    const outline = service.getFileOutline('test-outline', 'src/auth.js');
    assert.ok(outline);
    assert.ok(outline.length > 0);
    const names = outline.map(s => s.name);
    assert.ok(names.includes('authenticateToken'), 'Should find authenticateToken');
  });

  it('should search symbols by name', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-search');
    const results = service.searchSymbols('test-search', 'authenticate');
    assert.ok(results.length > 0, 'Should find matching symbols');
    assert.ok(results[0].name.toLowerCase().includes('authenticate'));
  });

  it('should return empty for no matches', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-no-match');
    const results = service.searchSymbols('test-no-match', 'xyzNonExistent123');
    assert.deepEqual(results, []);
  });

  it('should search semantically', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-semantic');
    const results = service.searchSemantic('test-semantic', 'JWT authentication middleware');
    assert.ok(results.length > 0);
    const allText = results.map(r => (r.name + ' ' + (r.summary || '')).toLowerCase()).join(' ');
    assert.ok(/auth|token|jwt/.test(allText), 'Should find auth-related symbols');
  });

  it('should search text', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-text');
    const results = service.searchText('test-text', 'jwt.verify');
    assert.ok(results.length > 0);
  });

  it('should retrieve symbol source code', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-symbol');
    const symbols = service.searchSymbols('test-symbol', 'authenticateToken');
    assert.ok(symbols.length > 0);
    const detail = service.getSymbol('test-symbol', symbols[0].id);
    assert.ok(detail);
    assert.ok(detail.body.includes('jwt.verify'));
  });

  it('should index Python files', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-py');
    const results = service.searchSymbols('test-py', 'Database');
    assert.ok(results.length > 0);
  });

  it('should index TypeScript files', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-ts');
    const results = service.searchSymbols('test-ts', 'formatDuration');
    assert.ok(results.length > 0);
  });

  it('should reduce tokens vs full file for targeted queries', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-tokens');
    const fullFile = fs.readFileSync(path.join(FIXTURE_DIR, 'src/auth.js'), 'utf8');
    const fullTokens = fullFile.length / 4;
    const results = service.searchSymbols('test-tokens', 'authenticateToken', { topK: 1 });
    assert.equal(results.length, 1);
    const sym = service.getSymbol('test-tokens', results[0].id);
    const indexedTokens = sym.body.length / 4;
    const reduction = 1 - (indexedTokens / fullTokens);
    console.log(`  Token reduction: ${(reduction * 100).toFixed(1)}% (full: ~${Math.round(fullTokens)}, indexed: ~${Math.round(indexedTokens)})`);
    assert.ok(reduction > 0.3, `Expected >30% reduction, got ${(reduction*100).toFixed(1)}%`);
  });

  it('should reduce tokens vs full codebase for semantic queries', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-tokens-sem');
    let total = '';
    for (const [p, c] of Object.entries(FIXTURES)) {
      if (p.endsWith('.js') || p.endsWith('.py') || p.endsWith('.ts')) total += c;
    }
    const fullTokens = total.length / 4;
    const results = service.searchSemantic('test-tokens-sem', 'authentication', { topK: 3 });
    let indexed = '';
    for (const r of results) {
      const s = service.getSymbol('test-tokens-sem', r.id);
      if (s) indexed += s.body;
    }
    const indexedTokens = indexed.length / 4;
    const reduction = 1 - (indexedTokens / fullTokens);
    console.log(`  Codebase token reduction: ${(reduction * 100).toFixed(1)}% (full: ~${Math.round(fullTokens)}, indexed: ~${Math.round(indexedTokens)})`);
    assert.ok(reduction > 0.5, `Expected >50% reduction, got ${(reduction*100).toFixed(1)}%`);
  });

  it('should index in under 1 second', () => {
    const service = new CodeIndexService();
    const start = Date.now();
    service.indexFolder(FIXTURE_DIR, 'test-perf');
    const elapsed = Date.now() - start;
    console.log(`  Indexing time: ${elapsed}ms`);
    assert.ok(elapsed < 1000);
  });

  it('should handle repo not found', () => {
    const service = new CodeIndexService();
    const tree = service.getFileTree('nonexistent');
    assert.equal(tree, null);
  });

  it('should handle symbol not found', () => {
    const service = new CodeIndexService();
    service.indexFolder(FIXTURE_DIR, 'test-edge');
    const sym = service.getSymbol('test-edge', 'nonexistent-id');
    assert.equal(sym, null);
  });
});