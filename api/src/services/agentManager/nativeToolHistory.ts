/** A bounded turn is resumable, never a successful workflow decision. */
export class ToolBudgetReachedError extends Error {
  constructor() {
    super('Tool limit reached; work remains incomplete. Resume from the saved tool results.');
    this.name = 'ToolBudgetReachedError';
  }
}

export const TOOL_BUDGET_NOTICE =
  '\n\n⚠️ Limite atteinte — travail à poursuivre. Les résultats des outils sont conservés pour la reprise.\n\n';

/** Context assumed when the LLM config leaves contextLength unset (0). */
export const DEFAULT_CONTEXT_TOKENS = 131072;

/** Per-result ceiling, in chars (~3 chars/token, the estimate compaction uses):
 * one result may take ~12% of the window, and one round's results together
 * ~40%. An unbounded result (a 500k-char log dump) otherwise fills the window,
 * leaving the model no output budget, and the request fails upstream. */
export function toolResultMaxChars(contextTokens: number, resultsInRound = 1): number {
  const ctx = contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS;
  const perResult = Math.floor(ctx * 0.12 * 3);
  const perRoundShare = Math.floor((ctx * 0.4 * 3) / Math.max(1, resultsInRound));
  return Math.max(4000, Math.min(perResult, perRoundShare));
}

/** Keep the head and tail of an oversized tool result, with a notice the model
 * can act on (narrow the request) instead of silently losing the output. */
export function capToolResultContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const notice =
    `\n\n... [tool output truncated: ${content.length} chars, only the beginning and the end are shown. ` +
    'Narrow the request (filters, line ranges, limits, size) to see the rest.] ...\n\n';
  const budget = Math.max(0, maxChars - notice.length);
  const head = Math.ceil(budget * 0.7);
  const tail = budget - head;
  return content.slice(0, head) + notice + (tail > 0 ? content.slice(-tail) : '');
}

/** The role:'tool' message body for one result, bounded to maxChars. */
export function toolResultContent(
  result: { success?: boolean; result?: unknown; error?: unknown } | undefined,
  maxChars: number
): string {
  const success = Boolean(result?.success);
  return capToolResultContent(
    JSON.stringify({
      success,
      result: result?.result ?? null,
      error: success ? null : result?.error || 'Tool execution failed.',
    }),
    maxChars
  );
}

interface HistoryMessage {
  role: string;
  content?: string;
  nativeToolTrace?: Array<{
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
    result?: { success?: boolean; result?: unknown; error?: unknown };
  }>;
  [key: string]: unknown;
}

interface WorkflowScope {
  taskId?: string;
  mode?: string;
  currentStatus?: string;
}

/** Expand the durable trace into complete call/result pairs for the provider.
 * Return fresh messages: context truncation must never mutate stored history.
 * Calls are context only; replaying them does not execute them again. */
export function replayNativeToolHistory(
  messages: HistoryMessage[],
  contextTokens: number = DEFAULT_CONTEXT_TOKENS
): HistoryMessage[] {
  return messages.flatMap(message => {
    const { nativeToolTrace, ...copy } = message;
    if (message.role !== 'assistant' || !Array.isArray(nativeToolTrace)) return [copy];
    const replay: HistoryMessage[] = [];
    const maxChars = toolResultMaxChars(contextTokens, nativeToolTrace.length);
    for (const trace of nativeToolTrace) {
      if (!trace?.id || !trace?.name || !trace.result) continue;
      replay.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: trace.id, name: trace.name, arguments: trace.arguments || {} }],
      });
      replay.push({
        role: 'tool',
        toolCallId: trace.id,
        toolError: !trace.result.success,
        content: toolResultContent(trace.result, maxChars),
      });
    }
    replay.push(copy);
    return replay;
  });
}

/** Only resume an interrupted action with the same task, mode and column.
 * Include its earlier interrupted turns so successive retries retain progress. */
export function interruptedWorkflowHistory(
  history: HistoryMessage[],
  meta: WorkflowScope
): HistoryMessage[] {
  const matches = (m: HistoryMessage) =>
    m.taskId === meta.taskId &&
    m.workflowMode === meta.mode &&
    m.workflowStatus === meta.currentStatus;
  let last = history.length - 1;
  while (last >= 0 && !(history[last].role === 'assistant' && matches(history[last]))) last--;
  if (last < 0 || history[last].interruption !== 'tool-budget') return [];
  const resumed: HistoryMessage[] = [];
  for (let i = last; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant' || !matches(m)) continue;
    if (m.interruption !== 'tool-budget') break;
    resumed.unshift(m);
  }
  return resumed;
}
