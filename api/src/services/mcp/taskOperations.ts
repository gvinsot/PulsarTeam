import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentManager } from '../agentManager/index.js';
import {
  getTaskByIdPrefix,
  getTaskTemplates,
  getOccurrencesForTemplate,
  countUnfinishedOccurrences,
  updateTaskFields,
} from '../database/tasks.js';
import { getBoardById } from '../database.js';
import { buildRecurrenceConfig, nextRunAt } from '../taskRecurrence.js';
import { resolveWorkflowStatus } from '../workflow/columnIds.js';
import { stopTaskExecution } from '../taskControl.js';
import { emitTaskUpdated } from '../taskMutations.js';
import { errorMessage } from '../../lib/errors.js';
import { jsonOk, jsonError } from '../mcpResponses.js';
import {
  actorBoardIds,
  scopedAgent,
  scopedTask,
  scopedBoard,
  notFound,
  type McpActor,
  type McpRecord,
} from './actorScope.js';
import { recurrenceSchema } from './schemas.js';

const taskId = z.string().min(1).describe('Task UUID or unique prefix.');
const templateId = z.string().min(1).describe('Recurring rule UUID or unique prefix.');

export function taskView(task: McpRecord) {
  const keys = [
    'id',
    'title',
    'text',
    'status',
    'boardId',
    'agentId',
    'assignee',
    'project',
    'taskType',
    'priority',
    'dueDate',
    'isManual',
    'repoFullName',
    'repoProvider',
    'secondaryRepos',
    'storagePath',
    'storageProvider',
    'createdAt',
    'updatedAt',
    'startedAt',
    'completedAt',
    'executionStatus',
    'actionRunning',
    'actionRunningAgentId',
    'actionRunningMode',
    'error',
    'errorFromStatus',
    'isTemplate',
    'templateId',
    'occurrenceSeq',
    'recurrence',
    'commits',
  ];
  return Object.fromEntries(keys.map(key => [key, task[key] ?? null]));
}

export function registerTaskOperations(server: McpServer, mgr: AgentManager, actor: McpActor) {
  async function load(id: string, template: boolean, level: 'read' | 'edit' = 'edit') {
    const row = await getTaskByIdPrefix(id);
    if (!row || !!row.isTemplate !== template)
      return { ok: false, error: notFound(template ? 'Recurring rule' : 'Task') };
    return scopedTask(actor, row, mgr.agents, level);
  }

  async function schedule(task: McpRecord, input: z.infer<typeof recurrenceSchema>) {
    if (input.originalStatus) {
      const board = task.boardId ? await getBoardById(task.boardId) : null;
      const column = resolveWorkflowStatus(board?.workflow?.columns || [], input.originalStatus);
      if (!column) throw new Error('Unknown recurrence starting column');
      return { ...input, originalStatus: column.id };
    }
    return { ...input, originalStatus: input.originalStatus || undefined };
  }

  async function templateView(row: McpRecord) {
    const next = nextRunAt(row.recurrence, row.createdAt);
    return {
      ...taskView(row),
      nextRunAt: next === null ? null : new Date(next).toISOString(),
      unfinishedRuns: await countUnfinishedOccurrences(row.id),
    };
  }

  for (const name of ['start_task', 'resume_task'] as const) {
    server.tool(
      name,
      'Request execution on an explicit agent (defaults to assignee, then owner). Returns immediately; use get_task to monitor. Does not execute a completed task or a recurring rule. status chooses an active column; otherwise use the current column, the pre-error column, or the first active column.',
      { task_id: taskId, agent_id: z.string().optional(), status: z.string().optional() },
      async ({ task_id, agent_id, status }) => {
        const task = await load(task_id, false);
        if (!task.ok) return task.error!;
        const row = task.value;
        const executorId = agent_id || row.assignee || row.agentId;
        if (!executorId)
          return jsonError('Assign an agent with delegate_task or provide agent_id.');
        const executor = await scopedAgent(actor, mgr.agents.get(executorId), 'edit');
        if (!executor.ok) return executor.error!;
        if (executor.value.enabled === false) return jsonError('Executor is disabled');
        const board = row.boardId ? await getBoardById(row.boardId) : null;
        const columns = board?.workflow?.columns || [];
        const wanted = status || (row.status === 'error' ? row.errorFromStatus : row.status);
        const chosen = wanted ? resolveWorkflowStatus(columns, wanted) : null;
        const column = status
          ? chosen
          : chosen && mgr._isActiveTaskStatus(chosen.id)
            ? chosen
            : columns.find((c: { id: string }) => mgr._isActiveTaskStatus(c.id));
        if (!column || !mgr._isActiveTaskStatus(column.id))
          return jsonError('Choose an active workflow column with status.');
        try {
          await mgr.executeTask(executorId, row.id, () => {}, actor, {
            status: column.id,
            executorId,
          });
          const updated = await getTaskByIdPrefix(row.id);
          return jsonOk({ accepted: true, task: taskView(updated || row) });
        } catch (err) {
          return jsonError(errorMessage(err));
        }
      }
    );
  }

  server.tool(
    'stop_task',
    'Stop one task and interrupt its executor. The task stays stopped until explicitly resumed; other agents are unaffected.',
    { task_id: taskId },
    async ({ task_id }) => {
      const task = await load(task_id, false);
      if (!task.ok) return task.error!;
      const row = task.value;
      const executorId = row.actionRunningAgentId || row.assignee || row.agentId;
      if (executorId && mgr.agents.has(executorId)) {
        const executor = await scopedAgent(actor, mgr.agents.get(executorId), 'edit');
        if (!executor.ok) return executor.error!;
      }
      try {
        return jsonOk({
          success: true,
          task: taskView(await stopTaskExecution(mgr, row, actor.username)),
        });
      } catch (err) {
        return jsonError(errorMessage(err));
      }
    }
  );

  server.tool(
    'set_task_recurrence',
    'Create or update a recurring rule from an existing task. The task remains run #1. Later runs follow the board workflow. enabled:false deletes the rule while preserving its runs.',
    { task_id: taskId, recurrence: recurrenceSchema },
    async ({ task_id, recurrence }) => {
      const task = await load(task_id, false);
      if (!task.ok) return task.error!;
      if (task.value.templateId) {
        const rule = await load(task.value.templateId, true);
        if (!rule.ok) return rule.error!;
      }
      try {
        const config = await schedule(task.value, recurrence);
        const rule = await mgr.setTaskRecurrence(task.value, {
          ...config,
          enabled: config.enabled ?? true,
        });
        if (config.enabled !== false && !rule) return jsonError('Failed to create recurring rule');
        return jsonOk({
          success: true,
          template: rule ? await templateView(rule) : null,
          task: taskView(task.value),
        });
      } catch (err) {
        return jsonError(errorMessage(err));
      }
    }
  );

  server.tool(
    'list_task_templates',
    'List recurring rules on accessible boards. Rules are separate from tasks and include the next scheduled run.',
    { board_id: z.string().optional() },
    async ({ board_id }) => {
      if (board_id) {
        const board = await scopedBoard(actor, board_id, 'read');
        if (!board.ok) return board.error!;
      }
      const ids = await actorBoardIds(actor);
      const rules = (await getTaskTemplates(board_id || null)).filter(
        t => t.boardId && ids.has(t.boardId)
      );
      return jsonOk({ templates: await Promise.all(rules.map(templateView)) });
    }
  );

  server.tool(
    'get_task_template',
    'Read a recurring rule, its schedule and execution count.',
    { template_id: templateId },
    async ({ template_id }) => {
      const rule = await load(template_id, true, 'read');
      return rule.ok ? jsonOk({ template: await templateView(rule.value) }) : rule.error!;
    }
  );

  server.tool(
    'update_task_template',
    'Edit a recurring rule. Omitted fields preserve the schedule. enabled:false deletes only the rule.',
    {
      template_id: templateId,
      title: z.string().max(2000).nullable().optional(),
      description: z.string().max(20000).nullable().optional(),
      recurrence: recurrenceSchema.optional(),
    },
    async ({ template_id, title, description, recurrence }) => {
      const rule = await load(template_id, true);
      if (!rule.ok) return rule.error!;
      const row = rule.value;
      try {
        if (recurrence?.enabled === false) {
          if (!(await mgr.deleteTask(row.agentId, row.id)))
            return jsonError('Failed to delete recurring rule');
          return jsonOk({ success: true, deleted: true });
        }
        const fields: Record<string, unknown> = {};
        if (title !== undefined) fields.title = title;
        if (description !== undefined) fields.text = description || '';
        if (recurrence !== undefined)
          fields.recurrence = buildRecurrenceConfig(await schedule(row, recurrence), {
            prev: row.recurrence,
          });
        if (!Object.keys(fields).length) return jsonError('Nothing to update');
        fields.history = [
          ...(row.history || []),
          { at: new Date().toISOString(), by: actor.username, type: 'recurrence_update' },
        ];
        const updated = await updateTaskFields(row.id, fields);
        if (!updated) return jsonError('Failed to save recurring rule');
        return jsonOk({ success: true, template: await templateView(updated) });
      } catch (err) {
        return jsonError(errorMessage(err));
      }
    }
  );

  server.tool(
    'delete_task_template',
    'Delete a recurring rule. Existing runs and their histories are preserved.',
    { template_id: templateId },
    async ({ template_id }) => {
      const rule = await load(template_id, true);
      if (!rule.ok) return rule.error!;
      return (await mgr.deleteTask(rule.value.agentId, rule.value.id))
        ? jsonOk({ success: true })
        : jsonError('Failed to delete recurring rule');
    }
  );

  server.tool(
    'run_task_template',
    'Create an extra run now and trigger its board workflow. The automatic schedule is preserved. An explicit manual run may overlap existing runs.',
    { template_id: templateId },
    async ({ template_id }) => {
      const rule = await load(template_id, true);
      if (!rule.ok) return rule.error!;
      try {
        const run = await mgr._spawnOccurrence(rule.value, {
          by: actor.username,
          advanceClock: false,
        });
        return run
          ? jsonOk({ success: true, task: taskView(run) })
          : jsonError('Failed to create run');
      } catch (err) {
        return jsonError(errorMessage(err));
      }
    }
  );

  server.tool(
    'list_task_template_runs',
    'List executions of a recurring rule, newest first.',
    { template_id: templateId, limit: z.number().int().min(1).max(200).optional() },
    async ({ template_id, limit }) => {
      const rule = await load(template_id, true, 'read');
      if (!rule.ok) return rule.error!;
      const visible = [];
      for (const row of await getOccurrencesForTemplate(rule.value.id, limit || 50)) {
        if ((await scopedTask(actor, row, mgr.agents, 'read')).ok) visible.push(taskView(row));
      }
      return jsonOk({ tasks: visible });
    }
  );
}

/** Targeted metadata writes cannot overwrite concurrent execution state. */
export async function editTaskMetadata(
  mgr: AgentManager,
  task: McpRecord,
  fields: Record<string, unknown>,
  actor: McpActor
) {
  if (!Object.keys(fields).length) return task;
  const updated = await updateTaskFields(task.id, {
    ...fields,
    history: [
      ...(task.history || []),
      {
        at: new Date().toISOString(),
        by: actor.username,
        type: 'edit',
        fields: Object.keys(fields),
      },
    ],
  });
  if (!updated) throw new Error('Failed to save task metadata');
  emitTaskUpdated(mgr, updated);
  return updated;
}
