// ── Ordering of the Agents view ─────────────────────────────────────────────
//
// 'default'  keeps the incoming order (Dashboard already puts Swarm Leaders first).
// 'activity' puts the most recently active agents first: agents working right
//            now (busy or streaming a thought) rank above everything, then by
//            metrics.lastActiveAt descending; never-active agents go last.
// 'name'     sorts alphabetically, case-insensitive.
//
// Sorting is stable, so ties keep the default order.
import type { Agent } from '../types';

export type AgentSortMode = 'default' | 'activity' | 'name';

type SortableAgent = Pick<Agent, 'id' | 'name' | 'status'> & {
  metrics?: { lastActiveAt?: string | null } | null;
};

/** Timestamp (ms) used to rank an agent by recency; -Infinity when never active. */
export function lastActivityTime(agent: SortableAgent, thinking?: string): number {
  if (agent.status === 'busy' || thinking) return Number.POSITIVE_INFINITY;
  const iso = agent.metrics?.lastActiveAt;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

export function sortAgents<T extends SortableAgent>(
  agents: T[],
  mode: AgentSortMode,
  thinkingMap: Record<string, string> = {}
): T[] {
  if (mode === 'default') return agents;
  const copy = [...agents];
  if (mode === 'name') {
    copy.sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );
  } else {
    const times = new Map(copy.map(a => [a.id, lastActivityTime(a, thinkingMap[a.id])]));
    copy.sort((a, b) => {
      const ta = times.get(a.id)!;
      const tb = times.get(b.id)!;
      return ta === tb ? 0 : tb > ta ? 1 : -1;
    });
  }
  return copy;
}
