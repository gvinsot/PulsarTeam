/**
 * fsGuard confinement tests — the bridge's trust boundary. Pure Node, runnable
 * without the GUI: `node --import tsx --test test/fsGuard.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FolderGuard, GuardError, dispatchFsTool } from '../src/fsGuard.ts';

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsguard-'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'hello world');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'data.csv'), 'a,b\n1,2');
  return fs.realpathSync.native(root);
}

test('lists, reads and reports relative paths within the root', () => {
  const root = makeTree();
  const g = new FolderGuard();
  g.setRoots([root]);
  const listing = g.listFiles('.');
  const names = listing.entries.map(e => e.name).sort();
  assert.deepEqual(names, ['note.txt', 'sub']);
  assert.equal(g.readTextFile('note.txt').content, 'hello world');
});

test('write without overwrite lands in pulsar-output/', () => {
  const root = makeTree();
  const g = new FolderGuard();
  g.setRoots([root]);
  const res = g.writeTextFile('report.md', '# hi', false);
  assert.match(res.path.replace(/\\/g, '/'), /^pulsar-output\/report\.md$/);
  assert.ok(fs.existsSync(path.join(root, 'pulsar-output', 'report.md')));
});

test('write with overwrite writes in place', () => {
  const root = makeTree();
  const g = new FolderGuard();
  g.setRoots([root]);
  g.writeTextFile('note.txt', 'changed', true);
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'changed');
});

test('blocks ../ traversal', () => {
  const root = makeTree();
  const g = new FolderGuard();
  g.setRoots([root]);
  assert.throws(() => g.readTextFile('../../../etc/passwd'), (e: any) => e instanceof GuardError && e.code === 'EACCES');
});

test('strips an absolute path back into the root instead of escaping', () => {
  const root = makeTree();
  const g = new FolderGuard();
  g.setRoots([root]);
  // An absolute path is treated as relative-to-root; it must resolve INSIDE root.
  const resolved = g.resolve(process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/passwd');
  assert.ok(resolved.startsWith(root), `expected ${resolved} under ${root}`);
});

test('rejects UNC / device paths', () => {
  const root = makeTree();
  const g = new FolderGuard();
  g.setRoots([root]);
  assert.throws(() => g.resolve('\\\\server\\share\\x'), (e: any) => e instanceof GuardError && e.code === 'EACCES');
});

test('blocks a symlink that escapes the root', { skip: process.platform === 'win32' ? 'symlink perms' : false }, () => {
  const root = makeTree();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(root, 'link'));
  const g = new FolderGuard();
  g.setRoots([root]);
  assert.throws(() => g.readTextFile('link/secret.txt'), (e: any) => e instanceof GuardError && e.code === 'EACCES');
});

test('search finds by filename and dispatch routes fs tools', () => {
  const root = makeTree();
  const g = new FolderGuard();
  g.setRoots([root]);
  const res = dispatchFsTool(g, 'search_files', { query: 'data' });
  assert.ok(res.matches.some((m: any) => m.path.endsWith('sub/data.csv')));
});
