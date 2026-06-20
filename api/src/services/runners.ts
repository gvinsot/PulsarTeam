// ─── CLI runner identity: single source of truth ────────────────────────────
//
// The list of CLI (PTY-backed) runners was historically re-declared as a
// stringly-typed Set in several modules and drifted out of sync. This module
// is the canonical definition.
//
// NOTE: 'coder' is a deprecated alias for 'claudecode' (existing agents in the
// DB may still have runner='coder'). It is kept in CLI_RUNNER_IDS so legacy
// rows are still recognised as CLI runners by isCliRunner / the task loop.

export const CLI_RUNNER_IDS = ['claudecode', 'coder', 'codex', 'opencode', 'openclaw', 'hermes', 'aider'] as const;
export type CliRunnerId = typeof CLI_RUNNER_IDS[number];

export const CLI_RUNNERS = new Set<string>(CLI_RUNNER_IDS);

// Runners that drive their own internal tool pipeline and exit when done. The
// task loop auto-signals completion when they finish. This is every CLI runner
// EXCEPT claudecode (and its 'coder' alias), which signals via update_task.
export const SELF_COMPLETING_RUNNERS = new Set<string>(
  CLI_RUNNER_IDS.filter(r => r !== 'claudecode' && r !== 'coder'),
);

export function isCliRunner(agent: any): boolean {
  return CLI_RUNNERS.has(String(agent?.runner || '').toLowerCase());
}
