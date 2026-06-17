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
  secondaryRepos: z.array(z.union([
    z.string().max(300),
    z.object({
      provider: z.string().max(50).optional(),
      fullName: z.string().max(300),
    }).passthrough(),
  ])).max(10).optional(),
  storagePath: optionalString(500),
  storageProvider: optionalString(50),
});

export const bulkMoveSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(2000),
  boardId: z.string().uuid(),
  column: z.string().min(1).max(100).optional(),
});

export const idParamsSchema = z.object({
  id: z.string().uuid(),
});
