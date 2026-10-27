// Per-task cost summary — GET /tasks/:id/costs.
//
// Two sources are merged per agent:
//   • time: the task's 'execution' history entries, each spanning
//     `startedAt` → `at` (written by actionLogs.ts when a run ends);
//   • tokens / cost: token_usage_log rows attributed to the task
//     (getTaskTokenUsage), keyed by agent id with the agent's name.
// History only knows the executor NAME, so the merge key is the name.

import type { TaskUsageByAgentRow, TaskUsageWindow } from './database/tokenUsage.js';

/** The slice of a history entry this module reads. */
interface HistoryLike {
  type?: string;
  by?: string;
  at?: string;
  startedAt?: string;
}

export interface TaskCostAgent {
  agentId: string | null;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  cost: number;
  requests: number;
  /** Summed duration of the agent's completed runs, in milliseconds. */
  timeMs: number;
  runs: number;
  estimated: boolean;
}

export interface TaskCostSummary {
  totals: Omit<TaskCostAgent, 'agentId' | 'agentName'>;
  byAgent: TaskCostAgent[];
  /** An action is running right now: its time is not counted yet. */
  running: boolean;
}

/** Completed execution runs of a task, as attribution windows. */
export function executionWindows(history: HistoryLike[] | null | undefined): TaskUsageWindow[] {
  const out: TaskUsageWindow[] = [];
  for (const h of history || []) {
    if (h?.type !== 'execution' || !h.by || !h.startedAt || !h.at) continue;
    const start = Date.parse(h.startedAt);
    const end = Date.parse(h.at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({ agentName: h.by, start: h.startedAt, end: h.at });
  }
  return out;
}

const emptyAgent = (agentName: string, agentId: string | null = null): TaskCostAgent => ({
  agentId,
  agentName,
  inputTokens: 0,
  outputTokens: 0,
  contextTokens: 0,
  cost: 0,
  requests: 0,
  timeMs: 0,
  runs: 0,
  estimated: false,
});

export function buildTaskCostSummary(
  windows: TaskUsageWindow[],
  usage: TaskUsageByAgentRow[],
  running = false
): TaskCostSummary {
  const byName = new Map<string, TaskCostAgent>();
  const entryFor = (name: string, id: string | null = null) => {
    let entry = byName.get(name);
    if (!entry) {
      entry = emptyAgent(name, id);
      byName.set(name, entry);
    }
    if (id && !entry.agentId) entry.agentId = id;
    return entry;
  };

  for (const w of windows) {
    const entry = entryFor(w.agentName);
    entry.timeMs += Date.parse(w.end) - Date.parse(w.start);
    entry.runs += 1;
  }
  for (const row of usage) {
    const entry = entryFor(row.agent_name || row.agent_id, row.agent_id);
    entry.inputTokens += Number(row.input_tokens) || 0;
    entry.outputTokens += Number(row.output_tokens) || 0;
    entry.contextTokens += Number(row.context_tokens) || 0;
    entry.cost += Number(row.cost) || 0;
    entry.requests += Number(row.request_count) || 0;
    entry.estimated = entry.estimated || !!row.estimated;
  }

  const byAgent = [...byName.values()].sort((a, b) => b.cost - a.cost || b.timeMs - a.timeMs);
  const { agentId: _id, agentName: _name, ...zero } = emptyAgent('');
  const totals = byAgent.reduce(
    (t, a) => ({
      inputTokens: t.inputTokens + a.inputTokens,
      outputTokens: t.outputTokens + a.outputTokens,
      contextTokens: t.contextTokens + a.contextTokens,
      cost: t.cost + a.cost,
      requests: t.requests + a.requests,
      timeMs: t.timeMs + a.timeMs,
      runs: t.runs + a.runs,
      estimated: t.estimated || a.estimated,
    }),
    zero
  );
  return { totals, byAgent, running };
}
