/**
 * Full-text search on raw code, pathPrefix filters on the symbol searches, and
 * find_files — service level and through the MCP surface.
 */
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test, { describe } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodeIndexService } from '../codeIndexService.js';
import { createCodeIndexMcpServer } from '../codeIndexMcp.js';
import { InMemoryVectorStore } from '../codeSearch/vectorStore.js';
import {
  compileFilePattern,
  compilePathFilter,
  globToRegExpSource,
} from '../codeSearch/pathFilter.js';

// A function body well past the 16 KB stored per symbol, with a literal at the end.
const HUGE_BODY = Array.from({ length: 900 }, (_, i) => `  const filler${i} = ${i};`).join('\n');

const FILES: Record<string, string> = {
  'api/src/auth.ts': [
    "import jwt from 'jsonwebtoken';",
    "const ERROR_TOKEN = 'Token expired, please log in again';",
    'export function verifyToken(token: string) {',
    '  return jwt.verify(token, process.env.JWT_SECRET);',
    '}',
    '',
  ].join('\n'),
  'api/src/routes/users.ts': [
    'export function listUsers() {',
    "  throw new Error('Token expired, please log in again');",
    '}',
    '',
  ].join('\n'),
  'frontend/src/auth.ts': [
    'export function verifyToken(token: string) {',
    '  return token.length > 0;',
    '}',
    '',
  ].join('\n'),
  'frontend/src/huge.ts': [
    'export function hugeFunction() {',
    HUGE_BODY,
    "  return 'NEEDLE_AT_THE_END';",
    '}',
    '',
  ].join('\n'),
  'packages/core/src/index.ts': 'export function coreEntry() {\n  return tokenize("a");\n}\n',
  'packages/core/test/index.test.ts': 'export function coreTest() {\n  return 1;\n}\n',
};

async function withRepo(
  run: (ctx: { repoId: string; service: CodeIndexService; repoDir: string }) => Promise<void>
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-fulltext-'));
  try {
    const repoDir = path.join(tempDir, 'mono');
    for (const [rel, content] of Object.entries(FILES)) {
      await fs.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
      await fs.writeFile(path.join(repoDir, rel), content);
    }
    const service = new CodeIndexService({
      storageRoot: path.join(tempDir, '.index-data'),
      allowedRoots: [tempDir],
      vectorStoreFactory: async () => new InMemoryVectorStore(),
    });
    const indexed = await service.indexFolder({ folderPath: repoDir, repoName: 'Mono' });
    await run({ repoId: indexed.id, service, repoDir });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe('pathFilter', () => {
  test('plain prefixes and empty filters', () => {
    assert.equal(compilePathFilter(undefined), null);
    assert.equal(compilePathFilter(''), null);
    assert.equal(compilePathFilter('./'), null);
    const api = compilePathFilter('./api/src/');
    assert.ok(api);
    assert.equal(api('api/src/auth.ts'), true);
    assert.equal(api('frontend/src/auth.ts'), false);
  });

  test('globs match the whole path or a leading directory', () => {
    const src = compilePathFilter('packages/*/src');
    assert.ok(src);
    assert.equal(src('packages/core/src/index.ts'), true);
    assert.equal(src('packages/core/test/index.test.ts'), false);

    const tests = compilePathFilter('**/*.test.ts');
    assert.ok(tests);
    assert.equal(tests('packages/core/test/index.test.ts'), true);
    assert.equal(tests('index.test.ts'), true);
    assert.equal(tests('packages/core/src/index.ts'), false);

    const alt = compilePathFilter('{api,frontend}/src/*.ts');
    assert.ok(alt);
    assert.equal(alt('api/src/auth.ts'), true);
    assert.equal(alt('frontend/src/huge.ts'), true);
    assert.equal(alt('api/src/routes/users.ts'), false);
  });

  test('glob syntax: ?, classes, escaping', () => {
    assert.equal(new RegExp(`^${globToRegExpSource('a?c')}$`).test('abc'), true);
    assert.equal(new RegExp(`^${globToRegExpSource('a?c')}$`).test('a/c'), false);
    assert.equal(new RegExp(`^${globToRegExpSource('[!x]y')}$`).test('ay'), true);
    assert.equal(new RegExp(`^${globToRegExpSource('[!x]y')}$`).test('xy'), false);
    assert.equal(new RegExp(`^${globToRegExpSource('a.b(1)')}$`).test('a.b(1)'), true);
    assert.equal(new RegExp(`^${globToRegExpSource('a.b')}$`).test('axb'), false);
    // Unbalanced brace still compiles.
    assert.doesNotThrow(() => new RegExp(globToRegExpSource('{a,b')));
  });

  test('file patterns: substring, name glob, path glob', () => {
    assert.equal(compileFilePattern('AUTH')('api/src/auth.ts'), true);
    assert.equal(compileFilePattern('*.test.ts')('packages/core/test/index.test.ts'), true);
    assert.equal(compileFilePattern('*.ts')('api/src/auth.ts'), true);
    assert.equal(compileFilePattern('src/*.ts')('api/src/auth.ts'), false);
    assert.equal(compileFilePattern('**/src/*.ts')('api/src/auth.ts'), true);
    assert.throws(() => compileFilePattern('  '), /must not be empty/);
  });
});

test('searchFulltext finds literals outside symbols and past the 16 KB symbol cap', async () => {
  await withRepo(async ({ repoId, service }) => {
    // Module-level constant: not inside any symbol.
    const literal = await service.searchFulltext(repoId, { query: 'token expired' });
    assert.equal(literal.totalMatches, 2);
    assert.deepEqual(literal.matches.map(m => `${m.filePath}:${m.line}`).sort(), [
      'api/src/auth.ts:2',
      'api/src/routes/users.ts:2',
    ]);
    const moduleLevel = literal.matches.find(m => m.filePath === 'api/src/auth.ts');
    assert.equal(moduleLevel?.enclosingSymbol, null);
    const inFunction = literal.matches.find(m => m.filePath === 'api/src/routes/users.ts');
    assert.equal(inFunction?.enclosingSymbol?.qualifiedName, 'listUsers');
    assert.equal(inFunction?.column, 20);

    // The symbol-only search cannot see past the stored (truncated) source.
    const symbolText = await service.searchText(repoId, { query: 'NEEDLE_AT_THE_END' });
    assert.equal(symbolText.length, 0);
    const full = await service.searchFulltext(repoId, { query: 'NEEDLE_AT_THE_END' });
    assert.equal(full.totalMatches, 1);
    assert.equal(full.matches[0].filePath, 'frontend/src/huge.ts');
    assert.equal(full.matches[0].line, 902);
    assert.equal(full.matches[0].enclosingSymbol?.qualifiedName, 'hugeFunction');
  });
});

test('searchFulltext options: case, regex, whole word, pathPrefix, limits, context', async () => {
  await withRepo(async ({ repoId, service }) => {
    const insensitive = await service.searchFulltext(repoId, { query: 'TOKEN EXPIRED' });
    assert.equal(insensitive.totalMatches, 2);
    const sensitive = await service.searchFulltext(repoId, {
      query: 'TOKEN EXPIRED',
      caseSensitive: true,
    });
    assert.equal(sensitive.totalMatches, 0);

    // Literal by default: regex metacharacters are not interpreted.
    const literalDot = await service.searchFulltext(repoId, { query: 'jwt.verify(' });
    assert.equal(literalDot.totalMatches, 1);
    const regex = await service.searchFulltext(repoId, {
      query: 'filler(1|2)\\d\\d\\b',
      regex: true,
    });
    assert.equal(regex.totalMatches, 200);
    assert.equal(regex.matches[0].match, 'filler100');
    await assert.rejects(
      service.searchFulltext(repoId, { query: '(unclosed', regex: true }),
      /invalid regular expression/
    );

    // "token" as a word skips verifyToken / tokenize / ERROR_TOKEN.
    const word = await service.searchFulltext(repoId, {
      query: 'token',
      wholeWord: true,
      pathPrefix: 'frontend/',
    });
    assert.deepEqual(
      word.matches.map(m => m.line),
      [1, 2]
    );
    const prefixed = await service.searchFulltext(repoId, {
      query: 'verifyToken',
      pathPrefix: 'api/**',
    });
    assert.deepEqual(
      prefixed.matches.map(m => m.filePath),
      ['api/src/auth.ts']
    );
    assert.equal(prefixed.filesSearched, 2);

    const limited = await service.searchFulltext(repoId, {
      query: 'filler',
      limit: 5,
      maxMatchesPerFile: 3,
    });
    assert.equal(limited.totalMatches, 900);
    assert.equal(limited.returned, 3);
    assert.equal(limited.truncated, true);
    assert.equal(limited.perFileTruncated, true);

    const context = await service.searchFulltext(repoId, {
      query: 'jwt.verify',
      contextLines: 1,
    });
    assert.deepEqual(context.matches[0].before, ['export function verifyToken(token: string) {']);
    assert.deepEqual(context.matches[0].after, ['}']);
  });
});

test('searchFulltext reports indexed files deleted from disk', async () => {
  await withRepo(async ({ repoId, service, repoDir }) => {
    await fs.rm(path.join(repoDir, 'api/src/auth.ts'));
    const result = await service.searchFulltext(repoId, { query: 'token expired' });
    assert.deepEqual(result.unreadableFiles, ['api/src/auth.ts']);
    assert.equal(result.totalMatches, 1);
  });
});

test('pathPrefix filters search_symbols, search_text and search_semantic', async () => {
  await withRepo(async ({ repoId, service }) => {
    const all = await service.searchSymbols(repoId, { query: 'verifyToken' });
    assert.deepEqual(all.map(hit => hit.filePath).sort(), [
      'api/src/auth.ts',
      'frontend/src/auth.ts',
    ]);
    const front = await service.searchSymbols(repoId, {
      query: 'verifyToken',
      pathPrefix: 'frontend/',
    });
    assert.deepEqual(
      front.map(hit => hit.filePath),
      ['frontend/src/auth.ts']
    );

    const text = await service.searchText(repoId, { query: 'token', pathPrefix: 'api/src/*.ts' });
    assert.ok(text.length > 0);
    assert.ok(text.every(hit => hit.filePath === 'api/src/auth.ts'));

    const semantic = await service.searchSemantic(repoId, {
      query: 'core entry tokenize',
      pathPrefix: 'packages/*/src',
    });
    assert.ok(semantic.length > 0);
    assert.ok(semantic.every(hit => hit.filePath.startsWith('packages/core/src/')));
    const none = await service.searchSemantic(repoId, { query: 'x', pathPrefix: 'nowhere/' });
    assert.deepEqual(none, []);
  });
});

test('findFiles by substring, name glob and path glob', async () => {
  await withRepo(async ({ repoId, service }) => {
    const byName = await service.findFiles(repoId, { pattern: 'auth.ts' });
    assert.deepEqual(
      byName.files.map(file => file.path),
      ['api/src/auth.ts', 'frontend/src/auth.ts']
    );
    const tests = await service.findFiles(repoId, { pattern: '*.test.ts' });
    assert.deepEqual(
      tests.files.map(file => file.path),
      ['packages/core/test/index.test.ts']
    );
    const routes = await service.findFiles(repoId, { pattern: 'api/**/*.ts' });
    assert.equal(routes.total, 2);
    const scoped = await service.findFiles(repoId, { pattern: '*.ts', pathPrefix: 'frontend/' });
    assert.equal(scoped.total, 2);
    const limited = await service.findFiles(repoId, { pattern: '*.ts', limit: 2 });
    assert.equal(limited.total, 6);
    assert.equal(limited.files.length, 2);
    assert.equal(limited.truncated, true);
  });
});

test('Code Index MCP exposes search_fulltext, find_files and pathPrefix', async () => {
  await withRepo(async ({ service }) => {
    const server = createCodeIndexMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const textOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      (result.content as { text: string }[])[0].text;
    const jsonOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      JSON.parse(textOf(result).split('\nJSON:\n')[1]);
    try {
      const fulltext = await client.callTool({
        name: 'search_fulltext',
        arguments: { repoName: 'Mono', query: 'Token expired', pathPrefix: 'api/src/routes' },
      });
      assert.match(textOf(fulltext), /^Index is fresh/);
      assert.match(textOf(fulltext), /1 matching line\(s\) in 1 of 1 file\(s\)/);
      assert.match(textOf(fulltext), /api\/src\/routes\/users\.ts:2 \[in listUsers\]/);
      const json = jsonOf(fulltext);
      assert.equal(json.freshness.stale, false);
      assert.equal(json.results.length, 1);

      const files = await client.callTool({
        name: 'find_files',
        arguments: { repoName: 'Mono', pattern: '*.test.ts' },
      });
      assert.match(textOf(files), /1 file\(s\) match/);
      assert.equal(jsonOf(files).files[0].path, 'packages/core/test/index.test.ts');

      for (const name of ['search_symbols', 'search_semantic', 'search_text']) {
        const result = await client.callTool({
          name,
          arguments: { repoName: 'Mono', query: 'verifyToken', pathPrefix: 'frontend/' },
        });
        const results = jsonOf(result).results as { filePath: string }[];
        assert.ok(results.length > 0, name);
        assert.ok(
          results.every(hit => hit.filePath.startsWith('frontend/')),
          name
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
