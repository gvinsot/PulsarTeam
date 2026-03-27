import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const TASKS_FILE = path.join(DATA_DIR, 'global-todos.json');

class GlobalTaskStore {
  constructor() {
    this.tasks = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        if (Array.isArray(data)) {
          for (const t of data) {
            // Backfill: ensure type and history exist
            if (!t.type) t.type = 'bug';
            if (!t.history) t.history = [{ from: null, to: t.status || 'backlog', at: t.createdAt || new Date().toISOString(), by: null }];
            this.tasks.set(t.id, t);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load global tasks:', err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TASKS_FILE, JSON.stringify(Array.from(this.tasks.values()), null, 2));
    } catch (err) {
      console.error('Failed to save global tasks:', err.message);
    }
  }

  getAll() {
    return Array.from(this.tasks.values());
  }

  add({ title, description, priority, status, assignee, project, type }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const initialStatus = status || 'backlog';
    const task = {
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

  update(id, updates, changedBy = null) {
    const task = this.tasks.get(id);
    if (!task) return null;
    const now = new Date().toISOString();
    const oldStatus = task.status;

    if (!task.history) task.history = [];

    // Track field edits in history
    const editedFields = [];
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

  delete(id) {
    const existed = this.tasks.has(id);
    this.tasks.delete(id);
    if (existed) this._save();
    return existed;
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  getHistory(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    return task.history || [];
  }

  getStats(projectFilter = null) {
    let tasks = Array.from(this.tasks.values());
    if (projectFilter) {
      tasks = tasks.filter(t => t.project === projectFilter);
    }

    const total = tasks.length;
    const byType = { bug: 0, feature: 0 };
    const byStatus = {};
    const resolutionTimes = [];
    const resolutionByType = { bug: [], feature: [] };
    const stateDurations = {};

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

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const median = arr => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const avgStateDurations = {};
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

  getTimeSeries(projectFilter = null, days = 30) {
    let tasks = Array.from(this.tasks.values());
    if (projectFilter) {
      tasks = tasks.filter(t => t.project === projectFilter);
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const toDay = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : null;

    // Build day-by-day maps
    const createdByDay = {};
    const resolvedByDay = {};
    const resolutionTimesByDay = {};

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
            resolvedByDay[resolvedDay] = (resolvedByDay[resolvedDay] || 0) + 1;

            // Resolution time for this task
            const created = new Date(t.createdAt).getTime();
            const resolved = new Date(h.at).getTime();
            const resMs = resolved - created;
            if (resMs > 0) {
              if (!resolutionTimesByDay[resolvedDay]) resolutionTimesByDay[resolvedDay] = [];
              resolutionTimesByDay[resolvedDay].push(resMs);
            }
            break; // only count first done transition per task in this window
          }
        }
      }
    }

    // Generate all days in range
    const allDays = [];
    for (let d = new Date(cutoff); d <= now; d.setDate(d.getDate() + 1)) {
      allDays.push(d.toISOString().slice(0, 10));
    }

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

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
