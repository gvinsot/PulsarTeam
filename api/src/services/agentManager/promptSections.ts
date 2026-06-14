// ─── Shared prompt-section builders ───────────────────────────────────────────
//
// Pure helpers shared by _buildSystemPrompt (chat text-tool protocol) and
// buildRunnerInstructions (CLI runner, no @-syntax). Only the sections that were
// verbatim/near-verbatim duplicates live here; each caller keeps its own
// protocol-specific wording, guard asymmetries, ranking, and side effects
// (URL-doc refresh, plugin MCP-id collection). See the call sites for the
// deliberate per-surface differences these helpers must NOT erase.

export const RECENT_TASKS_LIMIT = 3;
export const TASK_TEXT_MAX_CHARS = 300;

/** Recency comparator (newest first) over updatedAt → createdAt → 0. */
export function byRecency(a: any, b: any): number {
  const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
  return tb - ta;
}

/** The available-agents roster lines (status / project / current-task tags).
 * Byte-identical mapping shared by both prompt surfaces; callers decide whether
 * to render it (leader gating differs) and what header to wrap it in. */
export function agentRosterLines(agents: any[], excludeId: string): string[] {
  return agents
    .filter((a: any) => a.id !== excludeId && a.enabled !== false)
    .map((a: any) => {
      const statusTag = ` [${a.status}]`;
      const projectTag = a.project ? ` [project: ${a.project}]` : ' [no project]';
      const taskInfo = a.currentTask ? ` (working on: "${a.currentTask.slice(0, 60)}${a.currentTask.length > 60 ? '...' : ''}")` : '';
      return `- ${a.name} (${a.role})${statusTag}${projectTag}${taskInfo}: ${a.description || 'No description'}`;
    });
}

/** Reference Documents (RAG) block. `requireUrl` selects the label rule:
 *  - false (chat): a url-doc renders `name (source: url)` even when url is unset
 *    → `name (source: undefined)`.
 *  - true  (runner): only renders the source suffix when url is present.
 * Returns '' when there are no docs. */
export function ragDocsSection(docs: any[], requireUrl: boolean): string {
  if (!Array.isArray(docs) || docs.length === 0) return '';
  let out = '\n\n--- Reference Documents ---\n';
  for (const doc of docs) {
    const isUrl = requireUrl ? (doc.type === 'url' && doc.url) : doc.type === 'url';
    const label = isUrl ? `${doc.name} (source: ${doc.url})` : doc.name;
    out += `\n[${label}]:\n${doc.content}\n`;
  }
  return out;
}

/** Active Plugins block from already-resolved plugins. MCP-id collection (chat
 * only) stays in the caller — this renders just the human-readable guidance.
 * Returns '' when there are no resolved plugins. */
export function pluginsSection(resolvedPlugins: any[]): string {
  if (!Array.isArray(resolvedPlugins) || resolvedPlugins.length === 0) return '';
  let out = '\n\n--- Active Plugins ---\n';
  for (const plugin of resolvedPlugins) {
    out += `\n[${(plugin as any).name}]:\n${(plugin as any).instructions}\n`;
  }
  return out;
}

/** Agent Credentials block. Returns '' when there are none. */
export function credentialsSection(credentials: Record<string, string>): string {
  const keys = Object.keys(credentials || {});
  if (keys.length === 0) return '';
  let out = '\n\n--- Agent Credentials ---\n';
  out += 'These credentials are available for use with plugins and external services.\n';
  for (const key of keys) {
    out += `- ${key}: ${credentials[key]}\n`;
  }
  return out;
}

/** Relevant Tasks block from already-ranked tasks. Ranking stays caller-side
 * (chat does semantic+recency, runner does recency-only). `overflowHint(n)`
 * builds the surface-specific "see all" instruction for n omitted tasks.
 * Returns '' when no ranked tasks. */
export function relevantTasksSection(
  rankedTasks: any[],
  totalActive: number,
  isActive: (status: string) => boolean,
  overflowHint: (overflow: number) => string,
): string {
  if (!Array.isArray(rankedTasks) || rankedTasks.length === 0) return '';
  let out = `\n\n--- Relevant Tasks (${rankedTasks.length} of ${totalActive}) ---\n`;
  for (const task of rankedTasks) {
    const mark = isActive(task.status) ? '~' : '!';
    const text = String(task.text || '');
    const truncated = text.length > TASK_TEXT_MAX_CHARS
      ? text.slice(0, TASK_TEXT_MAX_CHARS).trimEnd() + '…'
      : text;
    out += `- [${mark}] (${task.id.slice(0, 8)}) ${truncated}\n`;
  }
  const overflow = totalActive - rankedTasks.length;
  if (overflow > 0) {
    out += overflowHint(overflow);
  }
  return out;
}
