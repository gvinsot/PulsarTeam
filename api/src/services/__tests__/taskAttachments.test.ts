import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentsForPrompt,
  sanitizeAttachmentName,
  uniqueAttachmentName,
  type TaskAttachment,
} from '../../lib/taskAttachments.js';
import { taskContentForPrompt } from '../../lib/taskTrust.js';
import { deliverTaskAttachments } from '../execution/taskAttachmentDelivery.js';

test('sanitizeAttachmentName keeps one safe path segment', () => {
  assert.equal(sanitizeAttachmentName('report.pdf'), 'report.pdf');
  assert.equal(sanitizeAttachmentName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeAttachmentName('C:\\Users\\me\\plan.xlsx'), 'plan.xlsx');
  assert.equal(sanitizeAttachmentName('.bashrc'), 'bashrc');
  assert.equal(sanitizeAttachmentName('a\u0000b\nc?.txt'), 'abc_.txt');
  assert.equal(sanitizeAttachmentName(''), 'file');
  assert.equal(sanitizeAttachmentName(undefined), 'file');
  const long = sanitizeAttachmentName(`${'x'.repeat(300)}.docx`);
  assert.equal(long.length, 180);
  assert.ok(long.endsWith('.docx'));
});

test('uniqueAttachmentName numbers collisions before the extension', () => {
  assert.equal(uniqueAttachmentName('a.pdf', []), 'a.pdf');
  assert.equal(uniqueAttachmentName('a.pdf', ['a.pdf']), 'a (2).pdf');
  assert.equal(uniqueAttachmentName('a.pdf', ['a.pdf', 'a (2).pdf']), 'a (3).pdf');
  assert.equal(uniqueAttachmentName('README', ['README']), 'README (2)');
});

test('the prompt lists delivered paths, and nothing when there are none', () => {
  const files = [
    {
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      path: '/h/task-files/t/spec.pdf',
    },
  ];
  assert.match(
    attachmentsForPrompt(files),
    /\/h\/task-files\/t\/spec\.pdf \(application\/pdf, 2\.0 KB\)/
  );
  assert.equal(attachmentsForPrompt([]), '');
  assert.match(
    taskContentForPrompt({ text: 'do it', materializedAttachments: files }),
    /<task_attachments>/
  );
  assert.doesNotMatch(taskContentForPrompt({ text: 'do it' }), /task_attachments/);
});

function attachment(id: string, filename: string): TaskAttachment {
  return {
    id,
    taskId: 't1',
    filename,
    mimeType: 'text/plain',
    size: 3,
    sha256: `sha-${id}`,
    uploadedBy: null,
    uploadedByName: null,
    createdAt: null,
  };
}

test('delivery writes only what the runner lacks and returns every path', async () => {
  const written: string[] = [];
  const manager = {
    async syncTaskFiles(_agentId: string, _taskId: string, files: { name: string }[]) {
      assert.deepEqual(
        files.map(f => f.name),
        ['a.txt', 'b.txt']
      );
      return { dir: '/home/agent/task-files/t1', missing: ['b.txt'] };
    },
    async writeTaskFile(_agentId: string, _taskId: string, name: string, data: Buffer) {
      written.push(`${name}:${data.toString()}`);
      return `/home/agent/task-files/t1/${name}`;
    },
  };
  const store = {
    list: async () => [attachment('1', 'a.txt'), attachment('2', 'b.txt')],
    read: async (_taskId: string, id: string) => ({ data: Buffer.from(`d${id}`) }),
  };
  const out = await deliverTaskAttachments(manager, 'agent', 't1', store);
  assert.deepEqual(written, ['b.txt:d2']);
  assert.deepEqual(
    out.map(f => f.path),
    ['/home/agent/task-files/t1/a.txt', '/home/agent/task-files/t1/b.txt']
  );
});

test('delivery fails loudly when files exist but cannot reach the runner', async () => {
  const manager = {
    syncTaskFiles: async () => {
      throw new Error('runner down');
    },
    writeTaskFile: async () => '',
  };
  const withFiles = { list: async () => [attachment('1', 'a.txt')], read: async () => null };
  await assert.rejects(deliverTaskAttachments(manager, 'a', 't1', withFiles), /runner down/);
  const empty = { list: async () => [], read: async () => null };
  assert.deepEqual(await deliverTaskAttachments(manager, 'a', 't1', empty), []);
  assert.deepEqual(await deliverTaskAttachments(null, 'a', 't1', withFiles), []);
});
