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

// Canonical provider types. 'coder' is accepted as a deprecated alias for
// 'claudecode' (existing agents in the DB may still have runner='coder').
type ProviderType = 'claudecode' | 'sandbox' | 'openclaw' | 'hermes' | 'opencode' | 'codex';
type ProviderTypeInput = ProviderType | 'coder';

function _normalizeProviderType(t: ProviderTypeInput | string | undefined | null): ProviderType {
  if (t === 'coder') return 'claudecode';
  if (t === 'claudecode' || t === 'sandbox' || t === 'openclaw' || t === 'hermes' || t === 'opencode' || t === 'codex') return t;
  return 'sandbox';
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
  codex: 'http://codex-service:8000',
};

const URL_ENV_VARS: Record<ProviderType, string> = {
  claudecode: 'CLAUDECODE_SERVICE_URL',
  sandbox: 'SANDBOX_SERVICE_URL',
  openclaw: 'OPENCLAW_SERVICE_URL',
  hermes: 'HERMES_SERVICE_URL',
  opencode: 'OPENCODE_SERVICE_URL',
  codex: 'CODEX_SERVICE_URL',
};

export class ExecutionManager {
  claudecode: RunnerExecutionProvider;
  sandbox: RunnerExecutionProvider;
  openclaw: RunnerExecutionProvider;
  hermes: RunnerExecutionProvider;
  opencode: RunnerExecutionProvider;
  codex: RunnerExecutionProvider;
  _resolveProvider: (agentId: string) => ProviderTypeInput;
  _agentProviders: Map<string, ProviderType>;

  constructor(options: ExecutionManagerOptions = {}) {
    const sharedKey = readSecret('CODER_API_KEY');
    const make = (type: ProviderType, opts?: RunnerOpts) => new RunnerExecutionProvider({
      // Backward-compat: fall back to legacy CODER_SERVICE_URL for the claudecode runner.
      baseUrl: opts?.baseUrl
        || process.env[URL_ENV_VARS[type]]
        || (type === 'claudecode' ? process.env.CODER_SERVICE_URL : undefined)
        || DEFAULT_URLS[type],
      apiKey: opts?.apiKey || sharedKey,
    });

    this.claudecode = make('claudecode', options.claudecodeOptions || options.coderOptions);
    this.sandbox = make('sandbox', options.sandboxOptions);
    this.openclaw = make('openclaw', options.openclawOptions);
    this.hermes = make('hermes', options.hermesOptions);
    this.opencode = make('opencode', options.opencodeOptions);
    this.codex = make('codex', options.codexOptions);

    this._resolveProvider = options.resolveProvider || (() => 'sandbox');
    this._agentProviders = new Map();
  }

  /** @deprecated alias kept for legacy callers — use `claudecode` */
  get coder(): RunnerExecutionProvider {
    return this.claudecode;
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
      case 'codex': return this.codex;
      default: return this.sandbox;
    }
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
      this.codex.destroyAll(),
    ]);
    this._agentProviders.clear();
  }

  async closeTerminalSession(agentId: string): Promise<boolean> {
    return this._providerFor(agentId).closeTerminalSession(agentId);
  }

  async sendTerminalInput(agentId: string, input: string, options: { submit?: boolean } = {}): Promise<boolean> {
    return this._providerFor(agentId).sendTerminalInput(agentId, input, options);
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
