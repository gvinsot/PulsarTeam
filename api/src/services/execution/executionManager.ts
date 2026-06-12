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

// Canonical provider types.
type ProviderType = 'claudecode' | 'sandbox' | 'openclaw' | 'hermes' | 'opencode' | 'aider' | 'codex';

function _normalizeProviderType(t: string | undefined | null): ProviderType {
  if (t === 'claudecode' || t === 'sandbox' || t === 'openclaw' || t === 'hermes' || t === 'opencode' || t === 'aider' || t === 'codex') return t;
  return 'sandbox';
}

interface RunnerOpts { baseUrl?: string; apiKey?: string }

interface ExecutionManagerOptions {
  resolveProvider?: (agentId: string) => string;
  claudecodeOptions?: RunnerOpts;
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

const DEFAULT_URLS: Record<ProviderType, string> = {
  claudecode: 'http://claudecode-service:8000',
  sandbox: 'http://sandbox-service:8000',
  openclaw: 'http://openclaw-service:8000',
  hermes: 'http://hermes-service:8000',
  opencode: 'http://opencode-service:8000',
  aider: 'http://aider-service:8000',
  codex: 'http://codex-service:8000',
};

const URL_ENV_VARS: Record<ProviderType, string> = {
  claudecode: 'CLAUDECODE_SERVICE_URL',
  sandbox: 'SANDBOX_SERVICE_URL',
  openclaw: 'OPENCLAW_SERVICE_URL',
  hermes: 'HERMES_SERVICE_URL',
  opencode: 'OPENCODE_SERVICE_URL',
  aider: 'AIDER_SERVICE_URL',
  codex: 'CODEX_SERVICE_URL',
};

export class ExecutionManager {
  claudecode: RunnerExecutionProvider;
  sandbox: RunnerExecutionProvider;
  openclaw: RunnerExecutionProvider;
  hermes: RunnerExecutionProvider;
  opencode: RunnerExecutionProvider;
  aider: RunnerExecutionProvider;
  codex: RunnerExecutionProvider;
  _resolveProvider: (agentId: string) => string;
  _agentProviders: Map<string, ProviderType>;

  constructor(options: ExecutionManagerOptions = {}) {
    const sharedKey = readSecret('CODER_API_KEY');
    const make = (type: ProviderType, opts?: RunnerOpts) => new RunnerExecutionProvider({
      baseUrl: opts?.baseUrl || process.env[URL_ENV_VARS[type]] || DEFAULT_URLS[type],
      apiKey: opts?.apiKey || sharedKey,
    });

    this.claudecode = make('claudecode', options.claudecodeOptions);
    this.sandbox = make('sandbox', options.sandboxOptions);
    this.openclaw = make('openclaw', options.openclawOptions);
    this.hermes = make('hermes', options.hermesOptions);
    this.opencode = make('opencode', options.opencodeOptions);
    this.aider = make('aider', options.aiderOptions);
    this.codex = make('codex', options.codexOptions);

    this._resolveProvider = options.resolveProvider || (() => 'sandbox');
    this._agentProviders = new Map();
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
    switch (type) {
      case 'claudecode': return this.claudecode;
      case 'openclaw': return this.openclaw;
      case 'hermes': return this.hermes;
      case 'opencode': return this.opencode;
      case 'aider': return this.aider;
      case 'codex': return this.codex;
      default: return this.sandbox;
    }
  }

  /**
   * Explicitly bind an agent to a specific provider.
   */
  bindAgent(agentId: string, providerType: string, meta: BindAgentMeta = {}): void {
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
    await Promise.all([
      this.claudecode.destroyAll(),
      this.sandbox.destroyAll(),
      this.openclaw.destroyAll(),
      this.hermes.destroyAll(),
      this.opencode.destroyAll(),
      this.aider.destroyAll(),
      this.codex.destroyAll(),
    ]);
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
    const providers = [
      this.claudecode,
      this.codex,
      this.opencode,
      this.aider,
      this.openclaw,
      this.hermes,
    ];
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
}
