// ─── SandboxExecutionProvider: Docker-exec-based execution ──────────────────
//
// Wraps the existing SandboxManager (shared Docker container with per-agent
// Linux users) behind the unified ExecutionProvider interface.

import { ExecutionProvider } from './executionProvider.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class SandboxExecutionProvider extends ExecutionProvider {
  constructor() {
    super();
    this.sandboxServiceFilter = process.env.SANDBOX_SHARED_CONTAINER_NAME || 'sandbox';
    this.baseWorkspace = process.env.SANDBOX_BASE_WORKSPACE || '/workspace';
    this.agentUsers = new Map(); // agentId -> { username, project }
    this._resolvedContainerName = null;
    this._fileTreeCache = new Map(); // agentId -> { project, tree, timestamp }
  }

  // ── ExecutionProvider interface ───────────────────────────────────────

  async ensureProject(agentId, project = null, gitUrl = null) {
    console.log(`📦 [Sandbox] ensureProject(agent=${agentId.slice(0, 8)}, project=${project || 'none'}, gitUrl=${gitUrl ? 'yes' : 'no'})`);
    await this._ensureSharedContainerRunning();

    const existing = this.agentUsers.get(agentId);
    if (existing) {
      if (!existing._userVerified) {
        console.log(`📦 [Sandbox] Re-creating user "${existing.username}" after container change...`);
        await this._ensureLinuxUser(existing.username);
        await this._ensureAgentWorkspace(existing.username);
        existing._userVerified = true;
        if (existing.project && gitUrl) {
          await this._cloneProjectForUser(existing.username, existing.project, gitUrl);
          this._generateFileTree(agentId).catch(() => {});
        }
      }
      if (existing.project !== project) {
        await this._switchProject(agentId, project, gitUrl);
      }
      return;
    }

    const username = this._username(agentId);

    let userExists = false;
    let projectExists = false;
    try {
      const { stdout } = await this._execAsRoot(
        `id -u ${this._sh(username)} >/dev/null 2>&1 && echo "user_ok" || echo "user_missing"`,
        { timeout: 5000 }
      );
      userExists = stdout.trim().includes('user_ok');
      if (userExists && project) {
        const { stdout: projCheck } = await this._execAsRoot(
          `test -d ${this._sh(this._userWorkspace(username))}/${this._sh(project)}/.git && echo "proj_ok" || echo "proj_missing"`,
          { timeout: 5000 }
        );
        projectExists = projCheck.trim().includes('proj_ok');
      }
    } catch { /* fall through to full setup */ }

    if (userExists && projectExists) {
      console.log(`📦 [Sandbox] Reusing existing sandbox for "${username}" (project: ${project})`);
      this.agentUsers.set(agentId, { username, project, _userVerified: true });
      if (project && gitUrl) {
        await this._cloneProjectForUser(username, project, gitUrl);
      }
    } else {
      await this._ensureLinuxUser(username);
      await this._ensureAgentWorkspace(username);
      if (project && gitUrl) {
        await this._cloneProjectForUser(username, project, gitUrl);
      }
      this.agentUsers.set(agentId, { username, project, _userVerified: true });
      console.log(`📦 [Sandbox] Agent ${agentId} mapped to shared container user "${username}" (project: ${project || 'none'})`);
    }

    if (project) {
      await this._generateFileTree(agentId).catch(() => {});
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

  hasEnvironment(agentId) {
    return this.agentUsers.has(agentId);
  }

  getProject(agentId) {
    return this.agentUsers.get(agentId)?.project || null;
  }

  getFileTree(agentId) {
    const cached = this._fileTreeCache.get(agentId);
    if (!cached) return null;
    const entry = this.agentUsers.get(agentId);
    if (!entry || entry.project !== cached.project) return null;
    return cached.tree;
  }

  async refreshFileTree(agentId) {
    await this._generateFileTree(agentId);
  }

  // ── File operations ───────────────────────────────────────────────────

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
    return this._execPipedAsUser(entry.username, `cat > ${this._sh(fullPath)}`, content);
  }

  async appendFile(agentId, filePath, content) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, filePath);
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await this._execAsAgentUser(entry.username, `mkdir -p ${this._sh(dirPath)}`);
    return this._execPipedAsUser(entry.username, `cat >> ${this._sh(fullPath)}`, content);
  }

  async listDir(agentId, dirPath) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);
    const fullPath = this._projectPath(entry, dirPath);
    const { stdout } = await this._execAsAgentUser(
      entry.username,
      `ls -1F ${this._sh(fullPath)} | head -200`,
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

  // ── Command execution ─────────────────────────────────────────────────

  async exec(agentId, command, options = {}) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) throw new Error(`No sandbox running for agent ${agentId}`);

    const { username, project } = entry;
    const cwd = options.cwd || (project ? `${this._userWorkspace(username)}/${project}` : this._userWorkspace(username));
    const timeout = options.timeout || 300000;

    return this._execAsAgentUser(username, command, { cwd, timeout });
  }

  // ── Backward compatibility aliases ────────────────────────────────────
  // These allow the transition period where old code still calls the old names.

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

  // ── Private methods (unchanged from SandboxManager) ───────────────────

  async _generateFileTree(agentId) {
    const entry = this.agentUsers.get(agentId);
    if (!entry) return;
    const basePath = entry.project
      ? `${this._userWorkspace(entry.username)}/${entry.project}`
      : this._userWorkspace(entry.username);
    try {
      const { stdout } = await this._execAsAgentUser(
        entry.username,
        `ls -1F ${this._sh(basePath)} | head -100`,
        { timeout: 10000 }
      );
      const lines = stdout.trim().split('\n').filter(l => l);
      if (lines.length === 0) {
        this._fileTreeCache.set(agentId, { project: entry.project, tree: null, timestamp: Date.now() });
        return;
      }
      const tree = lines.join('\n');
      this._fileTreeCache.set(agentId, { project: entry.project, tree, timestamp: Date.now() });
      console.log(`🌳 [Sandbox] File tree cached for agent ${agentId} (${lines.length} entries)`);
    } catch (err) {
      console.warn(`⚠️  [Sandbox] Failed to generate file tree for ${agentId}: ${err.message}`);
    }
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

    if (newProject) {
      this._generateFileTree(agentId).catch(() => {});
    } else {
      this._fileTreeCache.delete(agentId);
    }
  }

  async _ensureSharedContainerRunning() {
    const CONTAINER_CHECK_TTL_MS = 30000;
    if (this._resolvedContainerName && this._lastContainerCheck && (Date.now() - this._lastContainerCheck) < CONTAINER_CHECK_TTL_MS) return;

    if (this._resolvedContainerName && await this._isRunning(this._resolvedContainerName)) {
      this._lastContainerCheck = Date.now();
      return;
    }

    const previousContainer = this._resolvedContainerName;

    this._resolvedContainerName = await this._discoverContainer();
    this._lastContainerCheck = Date.now();
    console.log(`📦 [Sandbox] Connected to Swarm sandbox container: ${this._resolvedContainerName}`);

    if (previousContainer && previousContainer !== this._resolvedContainerName) {
      console.warn(`⚠️ [Sandbox] Container changed from "${previousContainer}" to "${this._resolvedContainerName}" — marking all agent users for re-creation`);
      for (const [agentId, entry] of this.agentUsers.entries()) {
        entry._userVerified = false;
      }
    }
  }

  async _discoverContainer() {
    const filter = this.sandboxServiceFilter;
    try {
      const { stdout } = await execAsync(
        `docker ps --filter "name=${filter}" --filter "status=running" --format "{{.Names}}"`,
        { timeout: 5000 }
      );
      const names = stdout.trim().split('\n').filter(Boolean);
      console.log(`📦 [Sandbox] Discovered containers for filter "${filter}": [${names.join(', ')}]`);
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

    const sshDir = this._sh(`${home}/.ssh`);
    await this._execAsRoot(
      `mkdir -p ${sshDir} && cp /root/.ssh/* ${sshDir}/ 2>/dev/null; chown -R ${userEsc}:${userEsc} ${sshDir} && chmod 700 ${sshDir} && chmod 600 ${sshDir}/* 2>/dev/null; true`
    );

    const knownHosts = `${home}/.ssh/known_hosts`;
    await this._execAsRoot(
      `grep -q 'github.com' ${this._sh(knownHosts)} 2>/dev/null || ssh-keyscan -t ed25519,rsa github.com >> ${this._sh(knownHosts)} 2>/dev/null; chown ${userEsc}:${userEsc} ${this._sh(knownHosts)}; true`
    );

    const sshConfig = `${home}/.ssh/config`;
    await this._execAsRoot(
      `if [ ! -f ${this._sh(sshConfig)} ] || ! grep -q StrictHostKeyChecking ${this._sh(sshConfig)} 2>/dev/null; then echo -e "Host github.com\\n  StrictHostKeyChecking accept-new\\n  UserKnownHostsFile ${knownHosts}" >> ${this._sh(sshConfig)} && chown ${userEsc}:${userEsc} ${this._sh(sshConfig)} && chmod 600 ${this._sh(sshConfig)}; fi`
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
    const targetEsc = this._sh(target);

    try {
      const { stdout } = await this._execAsAgentUser(
        username,
        `test -d ${targetEsc}/.git && echo "exists" || echo "missing"`,
        { timeout: 5000 }
      );
      if (stdout.trim() === 'exists') {
        console.log(`📦 [Sandbox] Project "${project}" already exists for "${username}" — pulling latest`);
        await this._execAsAgentUser(
          username,
          `cd ${targetEsc} && git clean -fd && git fetch origin && git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)`,
          { timeout: 60000 }
        );
        return;
      }
    } catch {
      // Could not check — fall through to clone
    }

    await this._execAsRoot(`rm -rf ${targetEsc}`);
    await this._execAsRoot(`mkdir -p ${this._sh(workspace)} && chown -R ${userEsc}:${userEsc} ${this._sh(workspace)}`);

    await this._execAsRoot(
      `grep -q 'github.com' /root/.ssh/known_hosts 2>/dev/null || grep -q 'github.com' /etc/ssh/ssh_known_hosts 2>/dev/null || ssh-keyscan -t ed25519,rsa github.com >> /etc/ssh/ssh_known_hosts 2>/dev/null; true`
    );

    await this._execAsRoot(
      `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/etc/ssh/ssh_known_hosts" git clone ${this._sh(gitUrl)} ${targetEsc}`,
      { timeout: 120000 }
    );
    await this._execAsRoot(`chown -R ${userEsc}:${userEsc} ${targetEsc}`);

    const gitName = process.env.GIT_USER_NAME || 'PulsarTeam';
    const gitEmail = process.env.GIT_USER_EMAIL || 'agent@pulsarteam.local';
    await this._execAsAgentUser(username, `git config user.name ${this._sh(gitName)}`, { cwd: target });
    await this._execAsAgentUser(username, `git config user.email ${this._sh(gitEmail)}`, { cwd: target });
  }

  async _execPipedAsUser(username, innerCmd, stdinContent) {
    const runPiped = (containerName) => new Promise((resolve, reject) => {
      const proc = exec(
        `docker exec -i -u ${this._sh(username)} ${this._sh(containerName)} /bin/bash -c ${this._sh(innerCmd)}`,
        { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        }
      );
      proc.stdin.write(stdinContent);
      proc.stdin.end();
    });

    try {
      return await runPiped(this._resolvedContainerName);
    } catch (err) {
      if (err.message && err.message.includes('no matching entries in passwd')) {
        console.warn(`⚠️ [Sandbox] User "${username}" not found in container — re-creating user and retrying...`);
        await this._ensureSharedContainerRunning();
        await this._ensureLinuxUser(username);
        await this._ensureAgentWorkspace(username);
        return runPiped(this._resolvedContainerName);
      }
      throw err;
    }
  }

  async _execAsRoot(command, { timeout = 120000 } = {}) {
    const preview = command.length > 200 ? command.slice(0, 200) + '...' : command;
    console.log(`📦 [Sandbox:root] ${preview}`);
    const cmd = `docker exec ${this._sh(this._resolvedContainerName)} /bin/bash -c ${this._sh(command)}`;
    const start = Date.now();
    try {
      const result = await execAsync(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
      console.log(`📦 [Sandbox:root] ✓ ${Date.now() - start}ms`);
      return result;
    } catch (err) {
      console.error(`📦 [Sandbox:root] ✗ ${Date.now() - start}ms — ${err.message.slice(0, 200)}`);
      throw err;
    }
  }

  async _execAsAgentUser(username, command, { cwd = null, timeout = 120000 } = {}) {
    const cwdArg = cwd ? `-w ${this._sh(cwd)}` : '';
    const homeArg = `-e HOME=/home/${username}`;
    const preview = command.length > 200 ? command.slice(0, 200) + '...' : command;
    console.log(`📦 [Sandbox:${username}] ${preview}${cwd ? ` (cwd=${cwd})` : ''}`);
    const cmd = `docker exec ${homeArg} ${cwdArg} -u ${this._sh(username)} ${this._sh(this._resolvedContainerName)} /bin/bash -c ${this._sh(command)}`;
    const start = Date.now();
    try {
      const result = await execAsync(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
      console.log(`📦 [Sandbox:${username}] ✓ ${Date.now() - start}ms`);
      return result;
    } catch (err) {
      if (err.message && err.message.includes('no matching entries in passwd')) {
        console.warn(`⚠️ [Sandbox] User "${username}" not found in container — re-creating user and retrying...`);
        await this._ensureSharedContainerRunning();
        await this._ensureLinuxUser(username);
        await this._ensureAgentWorkspace(username);
        for (const entry of this.agentUsers.values()) {
          if (entry.username === username) entry._userVerified = true;
        }
        const retryCmd = `docker exec ${homeArg} ${cwdArg} -u ${this._sh(username)} ${this._sh(this._resolvedContainerName)} /bin/bash -c ${this._sh(command)}`;
        console.log(`📦 [Sandbox:${username}] Retrying after user re-creation...`);
        return execAsync(retryCmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
      }
      console.error(`📦 [Sandbox:${username}] ✗ ${Date.now() - start}ms — ${err.message.slice(0, 200)}`);
      throw err;
    }
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

  async cleanupOrphans() {
    // Container lifecycle is managed by Docker Swarm — nothing to clean up
  }
}

