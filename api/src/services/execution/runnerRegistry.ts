// ─── Runner-service registry ────────────────────────────────────────────────
//
// Single source of truth mapping each runner-service type to its env-var
// override and default Swarm DNS URL. Both ExecutionManager (HTTP execution
// providers) and llmProviders.createProvider (LLM chat routed through a CLI
// runner) read from this table so adding a new runner service is a one-line
// change instead of editing several parallel lists.

export const RUNNER_SERVICES = {
  claudecode: { envVar: 'CLAUDECODE_SERVICE_URL', defaultUrl: 'http://claudecode-service:8000' },
  sandbox: { envVar: 'SANDBOX_SERVICE_URL', defaultUrl: 'http://sandbox-service:8000' },
  openclaw: { envVar: 'OPENCLAW_SERVICE_URL', defaultUrl: 'http://openclaw-service:8000' },
  hermes: { envVar: 'HERMES_SERVICE_URL', defaultUrl: 'http://hermes-service:8000' },
  opencode: { envVar: 'OPENCODE_SERVICE_URL', defaultUrl: 'http://opencode-service:8000' },
  aider: { envVar: 'AIDER_SERVICE_URL', defaultUrl: 'http://aider-service:8000' },
  codex: { envVar: 'CODEX_SERVICE_URL', defaultUrl: 'http://codex-service:8000' },
} as const;

export type RunnerServiceType = keyof typeof RUNNER_SERVICES;

/**
 * Resolve the base URL for a runner service. Reads process.env at call time
 * (NOT at module load) so the env-read timing matches the previous inline
 * `process.env.X_SERVICE_URL || 'http://x-service:8000'` expressions.
 *
 * Backward-compat: the claudecode runner additionally falls back to the legacy
 * CODER_SERVICE_URL env var (it used to be the only coder backend) before the
 * hard-coded default.
 */
export function runnerServiceUrl(type: RunnerServiceType): string {
  const entry = RUNNER_SERVICES[type];
  return process.env[entry.envVar]
    || (type === 'claudecode' ? process.env.CODER_SERVICE_URL : undefined)
    || entry.defaultUrl;
}
