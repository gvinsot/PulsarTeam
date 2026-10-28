import { decisionActionSchema } from '../../schemas/decision.js';
import { needsApproval } from '../../lib/taskTrust.js';
import { getLlmConfig, getTaskById, updateTaskFields } from '../database.js';
import { getWorkflowForBoard } from '../configManager.js';
import { decideColumn } from '../decisionModel.js';
import { emitTaskUpdated } from '../taskMutations.js';
import type { Task } from '../database/tasks.js';
import type { WorkflowAction } from './taskStateMachine.js';
import { columnExists } from './taskStateMachine.js';
import type { ActionContext, ActionResult } from './actionExecutor.js';

const stateFor = (task: Task) => ({
  title: task.title || '',
  description: task.text || '',
  taskType: task.taskType || '',
  priority: task.priority || '',
});
const workflowSnapshot = (workflow: ActionContext['workflow']) =>
  JSON.stringify({
    columns: workflow?.columns,
    transitions: workflow?.transitions,
    version: workflow?.version || 1,
  });

export async function executeDecisionAction(
  rawAction: WorkflowAction,
  task: Task,
  context: ActionContext,
  move: (action: WorkflowAction, task: Task, context: ActionContext) => Promise<ActionResult>
): Promise<ActionResult> {
  const parsed = decisionActionSchema.safeParse(rawAction);
  if (!parsed.success)
    return {
      executed: false,
      error: true,
      message:
        'Invalid decision action: select a model, instructions and at least two distinct destinations with criteria',
    };
  const action = parsed.data;
  if (
    action.routes.some(route => !columnExists(context.workflow, route.target)) ||
    (action.fallbackTarget && !columnExists(context.workflow, action.fallbackTarget))
  ) {
    return {
      executed: false,
      error: true,
      message: 'Decision destination does not exist in this board',
    };
  }
  const originalStatus = task.status;
  const originalBoard = task.boardId;
  const originalWorkflow = workflowSnapshot(context.workflow);
  const state = stateFor(task);
  let decision: Awaited<ReturnType<typeof decideColumn>> | undefined;
  let failure: string | undefined;
  try {
    const config = await getLlmConfig(action.llmConfigId);
    if (!config) throw new Error('Decision model configuration no longer exists');
    decision = await decideColumn(config, state, action.instructions, action.routes);
  } catch (err) {
    failure = err instanceof Error ? err.message : 'Decision failed';
  }
  // A user can move, edit, stop or delete the task during the request. Never apply
  // a decision about an old snapshot to their new task state.
  const fresh = await getTaskById(task.id);
  if (
    !fresh ||
    fresh.deletedAt ||
    fresh.boardId !== originalBoard ||
    fresh.status !== originalStatus ||
    fresh.isManual ||
    fresh.executionStatus === 'stopped' ||
    fresh.executionStatus === 'error' ||
    needsApproval(fresh) ||
    JSON.stringify(stateFor(fresh)) !== JSON.stringify(state)
  ) {
    return { executed: true, stopChain: true };
  }
  let currentWorkflow;
  try {
    currentWorkflow = await getWorkflowForBoard(originalBoard);
  } catch {
    return {
      executed: false,
      error: true,
      message: 'Could not verify the board workflow after decision',
    };
  }
  if (workflowSnapshot(currentWorkflow) !== originalWorkflow) {
    return { executed: true, stopChain: true };
  }
  if (!decision) return { executed: false, error: true, message: failure || 'Decision failed' };
  const confident = decision.confidence >= action.minConfidence;
  const target = confident ? decision.target : action.fallbackTarget;
  const audited = await updateTaskFields(task.id, {
    historyAppend: [
      {
        at: new Date().toISOString(),
        by: 'workflow',
        type: 'decision',
        status: fresh.status,
        detail: `Decision model: confidence ${decision.confidence.toFixed(3)}; ${target ? `destination ${target}` : 'manual review required'}`,
        llmConfigId: action.llmConfigId,
        choice: decision.target,
        confidence: decision.confidence,
        probability: decision.probability,
        threshold: action.minConfidence,
        fallback: !confident,
        target: target || null,
        usage: decision.usage,
      },
    ],
  });
  if (!audited)
    return { executed: false, error: true, message: 'Could not save the decision audit' };
  emitTaskUpdated(context.agentManager, audited, { stampUpdatedAt: false });
  if (!target)
    return {
      executed: false,
      error: true,
      message:
        'Decision confidence below threshold; manual review required (no fallback column configured)',
    };
  const result = await move({ type: 'change_status', target }, fresh, {
    ...context,
    exactStatusTarget: true,
  });
  return { ...result, stopChain: true };
}
