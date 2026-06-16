type WorkflowColumn = {
  id?: string;
  label?: string;
  [key: string]: any;
};

type Workflow = {
  columns?: WorkflowColumn[];
  transitions?: any[];
  [key: string]: any;
};

export type StatusResolution = {
  id: string;
  column: WorkflowColumn;
  matchedBy: 'label' | 'id';
};

export type ColumnRename = {
  from: string;
  to: string;
};

const MAX_COLUMN_ID_LENGTH = 100;

function comparable(value: any): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function columnsFrom(input: Workflow | WorkflowColumn[] | null | undefined): WorkflowColumn[] {
  if (Array.isArray(input)) return input;
  return Array.isArray(input?.columns) ? input.columns : [];
}

export function slugifyColumnId(label: any): string {
  const raw = typeof label === 'string' ? label.trim() : '';
  const withoutAccents = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const slug = withoutAccents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (slug || 'column').slice(0, MAX_COLUMN_ID_LENGTH).replace(/_+$/g, '') || 'column';
}

export function resolveWorkflowStatus(
  workflowOrColumns: Workflow | WorkflowColumn[] | null | undefined,
  status: any,
): StatusResolution | null {
  const wanted = comparable(status);
  if (!wanted) return null;

  const columns = columnsFrom(workflowOrColumns);
  const labelMatch = columns.find(c => c?.id && comparable(c.label) === wanted);
  if (labelMatch?.id) {
    return { id: labelMatch.id, column: labelMatch, matchedBy: 'label' };
  }

  const idMatch = columns.find(c => c?.id && comparable(c.id) === wanted);
  if (idMatch?.id) {
    return { id: idMatch.id, column: idMatch, matchedBy: 'id' };
  }

  return null;
}

function uniqueColumnId(base: string, used: Set<string>): string {
  const cleanBase = (base || 'column').slice(0, MAX_COLUMN_ID_LENGTH).replace(/_+$/g, '') || 'column';
  let candidate = cleanBase;
  let suffix = 2;

  while (used.has(candidate)) {
    const marker = `_${suffix++}`;
    const head = cleanBase.slice(0, MAX_COLUMN_ID_LENGTH - marker.length).replace(/_+$/g, '') || 'column';
    candidate = `${head}${marker}`;
  }

  used.add(candidate);
  return candidate;
}

function isPlaceholderColumnId(id: string): boolean {
  return /^new_step(_\d+)?$/i.test(id) || /^col_\d+$/i.test(id);
}

function rewriteTransitionReferences(transition: any, renameMap: Map<string, string>): any {
  if (!transition || typeof transition !== 'object') return transition;

  const rewritten = { ...transition };
  if (typeof rewritten.from === 'string' && renameMap.has(rewritten.from)) {
    rewritten.from = renameMap.get(rewritten.from);
  }

  if (Array.isArray(rewritten.actions)) {
    rewritten.actions = rewritten.actions.map((action: any) => {
      if (!action || typeof action !== 'object') return action;
      if (typeof action.target === 'string' && renameMap.has(action.target)) {
        return { ...action, target: renameMap.get(action.target) };
      }
      return action;
    });
  }

  return rewritten;
}

export function normalizeWorkflowColumnIds(
  nextWorkflow: Workflow,
  previousWorkflow: Workflow | null | undefined,
): { workflow: Workflow; renames: ColumnRename[] } {
  const nextColumns = columnsFrom(nextWorkflow);
  const previousColumns = columnsFrom(previousWorkflow);
  const previousById = new Map(previousColumns
    .filter(c => typeof c?.id === 'string' && c.id.trim())
    .map(c => [c.id!.trim(), c]));

  const used = new Set<string>();
  const renameMap = new Map<string, string>();

  const planned = nextColumns.map((column) => {
    const oldId = typeof column?.id === 'string' ? column.id.trim() : '';
    const label = typeof column?.label === 'string' ? column.label.trim() : '';
    const previous = oldId ? previousById.get(oldId) : null;
    const previousLabel = typeof previous?.label === 'string' ? previous.label.trim() : '';

    const deriveFromLabel =
      (!oldId && label) ||
      (!!previous && !!oldId && !!label && label !== previousLabel) ||
      (!previous && !!oldId && !!label && isPlaceholderColumnId(oldId));

    return {
      column,
      oldId,
      deriveFromLabel,
      desiredId: deriveFromLabel ? slugifyColumnId(label) : (oldId || slugifyColumnId(label)),
    };
  });

  const assignedIds = new Array<string>(planned.length);

  planned.forEach((plan, index) => {
    if (plan.deriveFromLabel) return;
    assignedIds[index] = uniqueColumnId(plan.desiredId, used);
  });

  planned.forEach((plan, index) => {
    if (!plan.deriveFromLabel) return;
    assignedIds[index] = uniqueColumnId(plan.desiredId, used);
  });

  const columns = planned.map((plan, index) => {
    const newId = assignedIds[index];

    if (plan.oldId && plan.oldId !== newId) {
      renameMap.set(plan.oldId, newId);
    }

    return { ...plan.column, id: newId };
  });

  const transitions = Array.isArray(nextWorkflow?.transitions)
    ? nextWorkflow.transitions.map(t => rewriteTransitionReferences(t, renameMap))
    : nextWorkflow?.transitions;

  const workflow = {
    ...nextWorkflow,
    columns,
    ...(Array.isArray(nextWorkflow?.transitions) ? { transitions } : {}),
  };

  return {
    workflow,
    renames: Array.from(renameMap.entries()).map(([from, to]) => ({ from, to })),
  };
}
