import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CodeIndexService, formatIndexAge } from '../codeIndexService.js';
import { createCodeIndexMcpServer } from '../codeIndexMcp.js';
import { InMemoryVectorStore } from '../codeSearch/vectorStore.js';

const execFileAsync = promisify(execFile);

async function withRepo(
  run: (ctx: { repoDir: string; service: CodeIndexService }) => Promise<void>
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-index-freshness-'));
  try {
    const repoDir = path.join(tempDir, 'fresh-repo');
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'src', 'math.js'),
      'export function addNumbers(a, b) {\n  return a + b;\n}\n'
    );
    await fs.writeFile(
      path.join(repoDir, 'src', 'strings.js'),
      'export function shoutText(value) {\n  return value.toUpperCase();\n}\n'
    );
    const service = new CodeIndexService({
      storageRoot: path.join(tempDir, '.index-data'),
      allowedRoots: [tempDir],
      vectorStoreFactory: async () => new InMemoryVectorStore(),
    });
    await run({ repoDir, service });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Push a file's mtime forward so the change is seen even on coarse-mtime filesystems. */
async function bumpMtime(filePath: string, seconds = 10) {
  const future = new Date(Date.now() + seconds * 1000);
  await fs.utimes(filePath, future, future);
}

async function git(cwd: string, ...args: string[]) {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

test('formatIndexAge renders compact durations', () => {
  assert.equal(formatIndexAge(5_000), '5s');
  assert.equal(formatIndexAge(3 * 60_000), '3m');
  assert.equal(formatIndexAge((2 * 60 + 5) * 60_000), '2h 5m');
  assert.equal(formatIndexAge(26 * 3_600_000), '1d 2h');
  assert.equal(formatIndexAge(-10), '0s');
});

test('getFreshness reports a fresh index, then modified/added/deleted files', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const repo = await service.indexFolder({ folderPath: repoDir });

    const fresh = await service.getFreshness(repo.id);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.changedFileCount, 0);
    assert.equal(fresh.indexedAt, repo.indexedAt);
    assert.ok(fresh.indexAgeMs >= 0);
    assert.match(fresh.indexAge, /^\d+s$/);

    await fs.writeFile(
      path.join(repoDir, 'src', 'math.js'),
      'export function multiplyNumbers(a, b) {\n  return a * b;\n}\n'
    );
    await bumpMtime(path.join(repoDir, 'src', 'math.js'));
    await fs.writeFile(path.join(repoDir, 'src', 'extra.js'), 'export const extra = () => 1;\n');
    await fs.rm(path.join(repoDir, 'src', 'strings.js'));

    // Cached for a few seconds...
    assert.equal((await service.getFreshness(repo.id)).stale, false);
    // ...unless the cache is bypassed.
    const stale = await service.getFreshness(repo.id, { useCache: false });
    assert.equal(stale.stale, true);
    assert.equal(stale.changedFileCount, 3);
    assert.deepEqual(stale.changedFiles, {
      modified: ['src/math.js'],
      added: ['src/extra.js'],
      deleted: ['src/strings.js'],
    });
    assert.equal(stale.changedFilesTruncated, false);
  });
});

test('getFreshness ignores files touched without content changes', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const repo = await service.indexFolder({ folderPath: repoDir });
    await bumpMtime(path.join(repoDir, 'src', 'math.js'));
    const freshness = await service.getFreshness(repo.id, { useCache: false });
    assert.equal(freshness.stale, false);

    // A sync then records the new mtime so the file is no longer re-read.
    const sync = await service.syncRepo(repo.id);
    assert.equal(sync.touched, 1);
    assert.equal(sync.updated, 0);
    const index = await service.loadIndex(repo.id);
    const stat = await fs.stat(path.join(repoDir, 'src', 'math.js'));
    assert.equal(index.files.find(file => file.path === 'src/math.js')?.mtimeMs, stat.mtimeMs);
  });
});

test('getFreshness reports a vanished root without throwing', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const repo = await service.indexFolder({ folderPath: repoDir });
    await fs.rm(repoDir, { recursive: true, force: true });
    const freshness = await service.getFreshness(repo.id, { useCache: false });
    assert.equal(freshness.stale, null);
    assert.match(freshness.error ?? '', /Could not scan/);
    await assert.rejects(service.syncRepo(repo.id), /no longer exists/);
  });
});

test('syncRepo re-indexes only what changed and keeps searches consistent', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const repo = await service.indexFolder({ folderPath: repoDir });
    const before = await service.loadIndex(repo.id);
    const untouchedRecord = before.files.find(file => file.path === 'src/strings.js');

    await fs.writeFile(
      path.join(repoDir, 'src', 'math.js'),
      'export function multiplyNumbers(a, b) {\n  return a * b;\n}\n'
    );
    await bumpMtime(path.join(repoDir, 'src', 'math.js'));
    await fs.writeFile(
      path.join(repoDir, 'src', 'extra.js'),
      'export function extraHelper() {\n  return 1;\n}\n'
    );

    const sync = await service.syncRepo(repo.id);
    assert.equal(sync.added, 1);
    assert.equal(sync.updated, 1);
    assert.equal(sync.removed, 0);
    assert.equal(sync.unchanged, 1);
    assert.deepEqual(sync.changedFiles.modified, ['src/math.js']);
    assert.deepEqual(sync.changedFiles.added, ['src/extra.js']);
    assert.ok(sync.repo.lastSyncedAt);
    assert.equal(sync.repo.filesIndexed, 3);

    const after = await service.loadIndex(repo.id);
    // The untouched file record was kept as-is, not re-parsed.
    assert.equal(
      after.files.find(file => file.path === 'src/strings.js'),
      untouchedRecord
    );
    assert.deepEqual(
      after.files.map(file => file.path),
      ['src/extra.js', 'src/math.js', 'src/strings.js']
    );

    assert.equal((await service.searchSymbols(repo.id, { query: 'addNumbers' })).length, 0);
    const [hit] = await service.searchSymbols(repo.id, { query: 'multiplyNumbers' });
    assert.equal(hit.filePath, 'src/math.js');
    const semantic = await service.searchSemantic(repo.id, { query: 'extraHelper' });
    assert.ok(semantic.some(result => result.qualifiedName === 'extraHelper'));

    // Removing a file drops its symbols.
    await fs.rm(path.join(repoDir, 'src', 'extra.js'));
    const removal = await service.syncRepo(repo.id);
    assert.equal(removal.removed, 1);
    assert.equal((await service.searchSymbols(repo.id, { query: 'extraHelper' })).length, 0);
    assert.equal((await service.getFreshness(repo.id)).stale, false);

    // A sync of an up-to-date repo changes nothing.
    const noop = await service.syncRepo(repo.id);
    assert.equal(noop.added + noop.updated + noop.removed + noop.touched, 0);
    assert.equal(noop.unchanged, 2);
  });
});

test('syncRepo heals indexes written before mtimes were tracked', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const repo = await service.indexFolder({ folderPath: repoDir });
    const index = await service.loadIndex(repo.id);
    for (const file of index.files) delete file.mtimeMs;
    await service.saveIndex(index);
    service._invalidateCache(repo.id);

    // Without mtimes every file is hashed: still not stale since contents match.
    assert.equal((await service.getFreshness(repo.id, { useCache: false })).stale, false);
    const sync = await service.syncRepo(repo.id);
    assert.equal(sync.touched, 2);
    assert.ok((await service.loadIndex(repo.id)).files.every(file => file.mtimeMs !== undefined));
  });
});

test('updateFiles records the disk mtime only when the indexed content is on disk', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const repo = await service.indexFolder({ folderPath: repoDir });
    const mathPath = path.join(repoDir, 'src', 'math.js');
    const content = 'export function subtractNumbers(a, b) {\n  return a - b;\n}\n';

    await service.updateFiles(repo.id, [{ path: 'src/math.js', content }]);
    let record = (await service.loadIndex(repo.id)).files.find(f => f.path === 'src/math.js');
    assert.equal(record?.mtimeMs, undefined);
    assert.equal((await service.getFreshness(repo.id, { useCache: false })).stale, true);

    await fs.writeFile(mathPath, content);
    await service.updateFiles(repo.id, [{ path: 'src/math.js', content }]);
    record = (await service.loadIndex(repo.id)).files.find(f => f.path === 'src/math.js');
    assert.equal(record?.mtimeMs, (await fs.stat(mathPath)).mtimeMs);
    assert.equal((await service.getFreshness(repo.id, { useCache: false })).stale, false);
  });
});

test('git state is recorded at indexing and HEAD moves are reported', async t => {
  await withRepo(async ({ repoDir, service }) => {
    try {
      await git(repoDir, 'init', '-q', '-b', 'main');
      await git(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
      await git(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
    } catch {
      t.skip('git unavailable');
      return;
    }
    const repo = await service.indexFolder({ folderPath: repoDir });
    assert.match(repo.git?.commit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(repo.git?.branch, 'main');

    await fs.writeFile(path.join(repoDir, 'README.md'), 'docs only\n');
    await git(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    await git(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'two');

    const freshness = await service.getFreshness(repo.id, { useCache: false });
    // Only a non-indexed file changed: the index content is still accurate.
    assert.equal(freshness.stale, false);
    assert.equal(freshness.git?.headMoved, true);
    assert.equal(freshness.git?.indexedCommit, repo.git?.commit);
    assert.notEqual(freshness.git?.currentCommit, repo.git?.commit);

    // ensure_indexed syncs on a moved HEAD, which records the new commit.
    const ensured = await service.ensureIndexed({ folderPath: repoDir });
    assert.equal(ensured.action, 'synced');
    assert.equal(ensured.repo.git?.commit, freshness.git?.currentCommit);
    assert.equal(ensured.freshness.git?.headMoved, false);
  });
});

test('ensureIndexed indexes, then reports fresh, then syncs after a change', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const first = await service.ensureIndexed({ folderPath: repoDir, repoName: 'Fresh' });
    assert.equal(first.action, 'indexed');
    assert.equal(first.repo.name, 'Fresh');
    assert.equal(first.freshness.stale, false);

    const second = await service.ensureIndexed({ folderPath: repoDir });
    assert.equal(second.action, 'fresh');
    assert.equal(second.repoId, first.repoId);
    assert.equal(second.sync, undefined);

    await fs.writeFile(path.join(repoDir, 'src', 'extra.js'), 'export const extra = () => 1;\n');
    const third = await service.ensureIndexed({ folderPath: repoDir });
    assert.equal(third.action, 'synced');
    assert.equal(third.repoId, first.repoId);
    assert.equal(third.sync?.added, 1);
    assert.equal(third.freshness.stale, false);

    assert.equal((await service.listRepos()).length, 1);
    await assert.rejects(service.ensureIndexed({ folderPath: '/etc' }), /outside allowed roots/);
  });
});

test('Code Index MCP exposes freshness on searches, sync, check_freshness and ensure_indexed', async () => {
  await withRepo(async ({ repoDir, service }) => {
    const server = createCodeIndexMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const textOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      (result.content as { text: string }[])[0].text;
    const jsonOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      JSON.parse(textOf(result).split('\nJSON:\n')[1]);
    try {
      const ensured = await client.callTool({
        name: 'ensure_indexed',
        arguments: { path: repoDir, repoName: 'FreshRepo' },
      });
      assert.match(textOf(ensured), /No index existed — indexed it/);
      const { repoId } = jsonOf(ensured);
      assert.ok(repoId);

      for (const name of ['search_symbols', 'search_semantic', 'search_text']) {
        const result = await client.callTool({
          name,
          arguments: { repoName: 'FreshRepo', query: 'addNumbers' },
        });
        assert.match(textOf(result), /^Index is fresh \(index age \d+s/, name);
        assert.doesNotMatch(textOf(result).split('\nJSON:\n')[0], /\\n/, name);
        const json = jsonOf(result);
        assert.equal(json.freshness.stale, false, name);
        assert.ok(Array.isArray(json.results), name);
      }

      await fs.writeFile(
        path.join(repoDir, 'src', 'math.js'),
        'export function addNumbers(a, b, c) {\n  return a + b + c;\n}\n'
      );
      await bumpMtime(path.join(repoDir, 'src', 'math.js'));

      const check = await client.callTool({ name: 'check_freshness', arguments: { repoId } });
      assert.match(textOf(check), /Index is STALE/);
      assert.match(textOf(check), /modified: src\/math\.js/);
      assert.match(textOf(check), /Run sync/);

      const summary = await client.callTool({ name: 'get_repo_summary', arguments: { repoId } });
      assert.equal(jsonOf(summary).freshness.stale, true);

      const sync = await client.callTool({ name: 'sync', arguments: { repoName: 'FreshRepo' } });
      assert.match(textOf(sync), /~1 updated/);
      assert.equal(jsonOf(sync).updated, 1);

      const after = await client.callTool({
        name: 'search_symbols',
        arguments: { repoId, query: 'addNumbers' },
      });
      assert.match(textOf(after), /^Index is fresh/);

      const again = await client.callTool({ name: 'ensure_indexed', arguments: { path: repoDir } });
      assert.match(textOf(again), /Index already up to date/);
      assert.equal(jsonOf(again).repoId, repoId);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
