/**
 * Unified Git Provider — aggregates repos from multiple GitHub/GitLab connections.
 *
 * Connections are stored in the `settings` table as JSON under key `gitConnections`.
 * Falls back to GITHUB_TOKEN/GITHUB_USER env vars for backward compatibility.
 *
 * Each connection: {
 *   id, provider ('github'|'gitlab'), name, token, user,
 *   url (base URL), filterMode ('starred'|'owned'|'all'|'group'),
 *   filterValue (group/org name), enabled
 * }
 */

import { getPool } from './database.js';
import { randomUUID } from 'crypto';
import { readSecret } from '../secrets.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitConnection {
  id: string;
  provider: 'github' | 'gitlab';
  name: string;
  token: string;
  user: string;        // GitHub user or GitLab username
  url: string;         // API base URL (https://api.github.com or https://gitlab.com/api/v4)
  filterMode: 'starred' | 'owned' | 'all' | 'group';
  filterValue: string; // group/org name when filterMode is 'group'
  enabled: boolean;
}

export interface RepoInfo {
  name: string;
  fullName: string;
  sshUrl: string;
  httpsUrl: string;
  htmlUrl: string;
  description: string;
  defaultBranch: string;
  provider: 'github' | 'gitlab';
  connectionId: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL = parseInt(process.env.GITHUB_CACHE_TTL_MS, 10) || 15 * 60 * 1000;
let _cache: RepoInfo[] | null = null;
let _cacheTime = 0;
let _fetchLock: Promise<RepoInfo[]> | null = null;

// ── Connection management ────────────────────────────────────────────────────

export async function getGitConnections(): Promise<GitConnection[]> {
  const pool = getPool();
  if (!pool) return _envFallbackConnections();

  try {
    const result = await pool.query(`SELECT value FROM settings WHERE key = 'gitConnections'`);
    if (result.rows.length && result.rows[0].value) {
      const connections = JSON.parse(result.rows[0].value);
      if (Array.isArray(connections) && connections.length > 0) return connections;
    }
  } catch (err) {
    console.error('[GitProvider] Failed to read connections from DB:', err.message);
  }

  // Fallback to env vars
  return _envFallbackConnections();
}

function _envFallbackConnections(): GitConnection[] {
  const token = readSecret('GITHUB_TOKEN');
  const user = process.env.GITHUB_USER;
  if (!token || !user) return [];

  return [{
    id: 'env-github',
    provider: 'github',
    name: 'GitHub (env)',
    token,
    user,
    url: 'https://api.github.com',
    filterMode: 'starred',
    filterValue: '',
    enabled: true,
  }];
}

export async function saveGitConnections(connections: GitConnection[]): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  // Ensure each connection has an id
  for (const c of connections) {
    if (!c.id) c.id = randomUUID();
  }

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('gitConnections', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(connections)]
  );

  // Invalidate cache
  invalidateCache();
}

/**
 * Return connections with tokens masked for safe frontend display.
 */
export function maskConnections(connections: GitConnection[]): any[] {
  return connections.map(c => ({
    ...c,
    token: c.token ? `${c.token.slice(0, 6)}${'*'.repeat(Math.max(0, c.token.length - 10))}${c.token.slice(-4)}` : '',
  }));
}

// ── Repo listing ─────────────────────────────────────────────────────────────

export async function listRepos(): Promise<RepoInfo[]> {
  // Return cached result if fresh
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  // Deduplicate concurrent calls
  if (_fetchLock) return _fetchLock;

  _fetchLock = _fetchAllRepos();
  try {
    return await _fetchLock;
  } finally {
    _fetchLock = null;
  }
}

async function _fetchAllRepos(): Promise<RepoInfo[]> {
  const connections = await getGitConnections();
  const enabled = connections.filter(c => c.enabled && c.token);

  if (enabled.length === 0) {
    console.warn('⚠️  No enabled git connections — cannot list projects');
    return _cache || [];
  }

  try {
    const results = await Promise.allSettled(
      enabled.map(conn =>
        conn.provider === 'gitlab'
          ? _fetchGitLabRepos(conn)
          : _fetchGitHubRepos(conn)
      )
    );

    const repos: RepoInfo[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        repos.push(...result.value);
      } else {
        console.error('[GitProvider] Failed to fetch repos from a connection:', result.reason?.message);
      }
    }

    // Deduplicate by name (prefer first occurrence)
    const seen = new Set<string>();
    const deduped: RepoInfo[] = [];
    for (const repo of repos) {
      if (!seen.has(repo.name)) {
        seen.add(repo.name);
        deduped.push(repo);
      }
    }

    if (deduped.length > 0 || !_cache) {
      _cache = deduped;
    }
    _cacheTime = Date.now();
    return _cache;
  } catch (err) {
    console.error('[GitProvider] Failed to fetch repos:', err.message);
    return _cache || [];
  }
}

// ── GitHub fetch ─────────────────────────────────────────────────────────────

async function _fetchGitHubRepos(conn: GitConnection): Promise<RepoInfo[]> {
  const baseUrl = conn.url || 'https://api.github.com';
  const headers: any = {
    Authorization: `Bearer ${conn.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let apiUrl: string;

  switch (conn.filterMode) {
    case 'starred':
      apiUrl = `${baseUrl}/users/${conn.user}/starred`;
      break;
    case 'owned':
      apiUrl = `${baseUrl}/user/repos?affiliation=owner&sort=updated`;
      break;
    case 'group':
      apiUrl = `${baseUrl}/orgs/${conn.filterValue || conn.user}/repos?sort=updated`;
      break;
    case 'all':
    default:
      apiUrl = `${baseUrl}/user/repos?sort=updated`;
      break;
  }

  const repos: RepoInfo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const sep = apiUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${apiUrl}${sep}per_page=${perPage}&page=${page}`, { headers });

    if (!res.ok) {
      console.error(`[GitProvider] GitHub API error for "${conn.name}": ${res.status} ${res.statusText}`);
      break;
    }

    const data = await res.json();
    if (!data.length) break;

    for (const repo of data) {
      repos.push({
        name: repo.name,
        fullName: repo.full_name,
        sshUrl: repo.ssh_url,
        httpsUrl: repo.clone_url,
        htmlUrl: repo.html_url,
        description: repo.description || '',
        defaultBranch: repo.default_branch || 'main',
        provider: 'github',
        connectionId: conn.id,
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  return repos;
}

// ── GitLab fetch ─────────────────────────────────────────────────────────────

async function _fetchGitLabRepos(conn: GitConnection): Promise<RepoInfo[]> {
  const baseUrl = (conn.url || 'https://gitlab.com/api/v4').replace(/\/+$/, '');
  const headers: any = {
    'PRIVATE-TOKEN': conn.token,
  };

  let apiUrl: string;

  switch (conn.filterMode) {
    case 'starred':
      apiUrl = `${baseUrl}/projects?starred=true&simple=true&order_by=updated_at`;
      break;
    case 'owned':
      apiUrl = `${baseUrl}/projects?owned=true&simple=true&order_by=updated_at`;
      break;
    case 'group':
      apiUrl = `${baseUrl}/groups/${encodeURIComponent(conn.filterValue || conn.user)}/projects?simple=true&order_by=updated_at&include_subgroups=true`;
      break;
    case 'all':
    default:
      apiUrl = `${baseUrl}/projects?membership=true&simple=true&order_by=updated_at`;
      break;
  }

  const repos: RepoInfo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const sep = apiUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${apiUrl}${sep}per_page=${perPage}&page=${page}`, { headers });

    if (!res.ok) {
      console.error(`[GitProvider] GitLab API error for "${conn.name}": ${res.status} ${res.statusText}`);
      break;
    }

    const data = await res.json();
    if (!data.length) break;

    for (const project of data) {
      repos.push({
        name: project.name,
        fullName: project.path_with_namespace,
        sshUrl: project.ssh_url_to_repo,
        httpsUrl: project.http_url_to_repo,
        htmlUrl: project.web_url,
        description: project.description || '',
        defaultBranch: project.default_branch || 'main',
        provider: 'gitlab',
        connectionId: conn.id,
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  return repos;
}

// ── Utility functions ────────────────────────────────────────────────────────

/**
 * Get the git clone URL for a specific project name.
 */
export async function getProjectGitUrl(projectName: string): Promise<string | null> {
  const repos = await listRepos();
  const repo = repos.find(r => r.name === projectName);
  return repo?.sshUrl || null;
}

/**
 * Get the connection for a specific project (needed for API calls like commits/branches).
 */
export async function getConnectionForProject(projectName: string): Promise<{ connection: GitConnection; repo: RepoInfo } | null> {
  const repos = await listRepos();
  const repo = repos.find(r => r.name === projectName);
  if (!repo) return null;

  const connections = await getGitConnections();
  const connection = connections.find(c => c.id === repo.connectionId);
  if (!connection) return null;

  return { connection, repo };
}

/**
 * Invalidate the cache.
 */
export function invalidateCache() {
  _cache = null;
  _cacheTime = 0;
}

/**
 * Create a new GitHub repo from the BoilerPlate template, then star it.
 * Only works with GitHub connections.
 */
export async function createProjectFromBoilerplate(name: string, description = '', isPrivate = false) {
  const connections = await getGitConnections();
  const ghConn = connections.find(c => c.provider === 'github' && c.enabled && c.token);

  if (!ghConn) {
    throw new Error('No active GitHub connection configured');
  }

  const baseUrl = ghConn.url || 'https://api.github.com';
  const user = ghConn.user;
  const templateOwner = process.env.BOILERPLATE_OWNER || user;
  const templateRepo = process.env.BOILERPLATE_REPO || 'BoilerPlate';

  const headers: any = {
    Authorization: `Bearer ${ghConn.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Generate repo from template
  const genRes = await fetch(
    `${baseUrl}/repos/${templateOwner}/${templateRepo}/generate`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: user,
        name,
        description,
        private: isPrivate,
        include_all_branches: false,
      }),
    }
  );

  if (!genRes.ok) {
    const err: any = await genRes.json().catch(() => ({}));
    const msg = err.message || err.errors?.map((e: any) => e.message).join(', ') || genRes.statusText;
    throw new Error(`GitHub: failed to create repo — ${msg}`);
  }

  const repo = await genRes.json();

  // 2. Star the new repo so it appears in starred list
  if (ghConn.filterMode === 'starred') {
    const starRes = await fetch(
      `${baseUrl}/user/starred/${user}/${name}`,
      { method: 'PUT', headers: { ...headers, 'Content-Length': '0' } }
    );
    if (!starRes.ok) {
      console.warn(`Warning: created repo ${name} but failed to star it (${starRes.status})`);
    }
  }

  // 3. Invalidate cache
  invalidateCache();

  return {
    name: repo.name,
    fullName: repo.full_name,
    sshUrl: repo.ssh_url,
    htmlUrl: repo.html_url,
    description: repo.description || '',
    defaultBranch: repo.default_branch || 'main',
  };
}

/**
 * Test a git connection by making a lightweight API call.
 */
export async function testConnection(conn: GitConnection): Promise<{ ok: boolean; message: string }> {
  try {
    if (conn.provider === 'github') {
      const baseUrl = conn.url || 'https://api.github.com';
      const res = await fetch(`${baseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${conn.token}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (!res.ok) return { ok: false, message: `GitHub API returned ${res.status}: ${res.statusText}` };
      const data = await res.json();
      return { ok: true, message: `Connected as ${data.login}` };
    } else {
      const baseUrl = (conn.url || 'https://gitlab.com/api/v4').replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/user`, {
        headers: { 'PRIVATE-TOKEN': conn.token },
      });
      if (!res.ok) return { ok: false, message: `GitLab API returned ${res.status}: ${res.statusText}` };
      const data = await res.json();
      return { ok: true, message: `Connected as ${data.username}` };
    }
  } catch (err) {
    return { ok: false, message: `Connection failed: ${err.message}` };
  }
}
