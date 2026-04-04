// ─── ExecutionManager: unified facade routing agents to execution providers ──
//
// The rest of the codebase interacts with ExecutionManager exclusively.
// It delegates to SandboxExecutionProvider or CoderExecutionProvider based on
// a per-agent resolver function (typically checking llmConfig.managesContext).
//
// The API surface mirrors ExecutionProvider exactly, so consumers don't need
// to know which backend is active for a given agent.

import { SandboxExecutionProvider } from './sandboxExecutionProvider.js';
import { CoderExecutionProvider } from './coderExecutionProvider.js';

export class ExecutionManager {
  /**
   * @param {{
   *   resolveProvider: (agentId: string) => 'coder' | 'sandbox',
   *   coderOptions?: { baseUrl?: string, apiKey?: string }
   * }} options
   *
   * resolveProvider is called to decide which backend an agent should use.
   * It receives the agentId and must return 'coder' or 'sandbox'.
   */
  constructor(options = {}) {
    this.sandbox = new SandboxExecutionProvider();
    this.coder = new CoderExecutionProvider(options.coderOptions || {});
    this._resolveProvider = options.resolveProvider || (() => 'sandbox');
    // Track which provider each agent was last routed to
    this._agentProviders = new Map(); // agentId -> 'sandbox' | 'coder'
  }

  // ── Provider resolution ───────────────────────────────────────────────

  /**
   * Get the correct provider for an agent.
   * Once an agent is assigned to a provider via ensureProject, that binding
   * is cached and reused. The resolver is only called when the agent has
   * no current binding.
   *
   * @param {string} agentId
   * @returns {import('./executionProvider.js').ExecutionProvider}
   */
  _providerFor(agentId) {
    // If already bound, reuse
    const bound = this._agentProviders.get(agentId);
    if (bound) {
      return bound === 'coder' ? this.coder : this.sandbox;
    }
    // Resolve and bind
    const choice = this._resolveProvider(agentId);
    this._agentProviders.set(agentId, choice);
    return choice === 'coder' ? this.coder : this.sandbox;
  }

  /**
   * Explicitly bind an agent to a specific provider.
   * Called by agentManager when it knows the llmConfig for an agent.
   *
   * @param {string} agentId
   * @param {'sandbox' | 'coder'} providerType
   * @param {{ ownerId?: string }} [meta] - optional metadata (e.g. ownerId for coder-service)
   */
  bindAgent(agentId, providerType, meta = {}) {
    const previous = this._agentProviders.get(agentId);
    if (previous && previous !== providerType) {
      console.log(`🔄 [Execution] Agent ${agentId.slice(0, 8)} switching provider: ${previous} → ${providerType}`);
      // Clean up old provider
      const oldProvider = previous === 'coder' ? this.coder : this.sandbox;
      oldProvider.destroySandbox(agentId).catch(() => {});
    }
    this._agentProviders.set(agentId, providerType);
    // Forward owner info to coder provider for X-Owner-Id header
    if (providerType === 'coder' && meta.ownerId) {
      this.coder.setOwner(agentId, meta.ownerId);
    }
  }

  /**
   * Get the provider type currently bound to an agent.
   * @param {string} agentId
   * @returns {'sandbox' | 'coder' | undefined}
   */
  getProviderType(agentId) {
    return this._agentProviders.get(agentId);
  }

  // ── ExecutionProvider interface (delegated) ───────────────────────────

  async ensureProject(agentId, project = null, gitUrl = null) {
    return this._providerFor(agentId).ensureProject(agentId, project, gitUrl);
  }

  async switchProject(agentId, newProject, gitUrl = null) {
    return this._providerFor(agentId).switchProject(agentId, newProject, gitUrl);
  }

  async destroySandbox(agentId) {
    const provider = this._providerFor(agentId);
    await provider.destroySandbox(agentId);
    this._agentProviders.delete(agentId);
  }

  async destroyAll() {
    await Promise.all([
      this.sandbox.destroyAll(),
      this.coder.destroyAll(),
    ]);
    this._agentProviders.clear();
  }

  hasEnvironment(agentId) {
    return this._providerFor(agentId).hasEnvironment(agentId);
  }

  getProject(agentId) {
    return this._providerFor(agentId).getProject(agentId);
  }

  getFileTree(agentId) {
    return this._providerFor(agentId).getFileTree(agentId);
  }

  async refreshFileTree(agentId) {
    return this._providerFor(agentId).refreshFileTree(agentId);
  }

  async readFile(agentId, filePath) {
    return this._providerFor(agentId).readFile(agentId, filePath);
  }

  async writeFile(agentId, filePath, content) {
    return this._providerFor(agentId).writeFile(agentId, filePath, content);
  }

  async appendFile(agentId, filePath, content) {
    return this._providerFor(agentId).appendFile(agentId, filePath, content);
  }

  async listDir(agentId, dirPath) {
    return this._providerFor(agentId).listDir(agentId, dirPath);
  }

  async searchFiles(agentId, pattern, query) {
    return this._providerFor(agentId).searchFiles(agentId, pattern, query);
  }

  async exec(agentId, command, options = {}) {
    return this._providerFor(agentId).exec(agentId, command, options);
  }

  async gitCommitPush(agentId, message) {
    return this._providerFor(agentId).gitCommitPush(agentId, message);
  }

  // ── Backward compatibility aliases ────────────────────────────────────
  // Allow drop-in replacement where code still calls sandboxManager methods.

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

  async cleanupOrphans() {
    await this.sandbox.cleanupOrphans();
  }
}
