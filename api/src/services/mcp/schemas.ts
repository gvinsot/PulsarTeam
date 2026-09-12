import { z } from 'zod';
import { createAgentSchema, updateAgentSchema } from '../../schemas/agents.js';
import { updateTemplateSchema } from '../../schemas/tasks.js';

// Publish the same named fields and bounds as REST, rather than an opaque bag.
export const agentConfigSchema = createAgentSchema.describe(
  'Agent configuration. boardId and name are required. Secrets are write-only.'
);
export const agentUpdatesSchema = updateAgentSchema.describe(
  'Partial agent configuration. Omitted fields are preserved; secrets are write-only.'
);
export const recurrenceSchema = updateTemplateSchema.shape.recurrence.unwrap();

export const taskEditShape = {
  title: z.string().max(2000).nullable().optional(),
  description: z.string().max(20000).nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional(),
  due_date: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .nullable()
    .optional()
    .describe('ISO date or timestamp with timezone. null clears the deadline.'),
  task_type: z.string().max(50).nullable().optional(),
  is_manual: z.boolean().optional(),
};

export const workflowColumnSchema = z
  .object({
    id: z.string().min(1).max(100).optional(),
    label: z.string().min(1).max(100),
    color: z.string().max(50).optional(),
    autoAssignRole: z.string().max(100).nullable().optional(),
    showAgent: z.boolean().optional(),
    showCreator: z.boolean().optional(),
    showProject: z.boolean().optional(),
    showTaskType: z.boolean().optional(),
  })
  .passthrough();

const role = z
  .string()
  .max(100)
  .optional()
  .describe('Agent role, or __auto__ for automatic routing.');
const workflowActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign_agent'), role }),
  z.object({
    type: z.literal('assign_agent_individual'),
    agentId: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('run_agent'),
    role,
    mode: z
      .enum(['refine', 'decide', 'title', 'set_type', 'execute'])
      .optional()
      .describe('Defaults to decide. execute is a legacy alias.'),
    instructions: z.string().max(50000).optional(),
  }),
  z.object({
    type: z.literal('change_status'),
    target: z.string().min(1).max(100).describe('Destination column id, or __next__.'),
  }),
]);

export const workflowTransitionSchema = z.object({
  from: z.string().min(1).max(100).describe('Source column id.'),
  trigger: z.enum(['on_enter', 'condition']),
  actions: z.array(workflowActionSchema).max(100),
  conditions: z
    .array(
      z.object({
        field: z.enum([
          'assignee_status',
          'assignee_enabled',
          'assignee_role',
          'task_has_assignee',
          'idle_agent_available',
          'creator_status',
          'creator_enabled',
          'owner_status',
          'owner_enabled',
        ]),
        operator: z.enum(['eq', 'neq']).optional(),
        value: z
          .string()
          .max(200)
          .optional()
          .describe('String comparison, including "true" and "false".'),
      })
    )
    .max(100)
    .optional(),
});
