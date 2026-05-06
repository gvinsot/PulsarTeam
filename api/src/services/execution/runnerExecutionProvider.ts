// ─── RunnerExecutionProvider: HTTP-based execution backend ──────────────────
//
// Generic HTTP provider that talks to a runner-service instance (any
// RUNNER_TYPE — claude-code, openclaw, hermes, opencode, sandbox).
//
// All backend-specific logic (CLI flags, stream parsing, OAuth, etc.) is
// handled by the runner-service itself; this provider is a thin HTTP shim
// over /exec-shell, /projects/ensure, /reset, ...

import { ExecutionProvider, GitCredentials } from './executionProvider.js';
import { readSecret } from '../../secrets.js';

interface AgentEntry {
  project: string | null;
  ready: boolean;
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

export class RunnerExecutionProvider extends ExecutionProvider {
  baseUrl: string;
  apiKey: string;
  _agents: Map<string, AgentEntry>;
  _fileTreeCache: Map<string, FileTreeCacheEntry>;
  ownerIds: Map<string, string>;
  /** Git credentials per agent, forwarded to the runner on /projects/ensure. */
  gitCredentials: Map<string, GitCredentials>;

  constructor(options: RunnerOptions = {}) {
    super();
    this.baseUrl = options.baseUrl || '';
    this.apiKey = options.apiKey || readSecret('CODER_API_KEY');
    this._agents = new Map();
    this._fileTreeCache = new Map();
    this.ownerIds = new Map();
    this.gitCredentials = new Map();
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

  // ── ExecutionProvider interface ───────────────────────────────────────

  async ensureProject(agentId: string, project: string | null = null, gitUrl: string | null = null): Promise<void> {
    console.log(`🤖 [Runner] ensureProject(agent=${agentId.slice(0, 8)}, project=${project || 'none'}, gitUrl=${gitUrl ? 'yes' : 'no'})`);

    if (!project || !gitUrl) {
      this._agents.set(agentId, { project: null, ready: true });
      return;
    }

    try {
      const res = await fetch(`${this.baseUrl}/projects/ensure`, {
        method: 'POST',
        headers: this._headers(agentId),
        body: JSON.stringify({ project, git_url: gitUrl }),
      });
      const data: any = await res.json();
      if (data.status === 'error') {
        throw new Error(data.error || 'Project ensure failed');
      }
      this._agents.set(agentId, { project, ready: true });
      console.log(`🤖 [Runner] Project "${project}" ready for agent ${agentId.slice(0, 8)}`);

      await this.refreshFileTree(agentId);
    } catch (err: any) {
      console.error(`🤖 [Runner] ensureProject failed: ${err.message}`);
      throw err;
    }
  }

  async switchProject(agentId: string, newProject: string, gitUrl: string | null = null): Promise<void> {
    this._fileTreeCache.delete(agentId);
    await this.ensureProject(agentId, newProject, gitUrl);
    await this.resetSession(agentId);
  }

  /**
   * Reset the runner CLI session for an agent.
   * Forces a new session on the next invocation so it picks up the current project cwd.
   */
  async resetSession(agentId: string): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/reset`, {
        method: 'POST',
        headers: this._headers(agentId),
      });
      const data: any = await res.json();
      console.log(`🔄 [Runner] Session reset for agent ${agentId.slice(0, 8)}: ${data.message || 'ok'}`);
    } catch (err: any) {
      console.warn(`⚠️  [Runner] Failed to reset session for ${agentId.slice(0, 8)}: ${err.message}`);
    }
  }

  async destroySandbox(agentId: string): Promise<void> {
    this._agents.delete(agentId);
    this._fileTreeCache.delete(agentId);
    this.ownerIds.delete(agentId);
    this.gitCredentials.delete(agentId);
    console.log(`🗑️  [Runner] Cleared state for agent ${agentId.slice(0, 8)}`);
  }

  async destroyAll(): Promise<void> {
    this._agents.clear();
    this._fileTreeCache.clear();
    this.ownerIds.clear();
    this.gitCredentials.clear();
    console.log('🗑️  [Runner] Cleared all agent states');
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

  async exec(agentId: string, command: string, options: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const timeout = Math.min(Math.ceil((options.timeout || 300000) / 1000), 120);
    const { stdout, stderr } = await this._execShell(agentId, command, timeout);
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
    return h;
  }

  /**
   * Execute a shell command on the runner-service via /exec-shell.
   */
  async _execShell(agentId: string, command: string, timeoutSecs: number = 60): Promise<{ stdout: string; stderr: string }> {
    const res = await fetch(`${this.baseUrl}/exec-shell`, {
      method: 'POST',
      headers: this._headers(agentId),
      body: JSON.stringify({ command, timeout: timeoutSecs }),
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
