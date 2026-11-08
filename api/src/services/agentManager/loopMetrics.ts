// ─── Native agentic loop metrics (ADR sandbox-agentic-loop, lot 4 §14) ───────
//
// The sandbox runner has no LLM: the agentic loop runs in the API (chat.ts →
// tools.ts). To measure the effect of the loop improvements (lots 1–3) we
// record, for every native turn served for a task:
//   • per tool call — name, duration, success, exit code, output size, truncation;
//   • per turn      — model calls, tool rounds, input/output tokens, whether a
//                     [SYSTEM REMINDER] started it, and the estimated share of
//                     the context occupied by tool results.
//
// One compact `type: 'loop-metrics'` entry per turn is appended to
// `task.history` (atomic jsonb concat, so concurrent writers are safe).
// `summarizeLoopMetrics` folds those entries into the per-task view served by
// GET /api/tasks/:id/loop-metrics; `aggregateLoopMetrics` feeds the board-wide
// task stats (taskStats.ts).
//
// `lots` stamps every entry with the loop lots enabled when it was recorded,
// so a baseline taken before lot 1/2 can be compared with the runs after.
// Keep this module free of I/O: chat.ts owns the write, the tests use it pure.

/** `task.history[].type` of a loop-metrics entry. */
export const LOOP_METRICS_TYPE = 'loop-metrics';

/** Detailed per-call records kept per turn; the per-tool totals stay exact. */
export const MAX_CALL_RECORDS_PER_TURN = 60;

/** One native tool call as measured by the loop. */
export interface ToolCallMetric {
  name: string;
  durationMs: number;
  /** `success` as reported to the model (run_command says true on exit≠0 before lot 1). */
  success: boolean;
  /** Process exit code for run_command, null for other tools. */
  exitCode: number | null;
  /** Characters of the full tool result (result or error text). */
  outputChars: number;
  /** Characters of the role:'tool' message sent to the model (JSON envelope included). */
  sentChars: number;
  /** The tool or the loop cut the output. */
  truncated: boolean;
}

/** Totals for one tool name. */
export interface ToolAggregate {
  calls: number;
  /** Effective failures: `success: false`, or a non-zero exit code. */
  failures: number;
  totalMs: number;
  maxMs: number;
  outputChars: number;
  truncated: number;
}

/** One `task.history` entry: everything one native turn did. */
export interface LoopTurnMetrics {
  type: typeof LOOP_METRICS_TYPE;
  at: string;
  /** Agent name (same convention as the other history entries). */
  by: string;
  agentId: string;
  /** The turn was started by a [SYSTEM REMINDER] (the task was not closed). */
  reminder: boolean;
  outcome: 'ok' | 'tool-budget' | 'error';
  durationMs: number;
  /** Model requests (initial + tool continuations + length continuations). */
  llmCalls: number;
  /** Assistant turns that asked for tools. */
  toolRounds: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  tools: Record<string, ToolAggregate>;
  /** First MAX_CALL_RECORDS_PER_TURN calls in order. */
  calls: ToolCallMetric[];
  /** Calls beyond the cap (counted in `tools`, not detailed in `calls`). */
  callsOmitted: number;
  /** Estimated share (0..1) of the prompt taken by tool results, last request. */
  toolContextShare: number;
  /** Highest share over the turn's requests. */
  peakToolContextShare: number;
  /** Loop lots enabled (AGENT_LOOP_V2_LOT{n}); [] = baseline. */
  lots: number[];
}

/** Per-task summary served by the API. */
export interface TaskLoopMetrics {
  turns: number;
  reminders: number;
  llmCalls: number;
  toolRounds: number;
  toolCalls: number;
  failedToolCalls: number;
  truncatedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Mean of the turns' last-request share (0..1). */
  avgToolContextShare: number;
  peakToolContextShare: number;
  toolBudgetHits: number;
  errorTurns: number;
  byTool: Array<ToolAggregate & { name: string; avgMs: number; errorRate: number }>;
  /** Distinct lot sets seen, e.g. [[]] for a pure baseline. */
  lots: number[][];
  firstAt: string | null;
  lastAt: string | null;
  /** Per-turn entries, oldest first. */
  turnsDetail: LoopTurnMetrics[];
}

interface ToolResultLike {
  success?: boolean;
  result?: unknown;
  error?: unknown;
  durationMs?: unknown;
  meta?: { exitCode?: unknown; truncated?: unknown } | null;
}

/** Lots switched on by `AGENT_LOOP_V2_LOT{n}` (see the ADR's reversibility note). */
export function activeLoopLots(env: NodeJS.ProcessEnv = process.env): number[] {
  const lots: number[] = [];
  for (let n = 1; n <= 4; n++) {
    const raw = (env[`AGENT_LOOP_V2_LOT${n}`] || '').trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') lots.push(n);
  }
  return lots;
}

const textLength = (v: unknown) => (typeof v === 'string' ? v.length : 0);

/** Old run_command cut its output at 10 000 chars without always saying so. */
const RUN_COMMAND_OUTPUT_CAP = 10_000;

/** Build the metric of one tool call from its result and what reached the model
 * (`sentChars` = the role:'tool' message length; `cappedByLoop` = the per-round
 * cap shortened it). */
export function toolCallMetric(
  name: string,
  result: ToolResultLike | undefined,
  sentChars: number,
  cappedByLoop = false
): ToolCallMetric {
  const r = result || { success: false };
  const outputChars = textLength(r.result) + textLength(r.error);
  const metaExit = r.meta?.exitCode;
  let exitCode: number | null = typeof metaExit === 'number' ? metaExit : null;
  if (exitCode === null && name === 'run_command' && r.success) exitCode = 0;
  const truncated =
    r.meta?.truncated === true ||
    cappedByLoop ||
    (name === 'run_command' && textLength(r.result) >= RUN_COMMAND_OUTPUT_CAP);
  const duration = typeof r.durationMs === 'number' && r.durationMs > 0 ? r.durationMs : 0;
  return {
    name,
    durationMs: Math.round(duration),
    success: r.success === true,
    exitCode,
    outputChars,
    sentChars,
    truncated,
  };
}

/** A call failed for real: reported failure, or a non-zero exit code. */
export const isFailedCall = (c: Pick<ToolCallMetric, 'success' | 'exitCode'>) =>
  !c.success || (c.exitCode !== null && c.exitCode !== 0);

function messageChars(m: { content?: unknown; toolCalls?: unknown }): number {
  let n = 0;
  if (typeof m.content === 'string') n += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part && typeof part === 'object' && 'text' in part) n += textLength(part.text);
    }
  }
  if (Array.isArray(m.toolCalls)) {
    for (const c of m.toolCalls) {
      if (c && typeof c === 'object') n += JSON.stringify(c).length;
    }
  }
  return n;
}

/** Estimated share (0..1) of the prompt characters taken by role:'tool' messages. */
export function toolContextShare(
  messages: ReadonlyArray<{ role?: unknown; content?: unknown; toolCalls?: unknown }>
): number {
  let total = 0;
  let tool = 0;
  for (const m of messages) {
    const n = messageChars(m);
    total += n;
    if (m.role === 'tool') tool += n;
  }
  return total > 0 ? tool / total : 0;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Accumulates one native turn; `entry()` renders the history entry. */
export class LoopMetricsRecorder {
  private readonly startedAt = Date.now();
  private llmCalls = 0;
  private toolRounds = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly calls: ToolCallMetric[] = [];
  private callsOmitted = 0;
  private readonly tools: Record<string, ToolAggregate> = {};
  private lastShare = 0;
  private peakShare = 0;

  constructor(
    private readonly agent: { id: string; name: string },
    private readonly reminder: boolean,
    private readonly lots: number[] = activeLoopLots()
  ) {}

  /** One `_streamAndContinue` result, measured against the prompt it was sent. */
  recordModelCall(
    usage: { inputTokens?: number; outputTokens?: number; llmCalls?: number },
    messages: ReadonlyArray<{ role?: unknown; content?: unknown; toolCalls?: unknown }>
  ): void {
    this.llmCalls += usage.llmCalls && usage.llmCalls > 0 ? usage.llmCalls : 1;
    this.inputTokens += usage.inputTokens || 0;
    this.outputTokens += usage.outputTokens || 0;
    const share = toolContextShare(messages);
    this.lastShare = share;
    if (share > this.peakShare) this.peakShare = share;
  }

  recordToolRound(): void {
    this.toolRounds++;
  }

  recordToolCall(metric: ToolCallMetric): void {
    const agg = (this.tools[metric.name] ??= {
      calls: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
      outputChars: 0,
      truncated: 0,
    });
    agg.calls++;
    if (isFailedCall(metric)) agg.failures++;
    agg.totalMs += metric.durationMs;
    agg.maxMs = Math.max(agg.maxMs, metric.durationMs);
    agg.outputChars += metric.outputChars;
    if (metric.truncated) agg.truncated++;
    if (this.calls.length < MAX_CALL_RECORDS_PER_TURN) this.calls.push(metric);
    else this.callsOmitted++;
  }

  /** Nothing worth recording: no model answer and no tool ran. */
  get isEmpty(): boolean {
    return this.llmCalls === 0 && this.calls.length === 0 && this.callsOmitted === 0;
  }

  entry(outcome: LoopTurnMetrics['outcome'], now: Date = new Date()): LoopTurnMetrics {
    return {
      type: LOOP_METRICS_TYPE,
      at: now.toISOString(),
      by: this.agent.name,
      agentId: this.agent.id,
      reminder: this.reminder,
      outcome,
      durationMs: Math.max(0, now.getTime() - this.startedAt),
      llmCalls: this.llmCalls,
      toolRounds: this.toolRounds,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      toolCallCount: this.calls.length + this.callsOmitted,
      tools: this.tools,
      calls: this.calls,
      callsOmitted: this.callsOmitted,
      toolContextShare: round3(this.lastShare),
      peakToolContextShare: round3(this.peakShare),
      lots: this.lots,
    };
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Loop-metrics entries of a task history, oldest first. */
export function loopMetricsEntries(history: unknown): LoopTurnMetrics[] {
  if (!Array.isArray(history)) return [];
  return history.filter(
    (h): h is LoopTurnMetrics =>
      !!h && typeof h === 'object' && (h as { type?: unknown }).type === LOOP_METRICS_TYPE
  );
}

function mergeTools(into: Record<string, ToolAggregate>, from: unknown): void {
  if (!from || typeof from !== 'object') return;
  for (const [name, raw] of Object.entries(from as Record<string, Partial<ToolAggregate>>)) {
    if (!raw || typeof raw !== 'object') continue;
    const agg = (into[name] ??= {
      calls: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
      outputChars: 0,
      truncated: 0,
    });
    agg.calls += num(raw.calls);
    agg.failures += num(raw.failures);
    agg.totalMs += num(raw.totalMs);
    agg.maxMs = Math.max(agg.maxMs, num(raw.maxMs));
    agg.outputChars += num(raw.outputChars);
    agg.truncated += num(raw.truncated);
  }
}

function toolRows(tools: Record<string, ToolAggregate>): TaskLoopMetrics['byTool'] {
  return Object.entries(tools)
    .map(([name, a]) => ({
      name,
      ...a,
      avgMs: a.calls ? Math.round(a.totalMs / a.calls) : 0,
      errorRate: a.calls ? round3(a.failures / a.calls) : 0,
    }))
    .sort((x, y) => y.calls - x.calls || x.name.localeCompare(y.name));
}

/** Fold a task's loop-metrics history entries into its per-task summary. */
export function summarizeLoopMetrics(history: unknown): TaskLoopMetrics {
  const turns = loopMetricsEntries(history);
  const tools: Record<string, ToolAggregate> = {};
  const lotKeys = new Map<string, number[]>();
  let shareSum = 0;
  const s: TaskLoopMetrics = {
    turns: turns.length,
    reminders: 0,
    llmCalls: 0,
    toolRounds: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    truncatedToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    avgToolContextShare: 0,
    peakToolContextShare: 0,
    toolBudgetHits: 0,
    errorTurns: 0,
    byTool: [],
    lots: [],
    firstAt: turns[0]?.at ?? null,
    lastAt: turns[turns.length - 1]?.at ?? null,
    turnsDetail: turns,
  };
  for (const t of turns) {
    if (t.reminder) s.reminders++;
    if (t.outcome === 'tool-budget') s.toolBudgetHits++;
    if (t.outcome === 'error') s.errorTurns++;
    s.llmCalls += num(t.llmCalls);
    s.toolRounds += num(t.toolRounds);
    s.toolCalls += num(t.toolCallCount);
    s.inputTokens += num(t.inputTokens);
    s.outputTokens += num(t.outputTokens);
    s.durationMs += num(t.durationMs);
    shareSum += num(t.toolContextShare);
    s.peakToolContextShare = Math.max(s.peakToolContextShare, num(t.peakToolContextShare));
    mergeTools(tools, t.tools);
    const lots = Array.isArray(t.lots) ? t.lots.filter(n => typeof n === 'number') : [];
    lotKeys.set(lots.join(','), lots);
  }
  for (const a of Object.values(tools)) {
    s.failedToolCalls += a.failures;
    s.truncatedToolCalls += a.truncated;
  }
  s.avgToolContextShare = turns.length ? round3(shareSum / turns.length) : 0;
  s.byTool = toolRows(tools);
  s.lots = [...lotKeys.values()];
  return s;
}

/** Board-wide view: averages per task that ran the native loop, grouped by lot set. */
export interface LoopMetricsAggregate {
  tasks: number;
  turns: number;
  avgTurnsPerTask: number;
  avgToolCallsPerTask: number;
  avgRemindersPerTask: number;
  avgInputTokensPerTask: number;
  avgOutputTokensPerTask: number;
  avgToolContextShare: number;
  toolErrorRate: number;
  byTool: TaskLoopMetrics['byTool'];
  /** Same figures split by lot set ('baseline' = no lot) — the before/after view. */
  byLots: Record<string, Omit<LoopMetricsAggregate, 'byLots' | 'byTool'>>;
}

function aggregateGroup(summaries: TaskLoopMetrics[]): {
  figures: Omit<LoopMetricsAggregate, 'byLots' | 'byTool'>;
  tools: Record<string, ToolAggregate>;
} {
  const tools: Record<string, ToolAggregate> = {};
  let turns = 0;
  let toolCalls = 0;
  let failed = 0;
  let reminders = 0;
  let inTok = 0;
  let outTok = 0;
  let share = 0;
  for (const s of summaries) {
    turns += s.turns;
    toolCalls += s.toolCalls;
    failed += s.failedToolCalls;
    reminders += s.reminders;
    inTok += s.inputTokens;
    outTok += s.outputTokens;
    share += s.avgToolContextShare;
    for (const row of s.byTool) {
      mergeTools(tools, { [row.name]: row });
    }
  }
  const n = summaries.length;
  const avg = (v: number) => (n ? Math.round((v / n) * 10) / 10 : 0);
  const figures = {
    tasks: n,
    turns,
    avgTurnsPerTask: avg(turns),
    avgToolCallsPerTask: avg(toolCalls),
    avgRemindersPerTask: avg(reminders),
    avgInputTokensPerTask: avg(inTok),
    avgOutputTokensPerTask: avg(outTok),
    avgToolContextShare: n ? round3(share / n) : 0,
    toolErrorRate: toolCalls ? round3(failed / toolCalls) : 0,
  };
  return { figures, tools };
}

/** Aggregate the loop metrics of many tasks (tasks without any are skipped). */
export function aggregateLoopMetrics(histories: Iterable<unknown>): LoopMetricsAggregate | null {
  const all: TaskLoopMetrics[] = [];
  const groups = new Map<string, TaskLoopMetrics[]>();
  for (const history of histories) {
    const entries = loopMetricsEntries(history);
    if (entries.length === 0) continue;
    all.push(summarizeLoopMetrics(entries));
    // A task whose turns span several lot sets is split so each group only
    // counts the turns recorded under it.
    const byKey = new Map<string, LoopTurnMetrics[]>();
    for (const e of entries) {
      const key = Array.isArray(e.lots) && e.lots.length ? `lots:${e.lots.join('+')}` : 'baseline';
      const list = byKey.get(key) ?? [];
      list.push(e);
      byKey.set(key, list);
    }
    for (const [key, list] of byKey) {
      const g = groups.get(key) ?? [];
      g.push(summarizeLoopMetrics(list));
      groups.set(key, g);
    }
  }
  if (all.length === 0) return null;
  const { figures, tools } = aggregateGroup(all);
  const byLots: LoopMetricsAggregate['byLots'] = {};
  for (const [key, list] of groups) byLots[key] = aggregateGroup(list).figures;
  return { ...figures, byTool: toolRows(tools), byLots };
}
