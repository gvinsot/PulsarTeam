import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Shared sandbox manager:
 * - Maintains a single shared Docker container
 * - Creates one Linux user per agent inside that container
 * - Executes tool commands as the corresponding agent user
 */
export class SandboxManager {
  constructor() {
    this.sharedContainerName = process.env.SANDBOX_SHARED_CONTAINER_NAME || 'sandbox-shared';
    this.sharedImage = process.env.SANDBOX_IMAGE || 'agentswarm-sandbox:latest';
    this.network = process.env.SANDBOX_NETWORK || 'bridge';
    this.baseWorkspace = process.env.SANDBOX_BASE_WORKSPACE || '/workspace';
    this.agentUsers = new Map(); // agentId -> { username, project }
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
    console.log(`🗑️  [Sandbox] Detached agent ${agentId} from shared sandbox user "${username}"`);
  }

  async destroyAll() {
    this.agentUsers.clear();
    await this._forceRemove(this.sharedContainerName);
    console.log('🗑️  [Sandbox] Destroyed shared sandbox container');
  }

  async cleanupOrphans() {
    try {
      const { stdout } = await execAsync(
        `docker ps -a --filter "name=^/${this.sharedContainerName}$" --format "{{.Names}} {{.Status}}"`
      );
      const line = stdout.trim();
      if (!line) return;
      if (line.includes('Exited') || line.includes('Created')) {
        await this._forceRemove(this.sharedContainerName);
        console.log(`🧹 [Sandbox] Removed stale shared container ${this.sharedContainerName}`);
      }
    } catch {
      // Docker may not be available
    }
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
    const timeout = options.timeout || 30000;

    return this._execAsAgentUser(username, command, { cwd, timeout });
  }

  async readFile(agentId, filePath) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, filePath);
    const { stdout } = await this._execAsAgentUser(entry.username, `cat "${fullPath}"`, { timeout: 10000 });
    return stdout;
  }

  async writeFile(agentId, filePath, content) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, filePath);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

    await this._execAsAgentUser(entry.username, `mkdir -p "${dirPath}"`);

    return new Promise((resolve, reject) => {
      const proc = exec(
        `docker exec -i -u ${entry.username} ${this.sharedContainerName} sh -c 'cat > "${fullPath}"'`,
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

    await this._execAsAgentUser(entry.username, `mkdir -p "${dirPath}"`);

    return new Promise((resolve, reject) => {
      const proc = exec(
        `docker exec -i -u ${entry.username} ${this.sharedContainerName} sh -c 'cat >> "${fullPath}"'`,
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
      `ls -la "${fullPath}" | grep -v '^\\.\\.$' | head -200`,
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
      `grep -r -l -i --include "${pattern}" -- "${query}" "${basePath}/" 2>/dev/null | head -20`,
      { timeout: 15000 }
    ).catch(() => ({ stdout: '' }));

    if (!files.trim()) return '';

    const { stdout: matches } = await this._execAsAgentUser(
      entry.username,
      `grep -r -n -i --include "${pattern}" -- "${query}" "${basePath}/" 2>/dev/null | head -50`,
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
  }

  async _ensureSharedContainerRunning() {
    if (await this._isRunning(this.sharedContainerName)) return;

    await this._forceRemove(this.sharedContainerName);

    const sshMount = process.env.SSH_KEYS_HOST_PATH || '/home/gildas/.ssh';
    const gitName = process.env.GIT_USER_NAME || '';
    const gitEmail = process.env.GIT_USER_EMAIL || '';

    const cmd = [
      'docker run -d',
      `--name ${this.sharedContainerName}`,
      '--restart unless-stopped',
      `--network ${this.network}`,
      `-v "${sshMount}:/root/.ssh:ro"`,
      '-v /var/run/docker.sock:/var/run/docker.sock',
      `-e "GIT_USER_NAME=${gitName}"`,
      `-e "GIT_USER_EMAIL=${gitEmail}"`,
      `${this.sharedImage}`
    ].join(' ');

    await execAsync(cmd, { timeout: 30000 });
    console.log(`📦 [Sandbox] Started shared sandbox container ${this.sharedContainerName}`);
  }

  async _ensureLinuxUser(username) {
    const userEsc = this._sh(username);
    const home = this._sh(`/home/${username}`);
    const workspace = this._sh(this._userWorkspace(username));

    await this._execAsRoot(`id -u ${userEsc} >/dev/null 2>&1 || adduser -D -h ${home} -s /bin/bash ${userEsc}`);
    await this._execAsRoot(`mkdir -p ${workspace}`);
    await this._execAsRoot(`chown -R ${userEsc}:${userEsc} ${workspace}`);
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

    await this._execAsAgentUser(
      username,
      `git clone "${gitUrl}" "${target}"`,
      { timeout: 120000, cwd: this._userWorkspace(username) }
    );

    const gitName = process.env.GIT_USER_NAME;
    const gitEmail = process.env.GIT_USER_EMAIL;
    if (gitName) await this._execAsAgentUser(username, `git config --global user.name "${gitName}"`);
    if (gitEmail) await this._execAsAgentUser(username, `git config --global user.email "${gitEmail}"`);
  }

  async _execAsRoot(command, { timeout = 120000 } = {}) {
    const cmd = `docker exec ${this.sharedContainerName} /bin/bash -c ${JSON.stringify(command)}`;
    return execAsync(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
  }

  async _execAsAgentUser(username, command, { cwd = null, timeout = 120000 } = {}) {
    const cwdArg = cwd ? `-w "${cwd}"` : '';
    const cmd = `docker exec ${cwdArg} -u ${username} ${this.sharedContainerName} /bin/bash -c ${JSON.stringify(command)}`;
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

  async _forceRemove(containerName) {
    try {
      await execAsync(`docker rm -f ${containerName}`, { timeout: 15000 });
    } catch {
      // ignore
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
    if (!entry.project) throw new Error('No project assigned');
    const rel = String(relativePath || '').replace(/^\/+/, '');
    return `${this._userWorkspace(entry.username)}/${entry.project}/${rel}`;
  }

  _sh(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }
}

export const sandboxManager = new SandboxManager();