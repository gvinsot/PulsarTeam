import { z } from 'zod';

const PERMISSIONS = ['read', 'edit', 'admin'] as const;

const workflowColumnSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(100),
    color: z.string().max(50).optional(),
  })
  .passthrough();

const workflowSchema = z
  .object({
    columns: z.array(workflowColumnSchema).min(1).max(50).optional(),
    transitions: z.array(z.any()).max(200).optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const createBoardSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  workflow: workflowSchema.optional(),
  filters: z.record(z.string(), z.any()).optional(),
});

// PUT /:id — accept any subset of board fields. We keep this permissive
// because the underlying updateBoard() only persists known columns.
export const updateBoardSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    workflow: workflowSchema.optional(),
    filters: z.record(z.string(), z.any()).optional(),
    plugins: z.array(z.string().max(200)).max(200).optional(),
    mcp_auth: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export const updateWorkflowSchema = workflowSchema.refine(
  v => Array.isArray(v.columns) && v.columns.length > 0,
  { message: 'Invalid workflow: must have columns' }
);

export const updatePluginsSchema = z.object({
  plugins: z.array(z.string().min(1).max(200)).max(200),
});

export const pluginAssignSchema = z.object({
  pluginId: z.string().min(1).max(200),
});

export const mcpAuthSchema = z.record(z.string(), z.any());

export const createShareSchema = z
  .object({
    userId: z.string().uuid().optional(),
    username: z.string().min(1).max(200).optional(),
    permission: z.enum(PERMISSIONS),
  })
  .refine(v => !!v.userId || !!v.username, {
    message: 'userId or username is required',
  });

export const updateShareSchema = z.object({
  permission: z.enum(PERMISSIONS),
});
