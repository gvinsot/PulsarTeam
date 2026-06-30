export const PERSONAL_BOARD_NAME = 'My board';

export const DEFAULT_BOARD_WORKFLOW = {
  columns: [
    { id: 'todo', label: 'Todo', color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
    { id: 'done', label: 'Done', color: '#22c55e' },
  ],
  transitions: [
    {
      from: 'in_progress',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { type: 'run_agent', mode: 'decide', role: '', instructions: 'Execute the task fully, and when you are finished, update the task to next state.' },
        { type: 'change_status', target: '__next__' },
      ],
    },
  ],
  version: 1,
};

export const NEW_USER_BOARD_WORKFLOW = {
  columns: [
    { id: 'todo', label: 'Todo', color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6', showAgent: true, showProject: true, showTaskType: true },
    { id: 'done', label: 'Done', color: '#22c55e', showAgent: true, showProject: true, showTaskType: true },
  ],
  transitions: [
    {
      from: 'in_progress',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { type: 'run_agent', mode: 'decide', role: 'developer', instructions: 'Execute the task fully, and when you are finished, update the task to next state.' },
        { type: 'change_status', target: '__next__' },
      ],
    },
  ],
  version: 1,
};

export function isLegacyDefaultBoardName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'default';
}

export function normalizeBoardName(value: unknown, fallback = PERSONAL_BOARD_NAME): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const candidate = trimmed || fallback;
  const name = isLegacyDefaultBoardName(candidate) ? fallback : candidate;
  return name.slice(0, 100);
}
