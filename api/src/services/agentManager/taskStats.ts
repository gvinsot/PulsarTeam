// ─── Task Statistics & Time Series ──────────────────────────────────────────
import { getAllTasks } from '../database.js';

/** @this {import('./index.js').AgentManager} */
export const taskStatsMethods = {

  async _collectTasks(this: any, projectFilter: string | null = null, allowedBoardIds: Set<string> | null = null): Promise<any[]> {
    // Group every live task by owning agent (board-level, ownerless tasks are
    // excluded from stats — matching the prior agent-keyed store).
    const byAgent = new Map<string, any[]>();
    for (const t of await getAllTasks()) {
      if (!t.agentId) continue;
      let list = byAgent.get(t.agentId);
      if (!list) { list = []; byAgent.set(t.agentId, list); }
      list.push(t);
    }
    const tasks: any[] = [];
    for (const agent of this.agents.values()) {
      if (allowedBoardIds && (agent as any).boardId && !allowedBoardIds.has((agent as any).boardId)) continue;
      const tasks_ = byAgent.get((agent as any).id) || [];
      if (!tasks_.length) continue;
      for (const t of tasks_) {
        if (allowedBoardIds && t.boardId && !allowedBoardIds.has(t.boardId)) continue;
        const proj = t.project || (agent as any).project || null;
        if (projectFilter && proj !== projectFilter) continue;
        tasks.push({ ...t, _agentId: (agent as any).id, _project: proj });
      }
    }
    return tasks;
  },

  async getTaskStats(this: any, projectFilter: string | null = null, allowedBoardIds: Set<string> | null = null): Promise<any> {
    const tasks = await this._collectTasks(projectFilter, allowedBoardIds);
    const total = tasks.length;
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const resolutionTimes: number[] = [];
    const resolutionByType: Record<string, number[]> = {};
    const stateDurations: Record<string, number[]> = {};

    for (const t of tasks) {
      const typ = t.taskType || 'untyped';
      byType[typ] = (byType[typ] || 0) + 1;
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;

      if (t.status === 'done' && t.history?.length) {
        const doneEntry = [...t.history].reverse().find((h: any) => h.status === 'done' || h.to === 'done');
        if (doneEntry) {
          const created = new Date(t.createdAt).getTime();
          const resolved = new Date(doneEntry.at).getTime();
          const resMs = resolved - created;
          if (resMs > 0) {
            resolutionTimes.push(resMs);
            if (!resolutionByType[typ]) resolutionByType[typ] = [];
            resolutionByType[typ].push(resMs);
          }
        }
      }

      if (t.history?.length > 1) {
        for (let i = 0; i < t.history.length - 1; i++) {
          const state = t.history[i].status || t.history[i].to;
          const enterTime = new Date(t.history[i].at).getTime();
          const exitTime = new Date(t.history[i + 1].at).getTime();
          const dur = exitTime - enterTime;
          if (dur > 0 && state) {
            if (!stateDurations[state]) stateDurations[state] = [];
            stateDurations[state].push(dur);
          }
        }
      }
    }

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const median = (arr: number[]) => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const avgStateDurations: Record<string, any> = {};
    for (const [state, durations] of Object.entries(stateDurations)) {
      avgStateDurations[state] = {
        avg: Math.round(avg(durations)),
        median: Math.round(median(durations)),
        count: durations.length,
      };
    }

    const resolutionByTypeStats: Record<string, any> = {};
    for (const [typ, arr] of Object.entries(resolutionByType)) {
      resolutionByTypeStats[typ] = { count: arr.length, avg: Math.round(avg(arr)), median: Math.round(median(arr)) };
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
      resolutionByType: resolutionByTypeStats,
      avgStateDurations,
    };
  },

  async getTaskTimeSeries(this: any, projectFilter: string | null = null, days: number = 30, allowedBoardIds: Set<string> | null = null): Promise<any> {
    const tasks = await this._collectTasks(projectFilter, allowedBoardIds);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const toDay = (iso: string | null) => iso ? new Date(iso).toISOString().slice(0, 10) : null;

    const createdByDay: Record<string, number> = {};
    const resolvedByDay: Record<string, number> = {};
    const resolutionTimesByDay: Record<string, number[]> = {};

    for (const t of tasks) {
      const createdDay = toDay(t.createdAt);
      if (createdDay && new Date(t.createdAt) >= cutoff) {
        createdByDay[createdDay] = (createdByDay[createdDay] || 0) + 1;
      }

      if (t.history?.length) {
        for (const h of t.history) {
          const target = h.status || h.to;
          if (target === 'done' && h.at && new Date(h.at) >= cutoff) {
            const resolvedDay = toDay(h.at) as string;
            resolvedByDay[resolvedDay] = (resolvedByDay[resolvedDay] || 0) + 1;
            const created = new Date(t.createdAt).getTime();
            const resolved = new Date(h.at).getTime();
            const resMs = resolved - created;
            if (resMs > 0) {
              if (!resolutionTimesByDay[resolvedDay]) resolutionTimesByDay[resolvedDay] = [];
              resolutionTimesByDay[resolvedDay].push(resMs);
            }
            break;
          }
        }
      }
    }

    const allDays: string[] = [];
    for (let d = new Date(cutoff); d <= now; d.setDate(d.getDate() + 1)) {
      allDays.push(d.toISOString().slice(0, 10));
    }

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

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

    let cumOpen = 0;
    for (const t of tasks) {
      if (new Date(t.createdAt) < cutoff && t.status !== 'done') cumOpen++;
      if (new Date(t.createdAt) < cutoff && t.status === 'done') {
        const doneEntry = t.history?.find((h: any) => (h.status || h.to) === 'done');
        if (doneEntry && new Date(doneEntry.at) >= cutoff) cumOpen++;
      }
    }
    const openOverTime = createdVsResolved.map(d => {
      cumOpen += d.created - d.resolved;
      return { date: d.date, open: Math.max(0, cumOpen) };
    });

    return { createdVsResolved, resolutionTimeEvolution, openOverTime };
  },

  async getAgentTimeSeries(this: any, projectFilter: string | null = null, days: number = 30, allowedBoardIds: Set<string> | null = null): Promise<any> {
    const tasks = await this._collectTasks(projectFilter, allowedBoardIds);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const toDay = (d: Date) => d.toISOString().slice(0, 10);

    const ACTIVE_STATES = new Set(['pending', 'in_progress', 'code', 'build', 'test', 'deploy', 'review']);

    // Build a map: agentId -> agentName
    const agentNames: Record<string, string> = {};
    for (const agent of this.agents.values()) {
      agentNames[(agent as any).id] = (agent as any).name || (agent as any).id.slice(0, 8);
    }

    // dailyAgent: { "2026-03-20": { "agentId1": msTotal, "agentId2": msTotal } }
    const dailyAgent: Record<string, Record<string, number>> = {};

    for (const t of tasks) {
      const agentId = t.assignee || t.agentId || t._agentId;
      if (!agentId) continue;

      // Build timeline from history entries
      const events: Array<{ at: number; status: string | null }> = [];
      if (t.history?.length) {
        for (const h of t.history) {
          if (h.at) {
            events.push({ at: new Date(h.at).getTime(), status: h.status || h.to || null });
          }
        }
      }
      // If task was started but has no history transitions, use startedAt -> completedAt/now
      if (events.length === 0 && t.startedAt) {
        const start = new Date(t.startedAt).getTime();
        const end = t.completedAt ? new Date(t.completedAt).getTime() : now.getTime();
        events.push({ at: start, status: t.status });
        events.push({ at: end, status: 'done' });
      }

      if (events.length < 2) continue;
      events.sort((a, b) => a.at - b.at);

      // Walk through consecutive pairs and attribute active time
      for (let i = 0; i < events.length - 1; i++) {
        const state = events[i].status;
        if (!state || !ACTIVE_STATES.has(state)) continue;

        const start = Math.max(events[i].at, cutoff.getTime());
        const end = Math.min(events[i + 1].at, now.getTime());
        if (end <= start) continue;

        // Distribute across days
        let cursor = new Date(start);
        while (cursor.getTime() < end) {
          const dayStr = toDay(cursor);
          const dayEnd = new Date(cursor);
          dayEnd.setUTCHours(23, 59, 59, 999);
          const segEnd = Math.min(dayEnd.getTime() + 1, end);
          const ms = segEnd - cursor.getTime();

          if (ms > 0) {
            if (!dailyAgent[dayStr]) dailyAgent[dayStr] = {};
            dailyAgent[dayStr][agentId] = (dailyAgent[dayStr][agentId] || 0) + ms;
          }

          // Move to next day
          cursor = new Date(dayEnd.getTime() + 1);
        }
      }
    }

    // Build date range
    const allDays: string[] = [];
    for (let d = new Date(cutoff); d <= now; d.setDate(d.getDate() + 1)) {
      allDays.push(d.toISOString().slice(0, 10));
    }

    // Collect all agents that appear
    const agentSet = new Set<string>();
    for (const dayData of Object.values(dailyAgent)) {
      for (const id of Object.keys(dayData)) agentSet.add(id);
    }

    const agents = Array.from(agentSet).map(id => ({
      id,
      name: agentNames[id] || id.slice(0, 8),
    }));

    const daily = allDays.map(date => {
      const agentTimes: Record<string, number> = {};
      for (const a of agents) {
        agentTimes[a.id] = dailyAgent[date]?.[a.id] || 0;
      }
      return { date, agentTimes };
    });

    // Totals
    let totalMs = 0;
    for (const d of daily) {
      for (const ms of Object.values(d.agentTimes)) totalMs += ms;
    }
    const daysWithData = daily.filter(d => Object.values(d.agentTimes).some(ms => ms > 0)).length;
    const avgDailyMs = daysWithData > 0 ? Math.round(totalMs / daysWithData) : 0;

    return { agents, daily, totalMs, avgDailyMs };
  },
};
