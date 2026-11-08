// ── Options of the agent switcher in the AgentDetail header ──────────────────
//
// The switcher lists enabled agents. The agent being displayed must always be
// among the options, even when it is disabled or not in `agents`: a <select>
// whose value matches no option silently renders the first option, which made
// the header show another agent's name (e.g. "QWEN" while viewing "Jarvis").

type SwitchableAgent = { id: string; enabled?: boolean };

/** Enabled agents, plus `current` if it would otherwise be missing. */
export function agentSwitcherOptions<T extends SwitchableAgent>(agents: T[], current: T): T[] {
  const options = agents.filter(a => a.enabled !== false || a.id === current.id);
  return options.some(a => a.id === current.id) ? options : [current, ...options];
}
