/**
 * In-memory fake of the task DB accessors (services/database/tasks.ts), backed by
 * a single Map<taskId, taskRow>. Used by tests after the task store was removed
 * from AgentManager (the DB became the single source of truth) — the unit test
 * suite runs pool-less, so these functions stand in for a real Postgres.
 *
 * Usage (mock.module must run BEFORE the module under test is imported):
 *
 *   import test, { mock } from 'node:test';
 *   import { makeTaskDbFake } from './helpers/taskDbFake.js';
 *   const realDb = await import('../database.js');
 *   const { rows, exports } = makeTaskDbFake();
 *   mock.module('../database.js', { namedExports: { ...realDb, ...exports } });
 *   const { AgentManager } = await import('../agentManager.js');
 *
 * Seed tasks by writing to `rows` directly (rows.set(id, {...})) or via the
 * manager's async addTask/setTaskStatus, which round-trip through these fakes.
 */

const INACTIVE = new Set(['done', 'backlog', 'error']);

export function makeTaskDbFake() {
  const rows = new Map<string, any>();

  const live = (t: any) => t && !t.deletedAt;
  // Identity-preserving: reads return the live row object (not a copy) and
  // saveTaskToDb merges in place, mirroring the old in-memory store's shared-
  // object semantics that the tests rely on (seed a task, mutate it, read it
  // back after a mutator — all the same object).
  const clone = (t: any) => t;
  const all = () => [...rows.values()];
  const isExecutor = (t: any, agentId: string) =>
    t.assignee === agentId || (!t.assignee && t.agentId === agentId);

  const exports = {
    // ── writes ────────────────────────────────────────────────────────────
    saveTaskToDb: async (task: any) => {
      if (!task?.id) return;
      const existing = rows.get(task.id);
      if (existing) Object.assign(existing, task, { updatedAt: new Date().toISOString() });
      else rows.set(task.id, { ...task, updatedAt: new Date().toISOString() });
    },
    updateTaskFields: async (id: string, fields: any) => {
      const t = rows.get(id);
      if (!t) return null;
      Object.assign(t, fields, { updatedAt: new Date().toISOString() });
      return clone(t);
    },
    updateTaskExecutionStatus: async (id: string, status: any) => {
      const t = rows.get(id);
      if (t) t.executionStatus = status || null;
    },
    deleteTaskFromDb: async (id: string, deletedBy: any = null) => {
      const t = rows.get(id);
      if (!live(t)) return false;
      t.deletedAt = new Date().toISOString();
      t.deletedBy = deletedBy;
      return true;
    },
    hardDeleteTaskFromDb: async (id: string) => rows.delete(id),
    restoreTaskFromDb: async (id: string) => {
      const t = rows.get(id);
      if (!t || !t.deletedAt) return null;
      t.deletedAt = undefined;
      return clone(t);
    },
    deleteTasksByAgent: async (agentId: string) => {
      for (const t of rows.values()) if (t.agentId === agentId && !t.deletedAt) t.deletedAt = new Date().toISOString();
    },
    clearTaskExecutionFlags: async () => {},
    clearActionRunningForAgent: async () => {},
    clearAllStaleActionRunning: async () => 0,

    // ── single-row reads ──────────────────────────────────────────────────
    getTaskById: async (id: string) => { const t = rows.get(id); return live(t) ? clone(t) : null; },
    getTaskByIdPrefix: async (idOrPrefix: string) => {
      const exact = rows.get(idOrPrefix);
      if (live(exact)) return clone(exact);
      const matches = all().filter(t => live(t) && String(t.id).startsWith(idOrPrefix));
      return matches.length === 1 ? clone(matches[0]) : null;
    },
    getDeletedTaskById: async (id: string) => { const t = rows.get(id); return t?.deletedAt ? clone(t) : null; },
    getActiveTaskForExecutor: async (agentId: string) => {
      const m = all().filter(t => live(t) && isExecutor(t, agentId) && !INACTIVE.has(t.status) && t.startedAt);
      return m[0] ? clone(m[0]) : null;
    },
    getTaskByActionRunningAgent: async (agentId: string) => {
      const m = all().filter(t => live(t) && t.actionRunningAgentId === agentId && t.actionRunning);
      return m[0] ? clone(m[0]) : null;
    },

    // ── multi-row reads ───────────────────────────────────────────────────
    getTasksByAgent: async (agentId: string) => all().filter(t => live(t) && t.agentId === agentId).map(clone),
    getAllTasks: async () => all().filter(live).map(clone),
    getAllTaskIds: async () => all().filter(live).map(t => t.id),
    getActiveTasksByAgent: async (agentId: string) =>
      all().filter(t => live(t) && t.agentId === agentId && !INACTIVE.has(t.status)).map(clone),
    getTasksByAssignee: async (agentId: string) =>
      all().filter(t => live(t) && isExecutor(t, agentId)).map(clone),
    getTasksByBoard: async (boardId: string) => all().filter(t => live(t) && t.boardId === boardId).map(clone),
    getTasksByStatusAndBoard: async (status: any = null, boardId: any = null) =>
      all().filter(t => live(t) && (!status || t.status === status) && (!boardId || t.boardId === boardId)).map(clone),
    getDeletedTasks: async () => all().filter(t => t?.deletedAt).map(clone),
    getRecurringTasks: async () => all().filter(t => live(t) && t.recurrence).map(clone),
    hasActiveTask: async (agentId: string, excludeTaskId: any = null) =>
      all().some(t => live(t) && isExecutor(t, agentId) && !INACTIVE.has(t.status) && t.id !== excludeTaskId),
    countActiveTasksForAgent: async (agentId: string, excludeTaskId: any = null) =>
      all().filter(t => live(t) && isExecutor(t, agentId) && !INACTIVE.has(t.status) && t.id !== excludeTaskId).length,
    getActiveWorkflowTasks: async (env: any = null) =>
      all().filter(t => live(t) && t.boardId && !t.isManual && !['done', 'error'].includes(t.status)
        && !t.actionRunning && !['watching', 'stopped'].includes(t.executionStatus)
        && (!env || (t.environment || 'prod') === env)).map(clone),
    getInterruptedChainTasks: async (env: any = null) =>
      all().filter(t => live(t) && t.boardId && !t.isManual && (t.actionRunning || t.completedActionIdx != null)
        && (!env || (t.environment || 'prod') === env)).map(clone),
    getTasksForResume: async (env: any = null) =>
      all().filter(t => live(t) && t.startedAt && !INACTIVE.has(t.status)
        && !['watching', 'stopped'].includes(t.executionStatus) && !t.isManual
        && (!env || (t.environment || 'prod') === env))
        .map(t => ({ ...clone(t), _agentStatus: 'idle', _agentEnabled: true })),
  };

  return { rows, exports };
}
