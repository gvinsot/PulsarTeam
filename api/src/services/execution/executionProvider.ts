// ─── ExecutionProvider: Abstract base class for code execution backends ──────
//
// Both the Sandbox (Docker exec) and Coder Service (Claude Code HTTP) implement
// this interface so that the rest of the codebase interacts with a single,
// uniform API regardless of the underlying execution engine.

/**
 * Per-agent git authentication, resolved from a connected plugin
 * (GitHub OAuth on the agent / board / user). The runner-service installs
 * these credentials in the agent's HOME so subsequent `git` invocations from
 * the LLM agent (clone, fetch, push, gh CLI, ...) authenticate transparently.
 */
export interface GitCredentials {
  /** 'github' for now — gitlab/bitbucket can be wired in later. */
  provider: 'github';
  /** OAuth access token (or PAT). */
  token: string;
  /** GitHub login used as the username in the credential helper (optional). */
  username?: string | null;
}

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
   * @param agentId
   * @param project — project name
   * @param gitUrl  — git clone URL
   * @param gitCredentials — optional git auth (e.g. GitHub token from the
   *        connected plugin) to inject into the runner so the agent can
   *        clone / push via authenticated HTTPS.
   */
  async ensureProject(
    agentId: string,
    project: string | null = null,
    gitUrl: string | null = null,
    gitCredentials: GitCredentials | null = null,
  ): Promise<void> {
    throw new Error('ensureProject() not implemented');
  }

  /**
   * Switch the agent to a different project, cleaning up the old one.
   */
  async switchProject(
    agentId: string,
    newProject: string,
    gitUrl: string | null = null,
    gitCredentials: GitCredentials | null = null,
  ): Promise<void> {
    throw new Error('switchProject() not implemented');
  }

  /**
   * Tear down the execution environment for one agent.
   * @param agentId
   */
  async destroySandbox(agentId: string): Promise<void> {
    throw new Error('destroySandbox() not implemented');
  }

  /** Tear down all agent environments managed by this provider. */
  async destroyAll(): Promise<void> {
    throw new Error('destroyAll() not implemented');
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /**
   * @param agentId
   * @returns true if the provider has an active environment for this agent
   */
  hasEnvironment(agentId: string): boolean {
    throw new Error('hasEnvironment() not implemented');
  }

  /**
   * @param agentId
   * @returns currently active project name, or null
   */
  getProject(agentId: string): string | null {
    throw new Error('getProject() not implemented');
  }

  /**
   * Get a compact file tree for the agent's project root.
   * @param agentId
   */
  getFileTree(agentId: string): string | null {
    return null;
  }

  /**
   * Force refresh the cached file tree.
   * @param agentId
   */
  async refreshFileTree(agentId: string): Promise<void> {
    // no-op by default
  }

  // ── File operations ───────────────────────────────────────────────────

  /**
   * Read a file's contents.
   * @param agentId
   * @param filePath — relative to project root
   * @returns file contents
   */
  async readFile(agentId: string, filePath: string): Promise<string> {
    throw new Error('readFile() not implemented');
  }

  /**
   * Write (create / overwrite) a file.
   * @param agentId
   * @param filePath
   * @param content
   */
  async writeFile(agentId: string, filePath: string, content: string): Promise<any> {
    throw new Error('writeFile() not implemented');
  }

  /**
   * Append content to a file.
   * @param agentId
   * @param filePath
   * @param content
   */
  async appendFile(agentId: string, filePath: string, content: string): Promise<any> {
    throw new Error('appendFile() not implemented');
  }

  /**
   * List directory contents.
   * @param agentId
   * @param dirPath — relative to project root
   */
  async listDir(agentId: string, dirPath: string): Promise<string> {
    throw new Error('listDir() not implemented');
  }

  /**
   * Search for text in files matching a glob pattern.
   * @param agentId
   * @param pattern — glob (e.g. "*.js")
   * @param query   — search text
   */
  async searchFiles(agentId: string, pattern: string, query: string): Promise<string> {
    throw new Error('searchFiles() not implemented');
  }

  // ── Command execution ─────────────────────────────────────────────────

  /**
   * Execute an arbitrary shell command in the agent's project context.
   * @param agentId
   * @param command
   * @param options
   */
  async exec(agentId: string, command: string, options: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    throw new Error('exec() not implemented');
  }

}
