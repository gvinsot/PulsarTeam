import { z } from 'zod';

const optionalString = (max: number) => z.string().max(max).optional().nullable();

export const reorderTasksSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(2000),
});

// PUT /tasks/:id — task updates are partial; only fields present are applied.
// Unknown keys are stripped; every known field is bounded.
export const updateTaskSchema = z.object({
  title: optionalString(2000),
  description: optionalString(20000),
  column: optionalString(100),
  boardId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  type: optionalString(50),
  taskType: optionalString(50),
  priority: optionalString(50),
  dueDate: optionalString(50),
  position: z.number().int().optional(),
  isManual: z.boolean().optional(),
  recurrence: z.any().optional(),
  repoFullName: optionalString(300),
  repoProvider: optionalString(50),
  secondaryRepos: z
    .array(
      z.union([
        z.string().max(300),
        z
          .object({
            provider: z.string().max(50).optional(),
            fullName: z.string().max(300),
          })
          .passthrough(),
      ])
    )
    .max(10)
    .optional(),
  storagePath: optionalString(500),
  storageProvider: optionalString(50),
});

/**
 * Body of PUT /tasks/:id once `validateBody(updateTaskSchema)` has run — the
 * body type is inferred from the schema that validates it, so the two cannot
 * drift. Same pattern applies to every other schema in this folder.
 */
export type UpdateTaskBody = z.infer<typeof updateTaskSchema>;

/**
 * Body of PUT /tasks/templates/:id — editing a recurring RULE.
 *
 * Deliberately narrower than `updateTaskSchema`: a rule has no column, no
 * assignee and no position, and its repo/storage targets are inherited by every
 * run from the moment they are spawned, so they are edited on the task side.
 * `recurrence: { enabled: false }` is the documented way to stop the rule.
 */
export const updateTemplateSchema = z.object({
  title: optionalString(2000),
  description: optionalString(20000),
  recurrence: z
    .object({
      enabled: z.boolean().optional(),
      period: z.string().max(50).optional(),
      intervalMinutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
      originalStatus: optionalString(100),
      historyRetentionDays: z.number().int().min(0).max(3650).nullable().optional(),
      keepLastOccurrences: z.number().int().min(0).max(1000).nullable().optional(),
      onOverlap: z.enum(['skip', 'spawn']).optional(),
    })
    .optional(),
});

export type UpdateTemplateBody = z.infer<typeof updateTemplateSchema>;

export const bulkMoveSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(2000),
  boardId: z.string().uuid(),
  column: z.string().min(1).max(100).optional(),
});

export const idParamsSchema = z.object({
  id: z.string().uuid(),
});
