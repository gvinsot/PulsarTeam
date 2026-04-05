// ─── ExecutionProvider: Abstract base class for code execution backends ──────
//
// Both the Sandbox (Docker exec) and Coder Service (Claude Code HTTP) implement
// this interface so that the rest of the codebase interacts with a single,
// uniform API regardless of the underlying execution engine.

/**
 * @abstract
 * Base class that defines the contract every execution provider must fulfill.
 * Consumers (agentTools, agentManager) call these methods without knowing
 * whether the agent runs in a sandbox container or via the coder-service.
 */
export class ExecutionProvider {
  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Ensure the execution environment is ready for the given agent.
   * Idempotent — safe to call multiple times.
   *
   * @param {string} agentId
   * @param {string|null} project — project name
   * @param {string|null} gitUrl  — git clone URL
   */
  async ensureProject(agentId, project = null, gitUrl = null) {
    throw new Error('ensureProject() not implemented');
  }

  /**
   * Switch the agent to a different project, cleaning up the old one.
   *
   * @param {string} agentId
   * @param {string} newProject
   * @param {string|null} gitUrl
   */
  async switchProject(agentId, newProject, gitUrl = null) {
    throw new Error('switchProject() not implemented');
  }

  /**
   * Tear down the execution environment for one agent.
   * @param {string} agentId
   */
  async destroySandbox(agentId) {
    throw new Error('destroySandbox() not implemented');
  }

  /** Tear down all agent environments managed by this provider. */
  async destroyAll() {
    throw new Error('destroyAll() not implemented');
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /**
   * @param {string} agentId
   * @returns {boolean} true if the provider has an active environment for this agent
   */
  hasEnvironment(agentId) {
    throw new Error('hasEnvironment() not implemented');
  }

  /**
   * @param {string} agentId
   * @returns {string|null} currently active project name, or null
   */
  getProject(agentId) {
    throw new Error('getProject() not implemented');
  }

  /**
   * Get a compact file tree for the agent's project root.
   * @param {string} agentId
   * @returns {string|null}
   */
  getFileTree(agentId) {
    return null;
  }

  /**
   * Force refresh the cached file tree.
   * @param {string} agentId
   */
  async refreshFileTree(agentId) {
    // no-op by default
  }

  // ── File operations ───────────────────────────────────────────────────

  /**
   * Read a file's contents.
   * @param {string} agentId
   * @param {string} filePath — relative to project root
   * @returns {Promise<string>} file contents
   */
  async readFile(agentId, filePath) {
    throw new Error('readFile() not implemented');
  }

  /**
   * Write (create / overwrite) a file.
   * @param {string} agentId
   * @param {string} filePath
   * @param {string} content
   */
  async writeFile(agentId, filePath, content) {
    throw new Error('writeFile() not implemented');
  }

  /**
   * Append content to a file.
   * @param {string} agentId
   * @param {string} filePath
   * @param {string} content
   */
  async appendFile(agentId, filePath, content) {
    throw new Error('appendFile() not implemented');
  }

  /**
   * List directory contents.
   * @param {string} agentId
   * @param {string} dirPath — relative to project root
   * @returns {Promise<string>}
   */
  async listDir(agentId, dirPath) {
    throw new Error('listDir() not implemented');
  }

  /**
   * Search for text in files matching a glob pattern.
   * @param {string} agentId
   * @param {string} pattern — glob (e.g. "*.js")
   * @param {string} query   — search text
   * @returns {Promise<string>}
   */
  async searchFiles(agentId, pattern, query) {
    throw new Error('searchFiles() not implemented');
  }

  // ── Command execution ─────────────────────────────────────────────────

  /**
   * Execute an arbitrary shell command in the agent's project context.
   * @param {string} agentId
   * @param {string} command
   * @param {{ cwd?: string, timeout?: number }} options
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  async exec(agentId, command, options = {}) {
    throw new Error('exec() not implemented');
  }

}
