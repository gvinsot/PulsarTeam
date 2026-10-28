import type { BoardWorkflowColumn, WorkflowAction } from '../../types/board';

/** Save-time validation mirrors the server; legacy non-decision actions are untouched. */
export function validDecisionAction(
  action: WorkflowAction,
  columns: BoardWorkflowColumn[]
): boolean {
  if (action.type !== 'decision_model') return true;
  const exists = (id: string) => columns.some(column => column.id === id);
  return (
    typeof action.llmConfigId === 'string' &&
    !!action.llmConfigId.trim() &&
    typeof action.instructions === 'string' &&
    !!action.instructions.trim() &&
    action.instructions.length <= 2000 &&
    Number.isFinite(action.minConfidence) &&
    action.minConfidence >= 0 &&
    action.minConfidence <= 1 &&
    Array.isArray(action.routes) &&
    action.routes.length >= 2 &&
    action.routes.length <= 50 &&
    action.routes.every(
      route =>
        route &&
        exists(route.target) &&
        typeof route.description === 'string' &&
        !!route.description.trim() &&
        route.description.length <= 1000
    ) &&
    new Set(action.routes.map(route => route.target)).size === action.routes.length &&
    (!action.fallbackTarget || exists(action.fallbackTarget))
  );
}
