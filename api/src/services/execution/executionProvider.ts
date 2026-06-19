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
   * Associate (or clear) per-agent git credentials. Forwarded to the runner
   * by providers that support authenticated HTTPS git operations.
   * No-op by default.
   */
  setGitCredentials(agentId: string, creds: GitCredentials | null): void {
    // no-op
  }

  /**
   * Push the agent's git plugin credentials to the runner without requiring a
   * project clone — covers the case of CLI runners whose LLM may interact
   * with GitHub repos on its own initiative even when no `project` is pinned.
   * Default no-op; only providers backed by a remote runner override this.
   */
  async installGitCredentials(agentId: string, creds: GitCredentials | null = null): Promise<void> {
    // no-op
  }

  /**
   * Associate (or clear) the resolved LLM configuration for an agent so the
   * runner can forward provider/model/API-key when invoking CLI backends
   * (opencode, claudecode, codex, ...). No-op by default.
   */
  setLlmConfig(agentId: string, llmConfig: any | null): void {
    // no-op
  }

  /**
   * Set (or clear with null) the agent's task-scoped secondary repos — extra
   * repos to clone alongside the primary `project`. Providers backed by a
   * remote runner forward this set on every ensure so the runner keeps them
   * instead of pruning. No-op by default.
   */
  setSecondaryRepos(agentId: string, repos: Array<{ provider?: string; fullName: string }> | null): void {
    // no-op
  }

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

  /**
   * Close the interactive terminal session for this agent, if the provider
   * supports one. The next terminal attach will spawn a fresh CLI process.
   */
  async closeTerminalSession(agentId: string): Promise<boolean> {
    return false;
  }

  /**
   * Ask an interactive terminal-backed CLI to abort its active run while
   * keeping the shared terminal session alive.
   */
  async interruptTerminalSession(agentId: string): Promise<boolean> {
    return false;
  }

  /**
   * Paste text into the interactive terminal prompt for runners that expose a
   * real CLI. This is intentionally narrow: workflow execute actions use it
   * to submit the task prompt to an idle CLI runner.
   */
  async sendTerminalInput(agentId: string, input: string, options: { submit?: boolean } = {}): Promise<boolean> {
    return false;
  }

  /**
   * Fetch the provider's interactive terminal session status (alive, pid,
   * latched `auth_error`, …) or null when no session / unsupported. Used by
   * the workflow engine to detect CLI auth failures on terminal-driven tasks.
   */
  async getTerminalSession(agentId: string): Promise<any | null> {
    return null;
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
