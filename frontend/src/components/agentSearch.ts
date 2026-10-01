// ── Text search of the Agents view ──────────────────────────────────────────
//
// Matches a free-text query against an agent's name, role, description and
// current task. The query is split on whitespace and every term must match
// (AND), each term in any field. Matching ignores case and diacritics, so
// "deve" finds "Développeur". An empty/blank query keeps every agent.
import type { Agent } from '../types';

type SearchableAgent = Pick<Agent, 'name' | 'role' | 'description' | 'currentTask'>;

/** Lowercase and strip diacritics so comparisons are accent-insensitive. */
export function normalizeSearchText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function filterAgents<T extends SearchableAgent>(agents: T[], query: string): T[] {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return agents;
  return agents.filter(a => {
    const haystack = normalizeSearchText(
      [a.name, a.role, a.description, a.currentTask].filter(Boolean).join('\n')
    );
    return terms.every(t => haystack.includes(t));
  });
}
