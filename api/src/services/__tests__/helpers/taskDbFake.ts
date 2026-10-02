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
  // Mirrors NOT_TEMPLATE in services/database/tasks.ts: a recurring rule is
  // never returned by a task listing, only by the template getters below.
  const card = (t: any) => live(t) && !t.isTemplate;
  // Identity-preserving: reads return the live row object (not a copy) and
  // saveTaskToDb merges in place, mirroring the old in-memory store's shared-
  // object semantics that the tests rely on (seed a task, mutate it, read it
  // back after a mutator — all the same object).
  const clone = (t: any) => t;
  const all = () => [...rows.values()];
  const isExecutor = (t: any, agentId: string) =>
    t.assignee === agentId || (!t.assignee && t.agentId === agentId);

  // Columns the real full-row upsert never writes on an EXISTING row (see
  // _doSaveTask): they only change through their atomic accessors.
  const UPSERT_SKIPS = new Set([
    'commits',
    'comments',
    'trustLevel',
    'securityFlags',
    'actionRunning',
    'actionRunningAgentId',
    'actionRunningMode',
    'actionHeartbeatAt',
    'resumeTransitionIdx',
    'commitRun',
  ]);
  // updateTaskFields speaks column names; the task object names one of them
  // differently (rowToTask maps pending_on_enter to `_pendingOnEnter`).
  const fieldKey = (key: string) => (key === 'pendingOnEnter' ? '_pendingOnEnter' : key);
  const now = () => new Date().toISOString();
  const liveClaim = (t: any) => card(t) && t.actionRunning === true;
  // Mirrors COMMIT_RUN_ENDED: a run context whose claim is cleared from under
  // it is closed at that moment.
  const endCommitRun = (t: any) => {
    if (t.commitRun && !t.commitRun.endedAt) t.commitRun = { ...t.commitRun, endedAt: now() };
  };
  // Mirrors STALE_CLAIM_SQL: a stopped heartbeat (any env), or a legacy claim
  // without one (own env only) that is old or has no start stamp.
  const isStale = (t: any, ownEnv: string, staleSeconds: number, legacyMinutes: number) => {
    const ageMs = (iso: string | null | undefined) =>
      iso ? Date.now() - Date.parse(iso) : Number.POSITIVE_INFINITY;
    if (t.actionHeartbeatAt) return ageMs(t.actionHeartbeatAt) > staleSeconds * 1000;
    if ((t.environment || 'prod') !== ownEnv) return false;
    return !t.startedAt || ageMs(t.startedAt) > legacyMinutes * 60_000;
  };

  const exports = {
    // ── writes ────────────────────────────────────────────────────────────
    saveTaskToDb: async (task: any) => {
      if (!task?.id) return;
      const existing = rows.get(task.id);
      if (existing) {
        for (const [key, value] of Object.entries(task)) {
          if (!UPSERT_SKIPS.has(key)) existing[key] = value;
        }
        existing.updatedAt = now();
      } else {
        // A new row never starts claimed (mirrors the INSERT branch).
        rows.set(task.id, {
          ...task,
          actionRunning: false,
          actionRunningAgentId: null,
          actionRunningMode: null,
          updatedAt: now(),
        });
      }
    },
    updateTaskFields: async (id: string, fields: any, opts: any = {}) => {
      const t = rows.get(id);
      if (!t) return null;
      for (const [key, expected] of Object.entries(opts.expect || {})) {
        const actual = t[fieldKey(key)];
        if (expected === null || expected === undefined) {
          if (actual !== null && actual !== undefined) return null;
        } else if (actual !== expected) {
          return null;
        }
      }
      const { historyAppend, ...columns } = fields || {};
      for (const [key, value] of Object.entries(columns)) {
        // rowToTask reads an empty pending_on_enter back as undefined.
        t[fieldKey(key)] = key === 'pendingOnEnter' && value == null ? undefined : value;
      }
      if (Array.isArray(historyAppend) && historyAppend.length && !('history' in columns)) {
        t.history = [...(Array.isArray(t.history) ? t.history : []), ...historyAppend];
      }
      t.updatedAt = now();
      return clone(t);
    },
    // ── run claims (see database/tasks.ts) ─────────────────────────────────
    claimTaskRun: async (id: string, agentId: string, mode: string, expectStatus: any = null) => {
      const t = rows.get(id);
      if (!live(t)) return { ok: false, reason: 'missing' };
      if (t.actionRunning === true) return { ok: false, reason: 'task-running' };
      if (t.executionStatus === 'stopped') return { ok: false, reason: 'stopped' };
      if (expectStatus && t.status !== expectStatus) return { ok: false, reason: 'moved' };
      if (all().some(o => o.id !== id && liveClaim(o) && o.actionRunningAgentId === agentId)) {
        return { ok: false, reason: 'agent-busy' };
      }
      Object.assign(t, {
        actionRunning: true,
        actionRunningAgentId: agentId,
        actionRunningMode: mode,
        startedAt: t.startedAt || now(),
        actionHeartbeatAt: now(),
        updatedAt: now(),
      });
      // A workflow run's claim consumes the column's retry marker.
      if (mode !== 'resume') t._pendingOnEnter = undefined;
      return { ok: true, task: clone(t) };
    },
    heartbeatTaskRun: async (id: string, agentId: string) => {
      const t = rows.get(id);
      if (!t || t.actionRunning !== true || t.actionRunningAgentId !== agentId) return false;
      t.actionHeartbeatAt = now();
      return true;
    },
    releaseTaskRun: async (id: string, agentId: string, opts: any = {}) => {
      const t = rows.get(id);
      if (!t) return null;
      if (t.actionRunning === true && t.actionRunningAgentId === agentId) {
        Object.assign(t, {
          actionRunning: false,
          actionRunningAgentId: null,
          actionRunningMode: null,
          actionHeartbeatAt: null,
          updatedAt: now(),
        });
        if (!opts.keepStartedAt) t.startedAt = null;
      }
      // Independent of the claim (a Stop may have cleared it), never under
      // another run's claim.
      if (opts.clearAssignee && t.assignee === agentId && t.actionRunning !== true) {
        t.assignee = null;
      }
      return live(t) ? clone(t) : null;
    },
    getRunningAgentIds: async () =>
      new Set(
        all()
          .filter(t => live(t) && t.actionRunning === true && t.actionRunningAgentId)
          .map(t => t.actionRunningAgentId)
      ),
    getStaleRunClaims: async (ownEnv: string, staleSeconds = 120, legacyMinutes = 20) =>
      all()
        .filter(t => card(t) && t.actionRunning === true && isStale(t, ownEnv, staleSeconds, legacyMinutes))
        .map(clone),
    healStaleRunClaim: async (id: string, ownEnv: string, staleSeconds = 120, legacyMinutes = 20) => {
      const t = rows.get(id);
      if (!live(t) || t.actionRunning !== true || !isStale(t, ownEnv, staleSeconds, legacyMinutes)) {
        return null;
      }
      const staleAgentId = t.actionRunningAgentId || null;
      Object.assign(t, {
        actionRunning: false,
        actionRunningAgentId: null,
        actionRunningMode: null,
        actionHeartbeatAt: null,
        updatedAt: now(),
      });
      endCommitRun(t);
      if (t.executionStatus === 'watching') t.executionStatus = null;
      if (!['done', 'error'].includes(t.status) && t.executionStatus !== 'stopped') {
        t._pendingOnEnter = t.status;
      }
      return { ...t, staleAgentId };
    },
    getActiveAssigneeIds: async (excludeTaskId: string | null = null, scope: any = {}) =>
      new Set(
        all()
          .filter(
            t =>
              card(t) &&
              t.assignee &&
              !INACTIVE.has(t.status) &&
              t.id !== excludeTaskId &&
              (t.boardId || null) === (scope.boardId ?? null) &&
              (t.environment || 'prod') === (scope.environment || 'prod')
          )
          .map(t => t.assignee)
      ),
    markTaskCommitRunEnded: async (id: string) => {
      const t = rows.get(id);
      if (t) endCommitRun(t);
    },
    clearTaskCommitRun: async (id: string, startedAt: string | null) => {
      const t = rows.get(id);
      if (t?.commitRun && (startedAt === null || t.commitRun.startedAt === startedAt)) {
        t.commitRun = null;
      }
    },
    getOrphanCommitRuns: async (env: string) =>
      all()
        .filter(
          t =>
            card(t) &&
            t.commitRun &&
            t.actionRunning !== true &&
            (t.environment || 'prod') === env
        )
        .map(clone),
    mutateTaskCommits: async (id: string, mutate: (commits: any[]) => any[] | null) => {
      const t = rows.get(id);
      if (!live(t)) return null;
      const next = mutate(Array.isArray(t.commits) ? [...t.commits] : []);
      if (next) {
        t.commits = next;
        t.updatedAt = now();
      }
      return { task: clone(t), changed: !!next };
    },
    transferTaskOwner: async (id: string, toAgentId: string, historyEntry: any) => {
      const t = rows.get(id);
      if (!live(t)) return null;
      t.agentId = toAgentId;
      t.assignee = toAgentId;
      t.history = [...(Array.isArray(t.history) ? t.history : []), historyEntry];
      t.updatedAt = now();
      return clone(t);
    },
    RUN_CLAIM_STALE_SECONDS: 120,
    LEGACY_CLAIM_STALE_MINUTES: 20,
    // Mirrors the atomic comment accessors: only `comments` is touched.
    appendTaskComment: async (id: string, comment: any) => {
      const t = rows.get(id);
      if (!live(t)) return null;
      t.comments = [...(Array.isArray(t.comments) ? t.comments : []), comment];
      t.updatedAt = new Date().toISOString();
      return clone(t);
    },
    deleteTaskComment: async (id: string, commentId: string) => {
      const t = rows.get(id);
      if (!live(t) || !(t.comments || []).some((c: any) => c.id === commentId)) return null;
      t.comments = t.comments.filter((c: any) => c.id !== commentId);
      t.updatedAt = new Date().toISOString();
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
    // Mirrors the real restore: the row comes back with no run state.
    restoreTaskFromDb: async (id: string) => {
      const t = rows.get(id);
      if (!t || !t.deletedAt) return null;
      Object.assign(t, {
        deletedAt: undefined,
        actionRunning: false,
        actionRunningAgentId: null,
        actionRunningMode: null,
        actionHeartbeatAt: null,
        startedAt: null,
        commitRun: null,
      });
      return clone(t);
    },
    deleteTasksByAgent: async (agentId: string) => {
      for (const t of rows.values())
        if (t.agentId === agentId && !t.deletedAt) t.deletedAt = new Date().toISOString();
    },
    clearTaskExecutionFlags: async (agentId: string, env: any = null) => {
      for (const t of rows.values()) {
        const inEnv = !env || (t.environment || 'prod') === env;
        const executes = t.assignee === agentId || t.actionRunningAgentId === agentId;
        const flagged = t.startedAt || t.executionStatus || t.actionRunning === true;
        if (!live(t) || !inEnv || !executes || !flagged) continue;
        if (t.actionRunning === true) endCommitRun(t);
        Object.assign(t, {
          executionStatus: null,
          startedAt: null,
          completedActionIdx: null,
          _pendingOnEnter: undefined,
          actionRunning: false,
          actionRunningAgentId: null,
          actionRunningMode: null,
          actionHeartbeatAt: null,
          errorFromStatus: null,
        });
      }
    },
    clearActionRunningForAgent: async (agentId: string, env: any = null) => {
      for (const t of rows.values()) {
        const inEnv = !env || (t.environment || 'prod') === env;
        if (t.actionRunning === true && t.actionRunningAgentId === agentId && inEnv) {
          Object.assign(t, {
            actionRunning: false,
            actionRunningAgentId: null,
            actionRunningMode: null,
            actionHeartbeatAt: null,
          });
          endCommitRun(t);
        }
      }
    },
    // Mirrors the boot cleanup: legacy claims (no heartbeat) are cleared and
    // their column re-armed; a dead wait's 'watching' is dropped unless a live
    // (heartbeated, fresh) claim still holds the row.
    clearAllStaleActionRunning: async (env: any = null, staleSeconds = 120) => {
      let touched = 0;
      for (const t of rows.values()) {
        if (!live(t) || (env && (t.environment || 'prod') !== env)) continue;
        const legacy = t.actionRunning === true && !t.actionHeartbeatAt;
        const heartbeatAge = t.actionHeartbeatAt
          ? Date.now() - Date.parse(t.actionHeartbeatAt)
          : Number.POSITIVE_INFINITY;
        const deadWatch =
          t.executionStatus === 'watching' &&
          (t.actionRunning !== true || heartbeatAge > staleSeconds * 1000);
        if (!legacy && !deadWatch) continue;
        if (legacy) {
          if (!['done', 'error'].includes(t.status) && t.executionStatus !== 'stopped') {
            t._pendingOnEnter = t.status;
          }
          endCommitRun(t);
          Object.assign(t, {
            actionRunning: false,
            actionRunningAgentId: null,
            actionRunningMode: null,
          });
        }
        if (t.executionStatus === 'watching') t.executionStatus = null;
        touched++;
      }
      return touched;
    },

    // ── single-row reads ──────────────────────────────────────────────────
    getTaskById: async (id: string) => {
      const t = rows.get(id);
      return live(t) ? clone(t) : null;
    },
    getTaskByIdPrefix: async (idOrPrefix: string) => {
      const exact = rows.get(idOrPrefix);
      if (live(exact)) return clone(exact);
      const matches = all().filter(t => live(t) && String(t.id).startsWith(idOrPrefix));
      return matches.length === 1 ? clone(matches[0]) : null;
    },
    getDeletedTaskById: async (id: string) => {
      const t = rows.get(id);
      return t?.deletedAt ? clone(t) : null;
    },
    getActiveTaskForExecutor: async (agentId: string) => {
      const m = all().filter(
        t => card(t) && isExecutor(t, agentId) && !INACTIVE.has(t.status) && t.startedAt
      );
      return m[0] ? clone(m[0]) : null;
    },
    getTaskByActionRunningAgent: async (agentId: string, env: any = null) => {
      const m = all().filter(
        t =>
          card(t) &&
          t.actionRunningAgentId === agentId &&
          t.actionRunning &&
          (!env || (t.environment || 'prod') === env)
      );
      return m[0] ? clone(m[0]) : null;
    },

    // ── multi-row reads ───────────────────────────────────────────────────
    getTasksByAgent: async (agentId: string) =>
      all()
        .filter(t => card(t) && t.agentId === agentId)
        .map(clone),
    getAllTasks: async () => all().filter(card).map(clone),
    getAllTaskIds: async () =>
      all()
        .filter(live)
        .map(t => t.id),
    getActiveTasksByAgent: async (agentId: string) =>
      all()
        .filter(t => card(t) && t.agentId === agentId && !INACTIVE.has(t.status))
        .map(clone),
    getTasksByAssignee: async (agentId: string) =>
      all()
        .filter(t => card(t) && isExecutor(t, agentId))
        .map(clone),
    getTasksByBoard: async (boardId: string) =>
      all()
        .filter(t => card(t) && t.boardId === boardId)
        .map(clone),
    getTasksByStatusAndBoard: async (status: any = null, boardId: any = null) =>
      all()
        .filter(
          t => card(t) && (!status || t.status === status) && (!boardId || t.boardId === boardId)
        )
        .map(clone),
    // Board-scoped form (the one the agent tools use): an empty id list matches
    // nothing, mirroring the real query.
    getTasksByStatusAndBoards: async (status: any = null, boardIds: string[] = []) =>
      all()
        .filter(
          t =>
            card(t) &&
            (!status || t.status === status) &&
            !!t.boardId &&
            boardIds.includes(t.boardId)
        )
        .map(clone),
    getDeletedTasks: async () =>
      all()
        .filter(t => t?.deletedAt)
        .map(clone),
    getRecurringTasks: async () =>
      all()
        .filter(t => live(t) && t.isTemplate && t.recurrence)
        .map(clone),
    getTaskTemplates: async (boardId: string | null = null) =>
      all()
        .filter(t => live(t) && t.isTemplate && (!boardId || t.boardId === boardId))
        .map(clone),
    getTaskTemplateById: async (id: string) => {
      const t = rows.get(id);
      return live(t) && t.isTemplate ? clone(t) : null;
    },
    getOccurrencesForTemplate: async (templateId: string, limit = 50) =>
      all()
        .filter(t => live(t) && t.templateId === templateId)
        .sort((a, b) => (b.occurrenceSeq || 0) - (a.occurrenceSeq || 0))
        .slice(0, limit)
        .map(clone),
    countUnfinishedOccurrences: async (templateId: string) =>
      all().filter(
        t => live(t) && t.templateId === templateId && !['done', 'error'].includes(t.status)
      ).length,
    // Hard delete, like the real sweep: finished runs only, never one in flight.
    purgeTemplateOccurrences: async (
      templateId: string,
      { retentionDays, keepLast }: { retentionDays?: number | null; keepLast?: number | null } = {}
    ) => {
      const finished = all()
        .filter(t => live(t) && t.templateId === templateId && ['done', 'error'].includes(t.status))
        .sort((a, b) => (b.occurrenceSeq || 0) - (a.occurrenceSeq || 0));
      const cutoff = retentionDays ? Date.now() - retentionDays * 86400000 : null;
      const doomed = finished.filter((t, index) => {
        const endedAt = Date.parse(t.completedAt || t.updatedAt || t.createdAt || '');
        const tooOld = cutoff !== null && Number.isFinite(endedAt) && endedAt < cutoff;
        const tooMany = !!keepLast && index >= keepLast;
        return tooOld || tooMany;
      });
      for (const t of doomed) rows.delete(t.id);
      return doomed.length;
    },
    hasActiveTask: async (agentId: string, excludeTaskId: any = null) =>
      all().some(
        t => card(t) && isExecutor(t, agentId) && !INACTIVE.has(t.status) && t.id !== excludeTaskId
      ),
    countActiveTasksForAgent: async (agentId: string, excludeTaskId: any = null) =>
      all().filter(
        t => card(t) && isExecutor(t, agentId) && !INACTIVE.has(t.status) && t.id !== excludeTaskId
      ).length,
    getActiveWorkflowTasks: async (env: any = null) =>
      all()
        .filter(
          t =>
            card(t) &&
            t.boardId &&
            !t.isManual &&
            !['done', 'error'].includes(t.status) &&
            !t.actionRunning &&
            !['watching', 'stopped'].includes(t.executionStatus) &&
            (!env || (t.environment || 'prod') === env)
        )
        .map(clone),
    getInterruptedChainTasks: async (env: any = null) =>
      all()
        .filter(
          t =>
            card(t) &&
            t.boardId &&
            !t.isManual &&
            (t.actionRunning || t.completedActionIdx != null) &&
            (!env || (t.environment || 'prod') === env)
        )
        .map(clone),
    getTasksForResume: async (env: any = null) =>
      all()
        .filter(
          t =>
            card(t) &&
            t.startedAt &&
            t.actionRunning !== true &&
            !INACTIVE.has(t.status) &&
            !['watching', 'stopped'].includes(t.executionStatus) &&
            !t.isManual &&
            (!env || (t.environment || 'prod') === env)
        )
        .map(t => ({ ...clone(t), _agentStatus: 'idle', _agentEnabled: true })),
  };

  return { rows, exports };
}
