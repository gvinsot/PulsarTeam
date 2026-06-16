// ─── ExecutionManager: unified facade routing agents to runner-service ──────
//
// All execution backends (claude-code, openclaw, hermes, opencode, sandbox)
// are now served by the same generic runner-service, configured per
// deployment via RUNNER_TYPE. ExecutionManager keeps one HTTP client per
// backend hostname and routes per-agent calls based on a resolver function
// (typically inspecting agent.runner or llmConfig.managesContext).

import { RunnerExecutionProvider } from './runnerExecutionProvider.js';
import { ExecutionProvider, GitCredentials } from './executionProvider.js';
import { readSecret } from '../../secrets.js';
import { RUNNER_SERVICES, runnerServiceUrl, type RunnerServiceType } from './runnerRegistry.js';

// Canonical provider types — the runner-service registry is the single source
// of truth. 'coder' is accepted as a deprecated alias for 'claudecode'
// (existing agents in the DB may still have runner='coder').
type ProviderType = RunnerServiceType;
type ProviderTypeInput = ProviderType | 'coder';

const PROVIDER_TYPES = Object.keys(RUNNER_SERVICES) as ProviderType[];

function _normalizeProviderType(t: ProviderTypeInput | string | undefined | null): ProviderType {
  if (t === 'coder') return 'claudecode';
  return (PROVIDER_TYPES as readonly string[]).includes(t as string) ? (t as ProviderType) : 'sandbox';
}

interface RunnerOpts { baseUrl?: string; apiKey?: string }

interface ExecutionManagerOptions {
  resolveProvider?: (agentId: string) => ProviderTypeInput;
  claudecodeOptions?: RunnerOpts;
  /** @deprecated use claudecodeOptions */
  coderOptions?: RunnerOpts;
  sandboxOptions?: RunnerOpts;
  openclawOptions?: RunnerOpts;
  hermesOptions?: RunnerOpts;
  opencodeOptions?: RunnerOpts;
  aiderOptions?: RunnerOpts;
  codexOptions?: RunnerOpts;
}

interface BindAgentMeta {
  ownerId?: string;
  gitCredentials?: GitCredentials | null;
  permissions?: any | null;
  llmConfig?: any | null;
}

export class ExecutionManager {
  private providers: Map<ProviderType, RunnerExecutionProvider> = new Map();
  _resolveProvider: (agentId: string) => ProviderTypeInput;
  _agentProviders: Map<string, ProviderType>;

  constructor(options: ExecutionManagerOptions = {}) {
    const sharedKey = readSecret('CODER_API_KEY');
    const make = (type: ProviderType, opts?: RunnerOpts) => new RunnerExecutionProvider({
      // runnerServiceUrl already carries the legacy CODER_SERVICE_URL fallback
      // for the claudecode runner.
      baseUrl: opts?.baseUrl || runnerServiceUrl(type),
      apiKey: opts?.apiKey || sharedKey,
    });

    const perTypeOpts: Partial<Record<ProviderType, RunnerOpts | undefined>> = {
      claudecode: options.claudecodeOptions || options.coderOptions,
      sandbox: options.sandboxOptions,
      openclaw: options.openclawOptions,
      hermes: options.hermesOptions,
      opencode: options.opencodeOptions,
      aider: options.aiderOptions,
      codex: options.codexOptions,
    };
    for (const type of PROVIDER_TYPES) {
      this.providers.set(type, make(type, perTypeOpts[type]));
    }

    this._resolveProvider = options.resolveProvider || (() => 'sandbox');
    this._agentProviders = new Map();
  }

  /** @deprecated alias kept for legacy callers — use the claudecode provider */
  get coder(): RunnerExecutionProvider {
    return this._getProvider('claudecode');
  }

  // ── Provider resolution ───────────────────────────────────────────────

  _providerFor(agentId: string): ExecutionProvider {
    const bound = this._agentProviders.get(agentId);
    if (bound) {
      return this._getProvider(bound);
    }
    const choice = _normalizeProviderType(this._resolveProvider(agentId));
    this._agentProviders.set(agentId, choice);
    return this._getProvider(choice);
  }

  _getProvider(type: ProviderType): RunnerExecutionProvider {
    // Fall back to the sandbox provider for any value not in the map (matches
    // the previous switch's `default: return this.sandbox`). Unreachable today
    // since every caller passes a normalized value, but kept as a defensive arm.
    return this.providers.get(type) ?? this.providers.get('sandbox')!;
  }

  /**
   * Explicitly bind an agent to a specific provider.
   */
  bindAgent(agentId: string, providerType: ProviderTypeInput, meta: BindAgentMeta = {}): void {
    const normalized = _normalizeProviderType(providerType);
    const previous = this._agentProviders.get(agentId);
    if (previous && previous !== normalized) {
      console.log(`🔄 [Execution] Agent ${agentId.slice(0, 8)} switching provider: ${previous} → ${normalized}`);
      this._getProvider(previous).destroySandbox(agentId).catch(() => {});
    }
    this._agentProviders.set(agentId, normalized);
    if (meta.ownerId) {
      this._getProvider(normalized).setOwner(agentId, meta.ownerId);
    }
    if (meta.gitCredentials !== undefined) {
      this._getProvider(normalized).setGitCredentials(agentId, meta.gitCredentials);
    }
    if (meta.permissions !== undefined) {
      this._getProvider(normalized).setPermissions(agentId, meta.permissions);
    }
    if (meta.llmConfig !== undefined) {
      this._getProvider(normalized).setLlmConfig(agentId, meta.llmConfig);
    }
  }

  /** Update (or clear) the per-agent resolved LLM config forwarded to the runner. */
  setLlmConfig(agentId: string, llmConfig: any | null): void {
    this._providerFor(agentId).setLlmConfig(agentId, llmConfig);
  }

  /** Set (or clear) the agent's task-scoped secondary repos, cloned alongside the primary. */
  setSecondaryRepos(agentId: string, repos: Array<{ provider?: string; fullName: string }> | null): void {
    this._providerFor(agentId).setSecondaryRepos(agentId, repos);
  }

  getProviderType(agentId: string): ProviderType | undefined {
    return this._agentProviders.get(agentId);
  }

  // ── ExecutionProvider interface (delegated) ───────────────────────────

  /**
   * Update (or clear) the GitHub/git credentials associated with an agent.
   * Forwarded to the runner-service on the next ensureProject/switchProject
   * call so the agent container can clone/push via authenticated HTTPS.
   */
  setGitCredentials(agentId: string, creds: GitCredentials | null): void {
    this._providerFor(agentId).setGitCredentials(agentId, creds);
  }

  /**
   * Push the agent's git plugin credentials to the runner without cloning a
   * project. See ExecutionProvider.installGitCredentials for the rationale —
   * this is the public delegate so chat/terminal entry points can call it
   * during agent binding.
   */
  async installGitCredentials(agentId: string, creds: GitCredentials | null = null): Promise<void> {
    return this._providerFor(agentId).installGitCredentials(agentId, creds);
  }

  async ensureProject(
    agentId: string,
    project: string | null = null,
    gitUrl: string | null = null,
    gitCredentials: GitCredentials | null = null,
  ): Promise<void> {
    return this._providerFor(agentId).ensureProject(agentId, project, gitUrl, gitCredentials);
  }

  async switchProject(
    agentId: string,
    newProject: string,
    gitUrl: string | null = null,
    gitCredentials: GitCredentials | null = null,
  ): Promise<void> {
    return this._providerFor(agentId).switchProject(agentId, newProject, gitUrl, gitCredentials);
  }

  async destroySandbox(agentId: string): Promise<void> {
    const provider = this._providerFor(agentId);
    await provider.destroySandbox(agentId);
    this._agentProviders.delete(agentId);
  }

  async destroyAll(): Promise<void> {
    await Promise.all(
      [...this.providers.values()].map(provider => provider.destroyAll())
    );
    this._agentProviders.clear();
  }

  async closeTerminalSession(agentId: string): Promise<boolean> {
    return this._providerFor(agentId).closeTerminalSession(agentId);
  }

  /**
   * Close the shared PTY for this agent on every terminal-capable CLI runner.
   *
   * Context reloads can happen before an agent has been bound in this API
   * process, or after the agent's runner was changed in settings. In those
   * cases _providerFor(agentId) may point at the wrong service, leaving the
   * old CLI process alive with stale context. Fan out across all CLI runners
   * so the next terminal attach always starts fresh.
   */
  async closeCliTerminalSessions(agentId: string): Promise<boolean> {
    // Every runner except 'sandbox' is a terminal-capable CLI runner.
    const providers = PROVIDER_TYPES
      .filter(type => type !== 'sandbox')
      .map(type => this._getProvider(type));
    const results = await Promise.allSettled(
      providers.map(provider => provider.closeTerminalSession(agentId))
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) return true;
    }
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (firstError) {
      console.warn(`⚠️ [Execution] closeCliTerminalSessions failed for ${agentId.slice(0, 8)}: ${firstError.reason?.message || firstError.reason}`);
    }
    return false;
  }

  async sendTerminalInput(agentId: string, input: string, options: { submit?: boolean } = {}): Promise<boolean> {
    return this._providerFor(agentId).sendTerminalInput(agentId, input, options);
  }

  /** Fetch the runner-side PTY session status (incl. `auth_error`) or null. */
  async getTerminalSession(agentId: string): Promise<any | null> {
    return this._providerFor(agentId).getTerminalSession(agentId);
  }

  hasEnvironment(agentId: string): boolean {
    return this._providerFor(agentId).hasEnvironment(agentId);
  }

  getProject(agentId: string): string | null {
    return this._providerFor(agentId).getProject(agentId);
  }

  getFileTree(agentId: string): string | null {
    return this._providerFor(agentId).getFileTree(agentId);
  }

  async refreshFileTree(agentId: string): Promise<void> {
    return this._providerFor(agentId).refreshFileTree(agentId);
  }

  async readFile(agentId: string, filePath: string): Promise<string> {
    return this._providerFor(agentId).readFile(agentId, filePath);
  }

  async writeFile(agentId: string, filePath: string, content: string): Promise<any> {
    return this._providerFor(agentId).writeFile(agentId, filePath, content);
  }

  async appendFile(agentId: string, filePath: string, content: string): Promise<any> {
    return this._providerFor(agentId).appendFile(agentId, filePath, content);
  }

  async listDir(agentId: string, dirPath: string): Promise<string> {
    return this._providerFor(agentId).listDir(agentId, dirPath);
  }

  async searchFiles(agentId: string, pattern: string, query: string): Promise<string> {
    return this._providerFor(agentId).searchFiles(agentId, pattern, query);
  }

  async exec(agentId: string, command: string, options: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    return this._providerFor(agentId).exec(agentId, command, options);
  }

  // ── Backward compatibility aliases ────────────────────────────────────

  /** @deprecated Use ensureProject() */
  async ensureSandbox(agentId: string, project: string | null = null, gitUrl: string | null = null): Promise<void> {
    return this.ensureProject(agentId, project, gitUrl);
  }

  /** @deprecated Use hasEnvironment() */
  hasSandbox(agentId: string): boolean {
    return this.hasEnvironment(agentId);
  }

  /** @deprecated Use getProject() */
  getSandboxProject(agentId: string): string | null {
    return this.getProject(agentId);
  }

  /**
   * @deprecated The new sandbox is a regular runner-service container managed by
   * Docker Compose / Swarm — there are no orphan docker-exec users to clean up.
   * Kept as a no-op so callers (e.g. index.ts) don't break.
   */
  async cleanupOrphans(): Promise<void> {
    // no-op
  }
}
