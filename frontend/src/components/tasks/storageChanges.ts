import type { TaskStorageChange } from '../../types';

/** Changes grouped by provider, most recent first within each group. */
export function groupStorageChanges(changes: TaskStorageChange[]) {
  const groups = new Map<TaskStorageChange['provider'], TaskStorageChange[]>();
  for (const change of changes) {
    const list = groups.get(change.provider) || [];
    list.push(change);
    groups.set(change.provider, list);
  }
  return [...groups.entries()].map(([provider, items]) => ({
    provider,
    items: [...items].sort((a, b) => (b.at || '').localeCompare(a.at || '')),
  }));
}
