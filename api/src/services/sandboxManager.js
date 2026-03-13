import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Shared sandbox manager:
 * - Connects to an externally-managed sandbox container (Docker Swarm service)
 * - Creates one Linux user per agent inside that container
 * - Executes tool commands as the corresponding agent user
 */
export class SandboxManager {
  constructor() {
    this.sandboxServiceFilter = process.env.SANDBOX_SHARED_CONTAINER_NAME || 'sandbox';
    this.baseWorkspace = process.env.SANDBOX_BASE_WORKSPACE || '/workspace';
    this.agentUsers = new Map(); // agentId -> { username, project }
    this._resolvedContainerName = null;
    this._fileTreeCache = new Map(); // agentId -> { project, tree, timestamp }
  }

  async ensureSandbox(agentId, project = null, gitUrl = null) {
    await this._ensureSharedContainerRunning();

    const existing = this.agentUsers.get(agentId);
    if (existing) {
      if (existing.project !== project) {
        await this._switchProject(agentId, project, gitUrl);
      }
      return;
    }

    const username = this._username(agentId);
    await this._ensureLinuxUser(username);
    await this._ensureAgentWorkspace(username);

    if (project && gitUrl) {
      await this._cloneProjectForUser(username, project, gitUrl);
    }

    this.agentUsers.set(agentId, { username, project });
    console.log(`📦 [Sandbox] Agent ${agentId} mapped to shared container user "${username}" (project: ${project || 'none'})`);

    // Generate file tree in background (non-blocking)
    if (project) {
      this._generateFileTree(agentId).catch(() => {});
    }
  }

  async switchProject(agentId, newProject, gitUrl = null) {
    await this._switchProject(agentId, newProject, gitUrl);
  }

  async destroySandbox(agentId) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) return;

    const { username } = entry;
    try {
      await this._execAsRoot(`pkill -u ${this._sh(username)} || true`);
      await this._execAsRoot(`rm -rf ${this._sh(this._userWorkspace(username))}/*`);
    } catch (err) {
      console.warn(`⚠️ [Sandbox] Failed cleanup for user ${username}: ${err.message}`);
    }

    this.agentUsers.delete(agentId);
    this._fileTreeCache.delete(agentId);
    console.log(`🗑️  [Sandbox] Detached agent ${agentId} from shared sandbox user "${username}"`);
  }

  async destroyAll() {
    this.agentUsers.clear();
    this._resolvedContainerName = null;
    console.log('🗑️  [Sandbox] Cleared all agent user mappings (container managed by Swarm)');
  }

  async cleanupOrphans() {
    // Container lifecycle is managed by Docker Swarm — nothing to clean up
  }

  /**
   * Get a compact file tree for the agent's project (cached, max 3 levels deep).
   * Returns null if no sandbox or tree not yet generated.
   */
  getFileTree(agentId) {
    const cached = this._fileTreeCache.get(agentId);
    if (!cached) return null;
    const entry = this.agentUsers.get(agentId);
    if (!entry || entry.project !== cached.project) return null;
    return cached.tree;
  }

  /**
   * Generate and cache a compact file tree for the agent's current project.
   * Uses `find` with depth limit, excludes .git/node_modules, outputs a tree-like format.
   */
  async _generateFileTree(agentId) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) return;
    const basePath = entry.project
      ? `${this._userWorkspace(entry.username)}/${entry.project}`
      : this._userWorkspace(entry.username);
    try {
      const { stdout } = await this._execAsAgentUser(
        entry.username,
        `find ${this._sh(basePath)} -maxdepth 3 -not -path '*/\\.git/*' -not -path '*/\\.git' -not -path '*/node_modules/*' -not -path '*/node_modules' -not -path '*/__pycache__/*' -not -path '*/.next/*' | sort | head -300`,
        { timeout: 10000 }
      );
      // Convert absolute paths to relative tree
      const prefix = basePath + '/';
      const lines = stdout.trim().split('\n')
        .map(l => l.replace(basePath, '.'))
        .filter(l => l && l !== '.');
      if (lines.length === 0) {
        this._fileTreeCache.set(agentId, { project: entry.project, tree: null, timestamp: Date.now() });
        return;
      }
      // Build indented tree
      const tree = lines.map(l => {
        const rel = l.startsWith('./') ? l.slice(2) : l;
        const parts = rel.split('/');
        const indent = '  '.repeat(parts.length - 1);
        const name = parts[parts.length - 1];
        return `${indent}${name}`;
      }).join('\n');
      this._fileTreeCache.set(agentId, { project: entry.project, tree, timestamp: Date.now() });
      console.log(`🌳 [Sandbox] File tree cached for agent ${agentId} (${lines.length} entries)`);
    } catch (err) {
      console.warn(`⚠️  [Sandbox] Failed to generate file tree for ${agentId}: ${err.message}`);
    }
  }

  /**
   * Force refresh the cached file tree (e.g., after git operations).
   */
  async refreshFileTree(agentId) {
    await this._generateFileTree(agentId);
  }

  hasSandbox(agentId) {
    return this.agentUsers.has(agentId);
  }

  getSandboxProject(agentId) {
    return this.agentUsers.get(agentId)?.project || null;
  }

  async exec(agentId, command, options = {}) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);

    const { username, project } = entry;
    const cwd = options.cwd || (project ? `${this._userWorkspace(username)}/${project}` : this._userWorkspace(username));
    const timeout = options.timeout || 300000; // 5 minutes default

    return this._execAsAgentUser(username, command, { cwd, timeout });
  }

  async readFile(agentId, filePath) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, filePath);
    const { stdout } = await this._execAsAgentUser(entry.username, `cat ${this._sh(fullPath)}`, { timeout: 10000 });
    return stdout;
  }

  async writeFile(agentId, filePath, content) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, filePath);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

    await this._execAsAgentUser(entry.username, `mkdir -p ${this._sh(dirPath)}`);

    const innerCmd = `cat > ${this._sh(fullPath)}`;
    return new Promise((resolve, reject) => {
      const proc = exec(
        `docker exec -i -u ${this._sh(entry.username)} ${this._sh(this._resolvedContainerName)} /bin/bash -c ${this._sh(innerCmd)}`,
        { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`Write failed: ${err.message}`));
          else resolve({ stdout, stderr });
        }
      );
      proc.stdin.write(content);
      proc.stdin.end();
    });
  }

  async appendFile(agentId, filePath, content) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, filePath);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

    await this._execAsAgentUser(entry.username, `mkdir -p ${this._sh(dirPath)}`);

    const innerCmd = `cat >> ${this._sh(fullPath)}`;
    return new Promise((resolve, reject) => {
      const proc = exec(
        `docker exec -i -u ${this._sh(entry.username)} ${this._sh(this._resolvedContainerName)} /bin/bash -c ${this._sh(innerCmd)}`,
        { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`Append failed: ${err.message}`));
          else resolve({ stdout, stderr });
        }
      );
      proc.stdin.write(content);
      proc.stdin.end();
    });
  }

  async listDir(agentId, dirPath) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, dirPath);
    const { stdout } = await this._execAsAgentUser(
      entry.username,
      `ls -la ${this._sh(fullPath)} | grep -v '^\\.\\.$' | head -200`,
      { timeout: 10000 }
    );
    return stdout;
  }

  async searchFiles(agentId, pattern, query) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const basePath = this._projectPath(entry, '');

    const { stdout: files } = await this._execAsAgentUser(
      entry.username,
      `grep -r -l -i --include ${this._sh(pattern)} -- ${this._sh(query)} ${this._sh(basePath + '/')} 2>/dev/null | head -20`,
      { timeout: 15000 }
    ).catch(() => ({ stdout: '' }));

    if (!files.trim()) return '';

    const { stdout: matches } = await this._execAsAgentUser(
      entry.username,
      `grep -r -n -i --include ${this._sh(pattern)} -- ${this._sh(query)} ${this._sh(basePath + '/')} 2>/dev/null | head -50`,
      { timeout: 15000 }
    ).catch(() => ({ stdout: '' }));

    return matches;
  }

  async _switchProject(agentId, newProject, gitUrl = null) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`Sandbox not initialized for agent ${agentId}`);

    const { username } = entry;
    await this._execAsRoot(`rm -rf ${this._sh(this._userWorkspace(username))}/*`);

    if (newProject && gitUrl) {
      await this._cloneProjectForUser(username, newProject, gitUrl);
    }

    entry.project = newProject;
    console.log(`📦 [Sandbox] User "${username}" switched to project "${newProject}"`);

    // Regenerate file tree for new project
    if (newProject) {
      this._generateFileTree(agentId).catch(() => {});
    } else {
      this._fileTreeCache.delete(agentId);
    }
  }

  async _ensureSharedContainerRunning() {
    // Check if cached container name is still valid
    if (this._resolvedContainerName && await this._isRunning(this._resolvedContainerName)) return;

    // Discover the Swarm-managed sandbox container
    this._resolvedContainerName = await this._discoverContainer();
    console.log(`📦 [Sandbox] Connected to Swarm sandbox container: ${this._resolvedContainerName}`);
  }

  async _discoverContainer() {
    const filter = this.sandboxServiceFilter;
    try {
      const { stdout } = await execAsync(
        `docker ps --filter "name=${filter}" --filter "status=running" --format "{{.Names}}"`,
        { timeout: 5000 }
      );
      const names = stdout.trim().split('\n').filter(Boolean);
      if (names.length === 0) {
        throw new Error(`No running sandbox container found matching filter "${filter}"`);
      }
      return names[0];
    } catch (err) {
      throw new Error(`Failed to discover sandbox container: ${err.message}`);
    }
  }

  async _ensureLinuxUser(username) {
    const userEsc = this._sh(username);
    const home = `/home/${username}`;
    const homeEsc = this._sh(home);
    const workspace = this._sh(this._userWorkspace(username));

    await this._execAsRoot(`id -u ${userEsc} >/dev/null 2>&1 || adduser -D -h ${homeEsc} -s /bin/bash ${userEsc}`);
    await this._execAsRoot(`mkdir -p ${workspace}`);
    await this._execAsRoot(`chown -R ${userEsc}:${userEsc} ${workspace}`);

    // Copy SSH keys so agent user can git clone/push via SSH
    const sshDir = this._sh(`${home}/.ssh`);
    await this._execAsRoot(
      `mkdir -p ${sshDir} && cp /root/.ssh/* ${sshDir}/ 2>/dev/null; chown -R ${userEsc}:${userEsc} ${sshDir} && chmod 700 ${sshDir} && chmod 600 ${sshDir}/* 2>/dev/null; true`
    );
  }

  async _ensureAgentWorkspace(username) {
    const workspace = this._sh(this._userWorkspace(username));
    const userEsc = this._sh(username);
    await this._execAsRoot(`mkdir -p ${workspace} && chown -R ${userEsc}:${userEsc} ${workspace}`);
  }

  async _cloneProjectForUser(username, project, gitUrl) {
    const userEsc = this._sh(username);
    const workspace = this._userWorkspace(username);
    const target = `${workspace}/${project}`;

    await this._execAsRoot(`rm -rf ${this._sh(target)}`);
    await this._execAsRoot(`mkdir -p ${this._sh(workspace)} && chown -R ${userEsc}:${userEsc} ${this._sh(workspace)}`);

    // Clone as root (guaranteed SSH key access), then chown to agent user
    await this._execAsRoot(
      `git clone ${this._sh(gitUrl)} ${this._sh(target)}`,
      { timeout: 120000 }
    );
    await this._execAsRoot(`chown -R ${userEsc}:${userEsc} ${this._sh(target)}`);

    // Git config per-repo (not --global) so each agent can have distinct identity
    const gitName = process.env.GIT_USER_NAME;
    const gitEmail = process.env.GIT_USER_EMAIL;
    if (gitName) await this._execAsAgentUser(username, `git config user.name ${this._sh(gitName)}`, { cwd: target });
    if (gitEmail) await this._execAsAgentUser(username, `git config user.email ${this._sh(gitEmail)}`, { cwd: target });
  }

  async _execAsRoot(command, { timeout = 120000 } = {}) {
    const cmd = `docker exec ${this._sh(this._resolvedContainerName)} /bin/bash -c ${this._sh(command)}`;
    return execAsync(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
  }

  async _execAsAgentUser(username, command, { cwd = null, timeout = 120000 } = {}) {
    const cwdArg = cwd ? `-w ${this._sh(cwd)}` : '';
    const cmd = `docker exec ${cwdArg} -u ${this._sh(username)} ${this._sh(this._resolvedContainerName)} /bin/bash -c ${this._sh(command)}`;
    return execAsync(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
  }

  async _isRunning(containerName) {
    try {
      const { stdout } = await execAsync(`docker inspect --format="{{.State.Running}}" ${containerName}`, { timeout: 5000 });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  _username(agentId) {
    const safe = String(agentId).toLowerCase().replace(/[^a-z0-9]/g, '');
    return `agent_${safe.slice(0, 24) || 'user'}`;
  }

  _userWorkspace(username) {
    return `${this.baseWorkspace}/${username}`;
  }

  _projectPath(entry, relativePath) {
    const rel = String(relativePath || '').replace(/^\/+/, '');
    const safe = rel.split('/').filter(seg => seg !== '..' && seg !== '').join('/');
    const base = entry.project
      ? `${this._userWorkspace(entry.username)}/${entry.project}`
      : this._userWorkspace(entry.username);
    return safe ? `${base}/${safe}` : base;
  }

  _sh(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }

}

export const sandboxManager = new SandboxManager();