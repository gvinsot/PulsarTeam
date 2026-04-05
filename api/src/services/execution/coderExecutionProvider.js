// ─── CoderExecutionProvider: Claude Code / coder-service HTTP backend ───────
//
// Implements the ExecutionProvider interface by calling the coder-service
// FastAPI endpoints (exec-shell, projects/ensure, etc.) over HTTP.
// This provider is used for agents whose LLM config has managesContext=true.

import { ExecutionProvider } from './executionProvider.js';

export class CoderExecutionProvider extends ExecutionProvider {
  /**
   * @param {{ baseUrl?: string, apiKey?: string }} options
   */
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl || process.env.CODER_SERVICE_URL || 'http://coder-service:8000';
    this.apiKey = options.apiKey || process.env.CODER_API_KEY || '';
    this._agents = new Map(); // agentId -> { project, ready }
    this._fileTreeCache = new Map(); // agentId -> { project, tree, timestamp }
    this.ownerIds = new Map(); // agentId -> ownerId
  }

  /**
   * Associate an owner ID with an agent so all HTTP requests include X-Owner-Id.
   * Called by agentManager when it knows the owner for a coder agent.
   */
  setOwner(agentId, ownerId) {
    if (ownerId) this.ownerIds.set(agentId, ownerId);
  }

  // ── ExecutionProvider interface ───────────────────────────────────────

  async ensureProject(agentId, project = null, gitUrl = null) {
    console.log(`🤖 [Coder] ensureProject(agent=${agentId.slice(0, 8)}, project=${project || 'none'}, gitUrl=${gitUrl ? 'yes' : 'no'})`);

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
      const data = await res.json();
      if (data.status === 'error') {
        throw new Error(data.error || 'Project ensure failed');
      }
      this._agents.set(agentId, { project, ready: true });
      console.log(`🤖 [Coder] Project "${project}" ready for agent ${agentId.slice(0, 8)}`);

      // Generate file tree after project setup
      await this.refreshFileTree(agentId);
    } catch (err) {
      console.error(`🤖 [Coder] ensureProject failed: ${err.message}`);
      throw err;
    }
  }

  async switchProject(agentId, newProject, gitUrl = null) {
    this._fileTreeCache.delete(agentId);
    await this.ensureProject(agentId, newProject, gitUrl);
  }

  async destroySandbox(agentId) {
    this._agents.delete(agentId);
    this._fileTreeCache.delete(agentId);
    this.ownerIds.delete(agentId);
    console.log(`🗑️  [Coder] Cleared state for agent ${agentId.slice(0, 8)}`);
  }

  async destroyAll() {
    this._agents.clear();
    this._fileTreeCache.clear();
    this.ownerIds.clear();
    console.log('🗑️  [Coder] Cleared all agent states');
  }

  hasEnvironment(agentId) {
    return this._agents.has(agentId);
  }

  getProject(agentId) {
    return this._agents.get(agentId)?.project || null;
  }

  getFileTree(agentId) {
    const cached = this._fileTreeCache.get(agentId);
    if (!cached) return null;
    const entry = this._agents.get(agentId);
    if (!entry || entry.project !== cached.project) return null;
    return cached.tree;
  }

  async refreshFileTree(agentId) {
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
      console.log(`🌳 [Coder] File tree cached for agent ${agentId.slice(0, 8)} (${lines.length} entries)`);
    } catch (err) {
      console.warn(`⚠️  [Coder] Failed to generate file tree for ${agentId.slice(0, 8)}: ${err.message}`);
    }
  }

  // ── File operations ───────────────────────────────────────────────────

  async readFile(agentId, filePath) {
    const { stdout } = await this._execShell(agentId, `cat ${this._sh(filePath)}`, 10);
    return stdout;
  }

  async writeFile(agentId, filePath, content) {
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dirPath) {
      await this._execShell(agentId, `mkdir -p ${this._sh(dirPath)}`, 10);
    }
    // Use base64 to safely transfer file contents with arbitrary characters
    const b64 = Buffer.from(content).toString('base64');
    await this._execShell(agentId, `echo '${b64}' | base64 -d > ${this._sh(filePath)}`, 30);
  }

  async appendFile(agentId, filePath, content) {
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dirPath) {
      await this._execShell(agentId, `mkdir -p ${this._sh(dirPath)}`, 10);
    }
    const b64 = Buffer.from(content).toString('base64');
    await this._execShell(agentId, `echo '${b64}' | base64 -d >> ${this._sh(filePath)}`, 30);
  }

  async listDir(agentId, dirPath) {
    const { stdout } = await this._execShell(agentId, `ls -1F ${this._sh(dirPath)} | head -200`, 10);
    return stdout;
  }

  async searchFiles(agentId, pattern, query) {
    const { stdout: matches } = await this._execShell(
      agentId,
      `grep -r -n -i --include ${this._sh(pattern)} -- ${this._sh(query)} . 2>/dev/null | head -50`,
      15
    );
    return matches;
  }

  // ── Command execution ─────────────────────────────────────────────────

  async exec(agentId, command, options = {}) {
    const timeout = Math.min(Math.ceil((options.timeout || 300000) / 1000), 120);
    const { stdout, stderr } = await this._execShell(agentId, command, timeout);
    return { stdout, stderr };
  }

  // ── Backward compatibility aliases ────────────────────────────────────

  /** @deprecated Use ensureProject() */
  async ensureSandbox(agentId, project = null, gitUrl = null) {
    return this.ensureProject(agentId, project, gitUrl);
  }
  /** @deprecated Use hasEnvironment() */
  hasSandbox(agentId) {
    return this.hasEnvironment(agentId);
  }
  /** @deprecated Use getProject() */
  getSandboxProject(agentId) {
    return this.getProject(agentId);
  }

  // ── Private HTTP helpers ──────────────────────────────────────────────

  _headers(agentId, ownerId = null) {
    const resolvedOwner = ownerId || (agentId ? this.ownerIds.get(agentId) : null) || null;
    const h = {
      'Content-Type': 'application/json',
      'X-Api-Key': this.apiKey,
      'Authorization': `Bearer ${this.apiKey}`,
    };
    if (agentId) h['X-Agent-Id'] = agentId;
    if (resolvedOwner) h['X-Owner-Id'] = resolvedOwner;
    return h;
  }

  /**
   * Execute a shell command on the coder-service via /exec-shell.
   * Returns { stdout, stderr } to match the sandbox exec interface.
   */
  async _execShell(agentId, command, timeoutSecs = 60) {
    const res = await fetch(`${this.baseUrl}/exec-shell`, {
      method: 'POST',
      headers: this._headers(agentId),
      body: JSON.stringify({ command, timeout: timeoutSecs }),
    });
    const data = await res.json();
    if (data.status !== 'success') {
      const err = new Error(data.error || 'Command failed');
      err.stdout = data.output || '';
      err.stderr = data.output || '';
      throw err;
    }
    return { stdout: data.output || '', stderr: '' };
  }

  _sh(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }
}

