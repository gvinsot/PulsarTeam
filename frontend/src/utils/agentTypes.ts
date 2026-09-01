import type { AgentRunner, Settings } from '../types';

// ─── Agent types (runners offered in the UI) ─────────────────────────────────
//
// Mirrors AGENT_TYPE_IDS / AGENT_TYPE_LABELS in api/src/services/runners.ts —
// keep the two lists in sync. The deprecated 'coder' alias is deliberately not
// offered; it folds onto 'claudecode' in normalizeAgentType below so a legacy
// agent is governed by the Claude Code switch.

export const AGENT_TYPE_IDS = [
  'sandbox',
  'claudecode',
  'opencode',
  'hermes',
  'openclaw',
  'codex',
  'aider',
] as const;
export type AgentTypeId = (typeof AGENT_TYPE_IDS)[number];

/** Admin-facing names, as they read in Admin Settings → Agent Types. */
export const AGENT_TYPE_LABELS: Record<AgentTypeId, string> = {
  sandbox: 'Pulsar Sandbox',
  claudecode: 'Claude Code CLI',
  opencode: 'Opencode CLI',
  hermes: 'Hermes CLI',
  openclaw: 'OpenClaw CLI',
  codex: 'OpenAI Codex CLI',
  aider: 'Aider CLI',
};

/** One-liners shown under each toggle. */
export const AGENT_TYPE_DESCRIPTIONS: Record<AgentTypeId, string> = {
  sandbox: 'In-process Pulsar runtime — runs any configured LLM with Pulsar’s own tool loop.',
  claudecode: 'Anthropic Claude Code CLI, driven through a PTY to keep subscription pricing.',
  opencode: 'OpenCode CLI — multi-provider, model switchable inside the terminal.',
  hermes: 'Hermes CLI — multi-provider, config persisted per agent.',
  openclaw: 'OpenClaw CLI — multi-provider.',
  codex: 'OpenAI Codex CLI, model chosen in the terminal via the ChatGPT plan login.',
  aider: 'Aider CLI — multi-provider pair-programming runner.',
};

/** The runner <select> labels, which name the agent rather than the CLI. */
export const AGENT_TYPE_OPTION_LABELS: Record<AgentTypeId, string> = {
  sandbox: 'Pulsar Agent (sandbox)',
  claudecode: 'Claude Code Agent',
  openclaw: 'OpenClaw Agent',
  hermes: 'Hermes Agent',
  opencode: 'OpenCode Agent',
  aider: 'Aider Agent',
  codex: 'OpenAI Codex Agent',
};

/** The order the runner <select> lists its options in. */
export const AGENT_TYPE_SELECT_ORDER: readonly AgentTypeId[] = [
  'sandbox',
  'claudecode',
  'openclaw',
  'hermes',
  'opencode',
  'aider',
  'codex',
];

/**
 * Fold a runner value onto the agent-type id it is toggled by. '' for an
 * empty/unknown runner (the "Auto" option), which no toggle covers.
 */
export function normalizeAgentType(
  runner: AgentRunner | string | null | undefined
): AgentTypeId | '' {
  const id = String(runner || '').toLowerCase();
  const mapped = id === 'coder' ? 'claudecode' : id;
  return (AGENT_TYPE_IDS as readonly string[]).includes(mapped) ? (mapped as AgentTypeId) : '';
}

/** Parse the `disabledAgentTypes` settings CSV into the switched-off set. */
export function parseDisabledAgentTypes(raw: string | undefined): Set<AgentTypeId> {
  const disabled = new Set<AgentTypeId>();
  for (const part of String(raw || '').split(',')) {
    const id = normalizeAgentType(part.trim());
    if (id) disabled.add(id);
  }
  return disabled;
}

/** Serialise back to the stored CSV form, in AGENT_TYPE_IDS order. */
export function serializeDisabledAgentTypes(disabled: Iterable<AgentTypeId>): string {
  const set = new Set(disabled);
  return AGENT_TYPE_IDS.filter(id => set.has(id)).join(',');
}

export function disabledAgentTypesOf(settings: Settings | null): Set<AgentTypeId> {
  return parseDisabledAgentTypes(settings?.disabledAgentTypes);
}
