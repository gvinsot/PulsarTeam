/** A bounded turn is resumable, never a successful workflow decision. */
export class ToolBudgetReachedError extends Error {
  constructor() {
    super('Tool limit reached; work remains incomplete. Resume from the saved tool results.');
    this.name = 'ToolBudgetReachedError';
  }
}

export const TOOL_BUDGET_NOTICE =
  '\n\n⚠️ Limite atteinte — travail à poursuivre. Les résultats des outils sont conservés pour la reprise.\n\n';

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
export function replayNativeToolHistory(messages: HistoryMessage[]): HistoryMessage[] {
  return messages.flatMap(message => {
    const { nativeToolTrace, ...copy } = message;
    if (message.role !== 'assistant' || !Array.isArray(nativeToolTrace)) return [copy];
    const replay: HistoryMessage[] = [];
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
        content: JSON.stringify({
          success: Boolean(trace.result.success),
          result: trace.result.result ?? null,
          error: trace.result.success ? null : trace.result.error || 'Tool execution failed.',
        }),
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
