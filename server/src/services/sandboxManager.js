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
    this.sharedContainerName = this._validateName(process.env.SANDBOX_SHARED_CONTAINER_NAME || 'sandbox-shared', 'container name');
    this.sharedImage = this._validateImageRef(process.env.SANDBOX_IMAGE || 'agentswarm-sandbox:latest', 'image');
    this.network = this._validateName(process.env.SANDBOX_NETWORK || 'bridge', 'network');
    this.baseWorkspace = process.env.SANDBOX_BASE_WORKSPACE || '/workspace';
    this.agentUsers = new Map(); // agentId -> { username, project }
    this._containerStartLock = null;
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
        `docker exec -i -u ${this._sh(entry.username)} ${this._sh(this.sharedContainerName)} /bin/bash -c ${this._sh(innerCmd)}`,
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
        `docker exec -i -u ${this._sh(entry.username)} ${this._sh(this.sharedContainerName)} /bin/bash -c ${this._sh(innerCmd)}`,
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
  }

  async _ensureSharedContainerRunning() {
    if (await this._isRunning(this.sharedContainerName)) return;

    // Mutex: if another call is already starting the container, just wait for it
    if (!this._containerStartLock) {
      this._containerStartLock = this._startContainer().finally(() => {
        this._containerStartLock = null;
      });
    }
    await this._containerStartLock;
  }

  async _startContainer() {
    await this._forceRemove(this.sharedContainerName);

    const sshMount = process.env.SSH_KEYS_HOST_PATH || '/home/gildas/.ssh';
    const gitName = process.env.GIT_USER_NAME || '';
    const gitEmail = process.env.GIT_USER_EMAIL || '';

    const cmd = [
      'docker run -d',
      `--name ${this._sh(this.sharedContainerName)}`,
      '--restart unless-stopped',
      `--network ${this._sh(this.network)}`,
      `-v ${this._sh(sshMount + ':/root/.ssh:ro')}`,
      '-v /var/run/docker.sock:/var/run/docker.sock',
      `-e ${this._sh('GIT_USER_NAME=' + gitName)}`,
      `-e ${this._sh('GIT_USER_EMAIL=' + gitEmail)}`,
      this._sh(this.sharedImage)
    ].join(' ');

    await execAsync(cmd, { timeout: 30000 });
    console.log(`📦 [Sandbox] Started shared sandbox container ${this.sharedContainerName}`);
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
    const cmd = `docker exec ${this._sh(this.sharedContainerName)} /bin/bash -c ${this._sh(command)}`;
    return execAsync(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
  }

  async _execAsAgentUser(username, command, { cwd = null, timeout = 120000 } = {}) {
    const cwdArg = cwd ? `-w ${this._sh(cwd)}` : '';
    const cmd = `docker exec ${cwdArg} -u ${this._sh(username)} ${this._sh(this.sharedContainerName)} /bin/bash -c ${this._sh(command)}`;
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
    const safe = rel.split('/').filter(seg => seg !== '..' && seg !== '').join('/');
    return `${this._userWorkspace(entry.username)}/${entry.project}/${safe}`;
  }

  _sh(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }

  _validateName(value, label) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) {
      throw new Error(`Invalid ${label}: "${value}" — only alphanumeric, dots, dashes, underscores allowed`);
    }
    return value;
  }

  _validateImageRef(value, label) {
    // Allow registry/image:tag format (e.g. registry.example.com/image:latest)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(value)) {
      throw new Error(`Invalid ${label}: "${value}" — contains disallowed characters`);
    }
    return value;
  }
}

export const sandboxManager = new SandboxManager();