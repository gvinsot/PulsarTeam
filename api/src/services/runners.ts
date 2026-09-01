// ─── CLI runner identity: single source of truth ────────────────────────────
//
// The list of CLI (PTY-backed) runners was historically re-declared as a
// stringly-typed Set in several modules and drifted out of sync. This module
// is the canonical definition.
//
// NOTE: 'coder' is a deprecated alias for 'claudecode' (existing agents in the
// DB may still have runner='coder'). It is kept in CLI_RUNNER_IDS so legacy
// rows are still recognised as CLI runners by isCliRunner / the task loop.

export const CLI_RUNNER_IDS = [
  'claudecode',
  'coder',
  'codex',
  'opencode',
  'openclaw',
  'hermes',
  'aider',
] as const;
export type CliRunnerId = (typeof CLI_RUNNER_IDS)[number];

export const CLI_RUNNERS = new Set<string>(CLI_RUNNER_IDS);

// Runners that drive their own internal tool pipeline and exit when done. The
// task loop auto-signals completion when they finish. This is every CLI runner
// EXCEPT claudecode (and its 'coder' alias), which signals via update_task.
export const SELF_COMPLETING_RUNNERS = new Set<string>(
  CLI_RUNNER_IDS.filter(r => r !== 'claudecode' && r !== 'coder')
);

export function isCliRunner(agent: any): boolean {
  return CLI_RUNNERS.has(String(agent?.runner || '').toLowerCase());
}

// ─── Agent types (runners offered in the UI) ─────────────────────────────────
//
// The runner ids a user can actually pick when creating or editing an agent.
// This is CLI_RUNNER_IDS minus the deprecated 'coder' alias, plus 'sandbox'
// (the in-process Pulsar runtime, which is not a PTY runner). Admin Settings →
// Agent Types toggles these on and off globally; see `disabledAgentTypes` in
// configManager.
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

export const AGENT_TYPE_LABELS: Record<AgentTypeId, string> = {
  sandbox: 'Pulsar Sandbox',
  claudecode: 'Claude Code CLI',
  opencode: 'Opencode CLI',
  hermes: 'Hermes CLI',
  openclaw: 'OpenClaw CLI',
  codex: 'OpenAI Codex CLI',
  aider: 'Aider CLI',
};

/**
 * Fold a stored runner value onto the agent-type id it is toggled by, so an
 * agent still carrying the legacy 'coder' alias is governed by the Claude Code
 * switch. Returns '' for an empty/unknown runner ("Auto"), which no toggle
 * covers.
 */
export function normalizeAgentType(runner: unknown): AgentTypeId | '' {
  const id = String(runner || '').toLowerCase();
  const mapped = id === 'coder' ? 'claudecode' : id;
  return (AGENT_TYPE_IDS as readonly string[]).includes(mapped) ? (mapped as AgentTypeId) : '';
}
