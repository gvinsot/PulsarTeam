// ─── RunnerExecutionProvider: HTTP-based execution backend ──────────────────
//
// Generic HTTP provider that talks to a runner-service instance (any
// RUNNER_TYPE — claude-code, openclaw, hermes, opencode, sandbox).
//
// All backend-specific logic (CLI flags, stream parsing, OAuth, etc.) is
// handled by the runner-service itself; this provider is a thin HTTP shim
// over /exec-shell, /projects/ensure, ...

import { ExecutionProvider, GitCredentials } from './executionProvider.js';
import { readSecret } from '../../secrets.js';

interface AgentEntry {
  project: string | null;
  ready: boolean;
  /** Epoch ms of the last successful /projects/ensure call for this project. */
  lastEnsuredAt?: number;
}

interface FileTreeCacheEntry {
  project: string | null;
  tree: string | null;
  timestamp: number;
}

interface RunnerOptions {
  baseUrl?: string;
  apiKey?: string;
}

/**
 * How long a successful /projects/ensure result is trusted before we re-issue
 * the call for the same (agent, project). The runner-service does its own
 * fetch+reset on every call, so spamming this endpoint at every tool batch is
 * wasteful and causes concurrent git operations on the same working tree.
 */
const ENSURE_PROJECT_TTL_MS = 60_000;

export class RunnerExecutionProvider extends ExecutionProvider {
  baseUrl: string;
  apiKey: string;
  _agents: Map<string, AgentEntry>;
  _fileTreeCache: Map<string, FileTreeCacheEntry>;
  ownerIds: Map<string, string>;
  /** Git credentials per agent, forwarded to the runner on /projects/ensure. */
  gitCredentials: Map<string, GitCredentials>;
  /** Per-agent permissions, forwarded as X-Agent-Permissions on every call so
   *  the runner enforces shellAccess / internetAccess / restrictedPaths even
   *  for backends with no LLM (sandbox) or no per-agent permission cache. */
  permissions: Map<string, any>;
  /** Per-agent resolved LLM config, forwarded as X-LLM-Config so CLI backends
   *  that wrap multi-provider tools (opencode, openclaw, ...) can configure
   *  the underlying CLI with the agent's selected provider/model/apiKey
   *  instead of falling back to the static RUNNER_MODEL env. */
  llmConfigs: Map<string, any>;

  constructor(options: RunnerOptions = {}) {
    super();
    this.baseUrl = options.baseUrl || '';
    this.apiKey = options.apiKey || readSecret('CODER_API_KEY');
    this._agents = new Map();
    this._fileTreeCache = new Map();
    this.ownerIds = new Map();
    this.gitCredentials = new Map();
    this.permissions = new Map();
    this.llmConfigs = new Map();
  }

  /**
   * Associate an owner ID with an agent so all HTTP requests include X-Owner-Id.
   */
  setOwner(agentId: string, ownerId: string): void {
    if (ownerId) this.ownerIds.set(agentId, ownerId);
  }

  /**
   * Associate (or clear) per-agent git credentials. Stored in-memory only —
   * forwarded to the runner-service on the next ensureProject/switchProject
   * call so the runner can install them in the agent's HOME.
   */
  setGitCredentials(agentId: string, creds: GitCredentials | null): void {
    if (!agentId) return;
    if (creds && creds.token) {
      this.gitCredentials.set(agentId, creds);
    } else {
      this.gitCredentials.delete(agentId);
    }
  }

  /**
   * Associate (or clear) per-agent permissions. Forwarded to the runner on
   * every HTTP call via X-Agent-Permissions so shellAccess / internetAccess /
   * restrictedPaths are enforced even by the sandbox backend.
   */
  setPermissions(agentId: string, permissions: any | null): void {
    if (!agentId) return;
    if (permissions && typeof permissions === 'object') {
      this.permissions.set(agentId, permissions);
    } else {
      this.permissions.delete(agentId);
    }
  }

  /**
   * Associate (or clear) the agent's resolved LLM config. Only a small
   * subset of fields is forwarded — provider, model, apiKey, endpoint —
   * so the runner can configure its CLI without leaking unrelated data.
   */
  setLlmConfig(agentId: string, llmConfig: any | null): void {
    if (!agentId) return;
    if (llmConfig && typeof llmConfig === 'object') {
      const minimal = {
        provider: llmConfig.provider || null,
        model: llmConfig.model || null,
        apiKey: llmConfig.apiKey || null,
        endpoint: llmConfig.endpoint || null,
      };
      this.llmConfigs.set(agentId, minimal);
    } else {
      this.llmConfigs.set(agentId, null);
    }
  }

  // ── ExecutionProvider interface ───────────────────────────────────────

  async ensureProject(
    agentId: string,
    project: string | null = null,
    gitUrl: string | null = null,
    gitCredentials: GitCredentials | null = null,
  ): Promise<void> {
    if (gitCredentials !== null) this.setGitCredentials(agentId, gitCredentials);

    if (!project || !gitUrl) {
      this._agents.set(agentId, { project: null, ready: true });
      return;
    }

    // Debounce: if the same (agent, project) was successfully ensured very
    // recently, skip the HTTP round-trip. The runner-service caches the clone
    // and re-runs git fetch+reset on every call, which is expensive when
    // every tool batch from the LLM triggers ensureProject.
    const existing = this._agents.get(agentId);
    if (
      existing &&
      existing.ready &&
      existing.project === project &&
      existing.lastEnsuredAt &&
      Date.now() - existing.lastEnsuredAt < ENSURE_PROJECT_TTL_MS
    ) {
      return;
    }

    console.log(`🤖 [Runner] ensureProject(agent=${agentId.slice(0, 8)}, project=${project || 'none'}, gitUrl=${gitUrl ? 'yes' : 'no'})`);

    try {
      const creds = (this.gitCredentials.get(agentId) || null) as (GitCredentials & { login?: string | null }) | null;
      const body: any = { project, git_url: gitUrl };
      if (creds && creds.token) {
        body.git_credentials = {
          provider: creds.provider || 'github',
          token: creds.token,
          username: creds.username || creds.login || null,
        };
      }
      const res = await fetch(`${this.baseUrl}/projects/ensure`, {
        method: 'POST',
        headers: this._headers(agentId),
        body: JSON.stringify(body),
      });
      const data: any = await res.json();
      if (data.status === 'error') {
        throw new Error(data.error || 'Project ensure failed');
      }
      this._agents.set(agentId, { project, ready: true, lastEnsuredAt: Date.now() });
      console.log(`🤖 [Runner] Project "${project}" ready for agent ${agentId.slice(0, 8)}`);

      await this.refreshFileTree(agentId);
    } catch (err: any) {
      console.error(`🤖 [Runner] ensureProject failed: ${err.message}`);
      throw err;
    }
  }

  async switchProject(
    agentId: string,
    newProject: string,
    gitUrl: string | null = null,
    gitCredentials: GitCredentials | null = null,
  ): Promise<void> {
    if (gitCredentials !== null) this.setGitCredentials(agentId, gitCredentials);
    this._fileTreeCache.delete(agentId);
    // Force a re-ensure even if the TTL hasn't elapsed: the caller explicitly
    // wants a project switch.
    const entry = this._agents.get(agentId);
    if (entry) entry.lastEnsuredAt = 0;
    await this.ensureProject(agentId, newProject, gitUrl);
    // The runner is stateless — there's no per-agent session cache to reset.
    // The CLI session UUID is owned by the API (agent.runnerSessions) and is
    // cleared by _switchProjectContext when the project actually changes.
  }

  async destroySandbox(agentId: string): Promise<void> {
    this._agents.delete(agentId);
    this._fileTreeCache.delete(agentId);
    this.ownerIds.delete(agentId);
    this.gitCredentials.delete(agentId);
    this.permissions.delete(agentId);
    this.llmConfigs.delete(agentId);
    console.log(`🗑️  [Runner] Cleared state for agent ${agentId.slice(0, 8)}`);
  }

  async destroyAll(): Promise<void> {
    this._agents.clear();
    this._fileTreeCache.clear();
    this.ownerIds.clear();
    this.gitCredentials.clear();
    this.permissions.clear();
    this.llmConfigs.clear();
    console.log('🗑️  [Runner] Cleared all agent states');
  }

  async closeTerminalSession(agentId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/terminal/sessions/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      headers: this._headers(agentId),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`terminal session close failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data: any = await res.json().catch(() => ({}));
    return Boolean(data.closed);
  }

  async sendTerminalInput(agentId: string, input: string, options: { submit?: boolean } = {}): Promise<boolean> {
    if (!input) return false;
    const res = await fetch(`${this.baseUrl}/terminal/sessions/${encodeURIComponent(agentId)}/input`, {
      method: 'POST',
      headers: this._headers(agentId),
      body: JSON.stringify({
        input,
        submit: options.submit !== false,
        bracketed_paste: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`terminal input failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data: any = await res.json().catch(() => ({}));
    return data.status === 'success';
  }

  hasEnvironment(agentId: string): boolean {
    return this._agents.has(agentId);
  }

  getProject(agentId: string): string | null {
    return this._agents.get(agentId)?.project || null;
  }

  getFileTree(agentId: string): string | null {
    const cached = this._fileTreeCache.get(agentId);
    if (!cached) return null;
    const entry = this._agents.get(agentId);
    if (!entry || entry.project !== cached.project) return null;
    return cached.tree;
  }

  async refreshFileTree(agentId: string): Promise<void> {
    const entry = this._agents.get(agentId);
    if (!entry || !entry.project) return;

    try {
      const { stdout } = await this._execShell(agentId, 'ls -1F . | head -100', 10);
      const lines = stdout.trim().split('\n').filter(l => l);
      if (lines.length === 0) {
        this._fileTreeCache.set(agentId, { project: entry.project, tree: null, timestamp: Date.now() });
        return;
      }
      const tree = lines.join('\n');
      this._fileTreeCache.set(agentId, { project: entry.project, tree, timestamp: Date.now() });
      console.log(`🌳 [Runner] File tree cached for agent ${agentId.slice(0, 8)} (${lines.length} entries)`);
    } catch (err: any) {
      console.warn(`⚠️  [Runner] Failed to generate file tree for ${agentId.slice(0, 8)}: ${err.message}`);
    }
  }

  // ── File operations ───────────────────────────────────────────────────

  async readFile(agentId: string, filePath: string): Promise<string> {
    const { stdout } = await this._execShell(agentId, `cat ${this._sh(filePath)}`, 10);
    return stdout;
  }

  async writeFile(agentId: string, filePath: string, content: string): Promise<void> {
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dirPath) {
      await this._execShell(agentId, `mkdir -p ${this._sh(dirPath)}`, 10);
    }
    const b64 = Buffer.from(content).toString('base64');
    await this._execShell(agentId, `echo '${b64}' | base64 -d > ${this._sh(filePath)}`, 30);
  }

  async appendFile(agentId: string, filePath: string, content: string): Promise<void> {
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dirPath) {
      await this._execShell(agentId, `mkdir -p ${this._sh(dirPath)}`, 10);
    }
    const b64 = Buffer.from(content).toString('base64');
    await this._execShell(agentId, `echo '${b64}' | base64 -d >> ${this._sh(filePath)}`, 30);
  }

  async listDir(agentId: string, dirPath: string): Promise<string> {
    const { stdout } = await this._execShell(agentId, `ls -1F ${this._sh(dirPath)} | head -200`, 10);
    return stdout;
  }

  async searchFiles(agentId: string, pattern: string, query: string): Promise<string> {
    const { stdout: matches } = await this._execShell(
      agentId,
      `grep -r -n -i --include ${this._sh(pattern)} -- ${this._sh(query)} . 2>/dev/null | head -50`,
      15
    );
    return matches;
  }

  // ── Command execution ─────────────────────────────────────────────────

  async exec(
    agentId: string,
    command: string,
    options: { cwd?: string; timeout?: number; maxOutput?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const timeout = Math.min(Math.ceil((options.timeout || 300000) / 1000), 120);
    const { stdout, stderr } = await this._execShell(agentId, command, timeout, options.maxOutput);
    return { stdout, stderr };
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

  // ── Private HTTP helpers ──────────────────────────────────────────────

  _headers(agentId: string | null, ownerId: string | null = null): Record<string, string> {
    const resolvedOwner = ownerId || (agentId ? this.ownerIds.get(agentId) : null) || null;
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Api-Key': this.apiKey,
      'Authorization': `Bearer ${this.apiKey}`,
    };
    if (agentId) h['X-Agent-Id'] = agentId;
    if (resolvedOwner) h['X-Owner-Id'] = resolvedOwner;
    const perms = agentId ? this.permissions.get(agentId) : null;
    if (perms) h['X-Agent-Permissions'] = JSON.stringify(perms);
    if (agentId && this.llmConfigs.has(agentId)) {
      h['X-LLM-Config'] = JSON.stringify(this.llmConfigs.get(agentId));
    }
    return h;
  }

  /**
   * Execute a shell command on the runner-service via /exec-shell.
   */
  async _execShell(
    agentId: string,
    command: string,
    timeoutSecs: number = 60,
    maxOutput?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const body: Record<string, unknown> = { command, timeout: timeoutSecs };
    if (typeof maxOutput === 'number' && Number.isFinite(maxOutput) && maxOutput > 0) {
      body.max_output = Math.floor(maxOutput);
    }
    const res = await fetch(`${this.baseUrl}/exec-shell`, {
      method: 'POST',
      headers: this._headers(agentId),
      body: JSON.stringify(body),
    });
    const data: any = await res.json();
    if (data.status !== 'success') {
      const err: any = new Error(data.error || 'Command failed');
      err.stdout = data.output || '';
      err.stderr = data.output || '';
      throw err;
    }
    return { stdout: data.output || '', stderr: '' };
  }

  _sh(value: any): string {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }
}
