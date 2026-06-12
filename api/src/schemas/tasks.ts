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
  priority: optionalString(50),
  dueDate: optionalString(50),
  position: z.number().int().optional(),
  isManual: z.boolean().optional(),
});

export const bulkMoveSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(2000),
  boardId: z.string().uuid(),
  column: z.string().min(1).max(100).optional(),
});

export const idParamsSchema = z.object({
  id: z.string().uuid(),
});
