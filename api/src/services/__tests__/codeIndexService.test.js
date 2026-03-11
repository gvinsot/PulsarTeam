import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { CodeIndexService } from '../codeIndexService.js';
import { InMemoryVectorStore } from '../codeSearch/vectorStore.js';

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-service-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeFixtureRepo(rootDir) {
  const repoDir = path.join(rootDir, 'sample-repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });

  await fs.writeFile(path.join(repoDir, 'src', 'auth.js'), `
// Auth service for access control
export class AuthService {
  // Validate an incoming token
  async validateToken(token) {
    return token && token.startsWith('tok_');
  }

  async login(username, password) {
    return Boolean(username && password);
  }
}

export const createToken = (payload) => {
  return 'tok_' + JSON.stringify(payload);
};
`.trimStart());

  await fs.writeFile(path.join(repoDir, 'src', 'parser.py'), `
class Parser:
    \"\"\"Parser utilities for source files.\"\"\"

    def parse_text(self, value):
        \"\"\"Parse source text.\"\"\"
        return value.strip()
`.trimStart());

  return repoDir;
}

test('CodeIndexService indexes a folder and exposes outlines, trees and symbol retrieval', async () => {
  await withTempDir(async (tempDir) => {
    const repoDir = await writeFixtureRepo(tempDir);
    const service = new CodeIndexService({
      storageRoot: path.join(tempDir, '.index-data'),
      allowedRoots: [tempDir],
      vectorStoreFactory: async () => new InMemoryVectorStore(),
    });

    const repo = await service.indexFolder({ folderPath: repoDir, repoName: 'demo-repo' });

    assert.equal(repo.name, 'demo-repo');
    assert.equal(repo.filesIndexed, 2);
    assert.ok(repo.symbolsIndexed >= 4);

    const repos = await service.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].id, repo.id);

    const tree = await service.getFileTree(repo.id);
    assert.equal(tree.type, 'directory');
    assert.ok(tree.children.some((child) => child.name === 'src'));

    const outline = await service.getFileOutline(repo.id, 'src/auth.js');
    assert.equal(outline.file.path, 'src/auth.js');
    assert.ok(outline.symbols.some((symbol) => symbol.qualifiedName === 'AuthService.validateToken'));
    assert.ok(outline.symbols.some((symbol) => symbol.qualifiedName === 'createToken'));

    const symbolSearch = await service.searchSymbols(repo.id, { query: 'validateToken', topK: 5 });
    assert.ok(symbolSearch.length >= 1);
    assert.equal(symbolSearch[0].qualifiedName, 'AuthService.validateToken');

    const semanticSearch = await service.searchSemantic(repo.id, { query: 'token validation', topK: 5 });
    assert.ok(semanticSearch.some((result) => result.qualifiedName === 'AuthService.validateToken'));

    const targetSymbol = outline.symbols.find((symbol) => symbol.qualifiedName === 'AuthService.validateToken');
    const symbol = await service.getSymbol(repo.id, targetSymbol.id, { verify: true, contextLines: 1 });
    assert.equal(symbol.driftDetected, false);
    assert.ok(symbol.currentSource.includes('validateToken(token)'));
    assert.ok(symbol.source.includes('return token && token.startsWith'));
  });
});

test('CodeIndexService rejects folders outside allowed roots and invalidates repositories', async () => {
  await withTempDir(async (tempDir) => {
    const repoDir = await writeFixtureRepo(tempDir);
    const service = new CodeIndexService({
      storageRoot: path.join(tempDir, '.index-data'),
      allowedRoots: [repoDir],
      vectorStoreFactory: async () => new InMemoryVectorStore(),
    });

    await assert.rejects(
      () => service.indexFolder({ folderPath: path.dirname(tempDir) }),
      /outside allowed roots/
    );

    const indexed = await service.indexFolder({ folderPath: repoDir });
    const summary = await service.getRepoSummary(indexed.id);
    assert.equal(summary.counts.files, 2);
    assert.ok(summary.counts.symbols >= 4);

    await service.invalidate(indexed.id);
    const repos = await service.listRepos();
    assert.equal(repos.length, 0);
  });
});