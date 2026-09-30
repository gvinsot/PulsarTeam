import { createHash } from 'crypto';
import { getPool } from './connection.js';
import {
  MAX_ATTACHMENTS_PER_TASK,
  uniqueAttachmentName,
  type TaskAttachment,
} from '../../lib/taskAttachments.js';

// Files attached to a task. The bytes live in `data` (bytea) and are only read
// by getTaskAttachmentData: every listing selects metadata columns alone.

const META_COLUMNS =
  'id, task_id, filename, mime_type, size, sha256, uploaded_by, uploaded_by_name, created_at';

interface TaskAttachmentRow {
  id: string;
  task_id: string;
  filename: string;
  mime_type: string;
  size: number;
  sha256: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: Date | null;
}

function rowToAttachment(row: TaskAttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
  };
}

function requirePool() {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  return pool;
}

export async function listTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
  const { rows } = await requirePool().query<TaskAttachmentRow>(
    `SELECT ${META_COLUMNS} FROM task_attachments WHERE task_id = $1 ORDER BY created_at, filename`,
    [taskId]
  );
  return rows.map(rowToAttachment);
}

/** Metadata + bytes of one attachment, or null when it is not on that task. */
export async function getTaskAttachmentData(
  taskId: string,
  attachmentId: string
): Promise<(TaskAttachment & { data: Buffer }) | null> {
  const { rows } = await requirePool().query<TaskAttachmentRow & { data: Buffer }>(
    `SELECT ${META_COLUMNS}, data FROM task_attachments WHERE task_id = $1 AND id = $2`,
    [taskId, attachmentId]
  );
  return rows[0] ? { ...rowToAttachment(rows[0]), data: rows[0].data } : null;
}

export class TaskAttachmentLimitError extends Error {}

/**
 * Store a file on a task under a free name (`a.pdf`, then `a (2).pdf`, ...).
 * Name choice and insert run in one transaction holding a row lock on the task,
 * so two concurrent uploads can neither pick the same name nor overshoot the
 * per-task count.
 */
export async function addTaskAttachment(input: {
  taskId: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  uploadedBy: string | null;
  uploadedByName: string | null;
}): Promise<TaskAttachment> {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [input.taskId]);
    const { rows: existing } = await client.query<{ filename: string }>(
      'SELECT filename FROM task_attachments WHERE task_id = $1',
      [input.taskId]
    );
    if (existing.length >= MAX_ATTACHMENTS_PER_TASK) {
      throw new TaskAttachmentLimitError(
        `A task can hold at most ${MAX_ATTACHMENTS_PER_TASK} attachments`
      );
    }
    const filename = uniqueAttachmentName(
      input.filename,
      existing.map(r => r.filename)
    );
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const { rows } = await client.query<TaskAttachmentRow>(
      `INSERT INTO task_attachments
         (task_id, filename, mime_type, size, sha256, data, uploaded_by, uploaded_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${META_COLUMNS}`,
      [
        input.taskId,
        filename,
        input.mimeType,
        input.data.length,
        sha256,
        input.data,
        input.uploadedBy,
        input.uploadedByName,
      ]
    );
    await client.query('COMMIT');
    return rowToAttachment(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTaskAttachment(taskId: string, attachmentId: string) {
  const { rowCount } = await requirePool().query(
    'DELETE FROM task_attachments WHERE task_id = $1 AND id = $2',
    [taskId, attachmentId]
  );
  return (rowCount ?? 0) > 0;
}

/** Copy every attachment of one task onto another (recurring-task occurrences). */
export async function copyTaskAttachments(fromTaskId: string, toTaskId: string) {
  await requirePool().query(
    `INSERT INTO task_attachments
       (task_id, filename, mime_type, size, sha256, data, uploaded_by, uploaded_by_name)
     SELECT $2, filename, mime_type, size, sha256, data, uploaded_by, uploaded_by_name
       FROM task_attachments WHERE task_id = $1
     ON CONFLICT (task_id, filename) DO NOTHING`,
    [fromTaskId, toTaskId]
  );
}
