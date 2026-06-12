import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const TASKS_FILE = path.join(DATA_DIR, 'global-todos.json');

interface TaskHistoryEntry {
  type?: string;
  from?: string | null;
  to?: string;
  at: string;
  by: string | null;
  fields?: Array<{ field: string; oldValue: any; newValue: any }>;
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  type: string;
  priority: string;
  assignee: string | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  history: TaskHistoryEntry[];
  [key: string]: any;
}

class GlobalTaskStore {
  tasks: Map<string, Task>;

  constructor() {
    this.tasks = new Map();
    this._load();
  }

  _load(): void {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const raw = fs.readFileSync(TASKS_FILE, 'utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch (parseErr: any) {
          // The file was readable but its content is corrupt (e.g. truncated
          // by a crash mid-write). Move it aside instead of letting the next
          // _save() silently overwrite it with an empty store.
          const backup = `${TASKS_FILE}.corrupt-${Date.now()}`;
          fs.renameSync(TASKS_FILE, backup);
          console.error(`Failed to parse global tasks (${parseErr.message}) — corrupt file backed up to ${backup}`);
          return;
        }
        if (Array.isArray(data)) {
          for (const t of data) {
            this.tasks.set(t.id, t);
          }
        }
      }
    } catch (err: any) {
      console.error('Failed to load global tasks:', err.message);
    }
  }

  _save(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      // Atomic write: a crash or full disk mid-write must not leave a
      // truncated tasks file behind (rename replaces the target atomically).
      const tmp = `${TASKS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Array.from(this.tasks.values()), null, 2));
      fs.renameSync(tmp, TASKS_FILE);
    } catch (err: any) {
      console.error('Failed to save global tasks:', err.message);
    }
  }

  getAll(): Task[] {
    return Array.from(this.tasks.values()).filter(t => !t.deletedAt);
  }

  add({ title, description, priority, status, assignee, project, type }: {
    title?: string;
    description?: string;
    priority?: string;
    status?: string;
    assignee?: string | null;
    project?: string | null;
    type?: string;
  }): Task {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const initialStatus = status || 'backlog';
    const task: Task = {
      id,
      title: title || 'Untitled',
      description: description || '',
      status: initialStatus,
      type: type || 'bug',
      priority: priority || 'medium',
      assignee: assignee || null,
      project: project || null,
      createdAt: now,
      updatedAt: now,
      history: [{ from: null, to: initialStatus, at: now, by: null }],
    };
    this.tasks.set(id, task);
    this._save();
    return task;
  }

  update(id: string, updates: Partial<Task>, changedBy: string | null = null): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    const now = new Date().toISOString();
    const oldStatus = task.status;

    if (!task.history) task.history = [];

    // Track field edits in history
    const editedFields: Array<{ field: string; oldValue: any; newValue: any }> = [];
    if (updates.title !== undefined && updates.title !== task.title) {
      editedFields.push({ field: 'title', oldValue: task.title, newValue: updates.title });
      task.title = updates.title;
    } else if (updates.title !== undefined) {
      task.title = updates.title;
    }
    if (updates.description !== undefined && updates.description !== task.description) {
      editedFields.push({ field: 'description', oldValue: task.description, newValue: updates.description });
      task.description = updates.description;
    } else if (updates.description !== undefined) {
      task.description = updates.description;
    }
    if (updates.priority !== undefined && updates.priority !== task.priority) {
      editedFields.push({ field: 'priority', oldValue: task.priority, newValue: updates.priority });
      task.priority = updates.priority;
    } else if (updates.priority !== undefined) {
      task.priority = updates.priority;
    }
    if (updates.assignee !== undefined && updates.assignee !== task.assignee) {
      editedFields.push({ field: 'assignee', oldValue: task.assignee, newValue: updates.assignee });
      task.assignee = updates.assignee;
    } else if (updates.assignee !== undefined) {
      task.assignee = updates.assignee;
    }
    if (updates.project !== undefined && updates.project !== task.project) {
      editedFields.push({ field: 'project', oldValue: task.project, newValue: updates.project });
      task.project = updates.project;
    } else if (updates.project !== undefined) {
      task.project = updates.project;
    }
    if (updates.type !== undefined && updates.type !== task.type) {
      editedFields.push({ field: 'type', oldValue: task.type, newValue: updates.type });
      task.type = updates.type;
    } else if (updates.type !== undefined) {
      task.type = updates.type;
    }

    if (editedFields.length > 0) {
      task.history.push({ type: 'edit', fields: editedFields, at: now, by: changedBy });
    }

    // Track status changes in history
    if (updates.status !== undefined && updates.status !== oldStatus) {
      task.status = updates.status;
      task.history.push({ from: oldStatus, to: updates.status, at: now, by: changedBy });
    }

    task.updatedAt = now;
    this._save();
    return task;
  }

  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.deletedAt) return false;
    task.deletedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    if (!task.history) task.history = [];
    task.history.push({ type: 'deleted', at: task.deletedAt, by: null });
    this._save();
    return true;
  }

  restore(id: string): Task | null {
    const task = this.tasks.get(id);
    if (!task || !task.deletedAt) return null;
    delete task.deletedAt;
    task.updatedAt = new Date().toISOString();
    if (!task.history) task.history = [];
    task.history.push({ type: 'restored', at: task.updatedAt, by: null });
    this._save();
    return task;
  }

  hardDelete(id: string): boolean {
    const existed = this.tasks.has(id);
    this.tasks.delete(id);
    if (existed) this._save();
    return existed;
  }

  getDeleted(): Task[] {
    return Array.from(this.tasks.values()).filter(t => !!t.deletedAt);
  }

  get(id: string): Task | null {
    const task = this.tasks.get(id);
    if (!task || task.deletedAt) return null;
    return task;
  }

  getIncludingDeleted(id: string): Task | null {
    return this.tasks.get(id) || null;
  }

  getHistory(id: string): TaskHistoryEntry[] | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    return task.history || [];
  }

  getStats(projectFilter: string | null = null): any {
    let tasks = Array.from(this.tasks.values()).filter(t => !t.deletedAt);
    if (projectFilter) {
      tasks = tasks.filter(t => t.project === projectFilter);
    }

    const total = tasks.length;
    const byType: Record<string, number> = { bug: 0, feature: 0 };
    const byStatus: Record<string, number> = {};
    const resolutionTimes: number[] = [];
    const resolutionByType: Record<string, number[]> = { bug: [], feature: [] };
    const stateDurations: Record<string, number[]> = {};

    for (const t of tasks) {
      // Count by type
      byType[t.type || 'bug'] = (byType[t.type || 'bug'] || 0) + 1;

      // Count by status
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;

      // Calculate resolution time (creation to done)
      if (t.status === 'done' && t.history?.length) {
        const doneEntry = [...t.history].reverse().find(h => h.to === 'done');
        if (doneEntry) {
          const created = new Date(t.createdAt).getTime();
          const resolved = new Date(doneEntry.at).getTime();
          const resMs = resolved - created;
          if (resMs > 0) {
            resolutionTimes.push(resMs);
            const typ = t.type || 'bug';
            if (!resolutionByType[typ]) resolutionByType[typ] = [];
            resolutionByType[typ].push(resMs);
          }
        }
      }

      // Calculate time in each state
      if (t.history?.length > 1) {
        for (let i = 0; i < t.history.length - 1; i++) {
          const state = t.history[i].to;
          if (!state) continue;
          const enterTime = new Date(t.history[i].at).getTime();
          const exitTime = new Date(t.history[i + 1].at).getTime();
          const dur = exitTime - enterTime;
          if (dur > 0) {
            if (!stateDurations[state]) stateDurations[state] = [];
            stateDurations[state].push(dur);
          }
        }
      }
    }

    const avg = (arr: number[]): number => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const median = (arr: number[]): number => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const avgStateDurations: Record<string, { avg: number; median: number; count: number }> = {};
    for (const [state, durations] of Object.entries(stateDurations)) {
      avgStateDurations[state] = {
        avg: Math.round(avg(durations)),
        median: Math.round(median(durations)),
        count: durations.length,
      };
    }

    return {
      total,
      byType,
      byStatus,
      resolution: {
        count: resolutionTimes.length,
        avg: Math.round(avg(resolutionTimes)),
        median: Math.round(median(resolutionTimes)),
      },
      resolutionByType: {
        bug: { count: resolutionByType.bug.length, avg: Math.round(avg(resolutionByType.bug)), median: Math.round(median(resolutionByType.bug)) },
        feature: { count: resolutionByType.feature.length, avg: Math.round(avg(resolutionByType.feature)), median: Math.round(median(resolutionByType.feature)) },
      },
      avgStateDurations,
    };
  }

  getTimeSeries(projectFilter: string | null = null, days: number = 30): any {
    let tasks = Array.from(this.tasks.values()).filter(t => !t.deletedAt);
    if (projectFilter) {
      tasks = tasks.filter(t => t.project === projectFilter);
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const toDay = (iso: string | null | undefined): string | null => iso ? new Date(iso).toISOString().slice(0, 10) : null;

    // Build day-by-day maps
    const createdByDay: Record<string, number> = {};
    const resolvedByDay: Record<string, number> = {};
    const resolutionTimesByDay: Record<string, number[]> = {};

    for (const t of tasks) {
      // Count created per day
      const createdDay = toDay(t.createdAt);
      if (createdDay && new Date(t.createdAt) >= cutoff) {
        createdByDay[createdDay] = (createdByDay[createdDay] || 0) + 1;
      }

      // Count resolved per day + track resolution times
      if (t.history?.length) {
        for (const h of t.history) {
          if (h.to === 'done' && h.at && new Date(h.at) >= cutoff) {
            const resolvedDay = toDay(h.at);
            if (resolvedDay) {
              resolvedByDay[resolvedDay] = (resolvedByDay[resolvedDay] || 0) + 1;

              // Resolution time for this task
              const created = new Date(t.createdAt).getTime();
              const resolved = new Date(h.at).getTime();
              const resMs = resolved - created;
              if (resMs > 0) {
                if (!resolutionTimesByDay[resolvedDay]) resolutionTimesByDay[resolvedDay] = [];
                resolutionTimesByDay[resolvedDay].push(resMs);
              }
            }
            break; // only count first done transition per task in this window
          }
        }
      }
    }

    // Generate all days in range
    const allDays: string[] = [];
    for (let d = new Date(cutoff); d <= now; d.setDate(d.getDate() + 1)) {
      allDays.push(d.toISOString().slice(0, 10));
    }

    const avg = (arr: number[]): number => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const createdVsResolved = allDays.map(day => ({
      date: day,
      created: createdByDay[day] || 0,
      resolved: resolvedByDay[day] || 0,
    }));

    const resolutionTimeEvolution = allDays
      .filter(day => resolutionTimesByDay[day]?.length > 0)
      .map(day => ({
        date: day,
        avgMs: Math.round(avg(resolutionTimesByDay[day])),
        count: resolutionTimesByDay[day].length,
      }));

    // Cumulative open count (created - resolved running total)
    let cumOpen = 0;
    // Count tasks created before the window that are still not done
    for (const t of tasks) {
      if (new Date(t.createdAt) < cutoff && t.status !== 'done') cumOpen++;
      if (new Date(t.createdAt) < cutoff && t.status === 'done') {
        const doneEntry = t.history?.find(h => h.to === 'done');
        if (doneEntry && new Date(doneEntry.at) >= cutoff) cumOpen++; // was open at cutoff
      }
    }
    const openOverTime = createdVsResolved.map(d => {
      cumOpen += d.created - d.resolved;
      return { date: d.date, open: Math.max(0, cumOpen) };
    });

    return { createdVsResolved, resolutionTimeEvolution, openOverTime };
  }
}

export const globalTaskStore = new GlobalTaskStore();
