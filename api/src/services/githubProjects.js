/**
 * Discover available projects by listing GitHub starred repos.
 * Replaces the old filesystem scan of /projects.
 *
 * Caching strategy:
 * - In-memory cache with configurable TTL (default 15 min)
 * - HTTP conditional requests via ETag (304 Not Modified saves bandwidth & rate limits)
 * - Stale cache served on error (resilience)
 */

const CACHE_TTL = parseInt(process.env.GITHUB_CACHE_TTL_MS, 10) || 15 * 60 * 1000; // 15 minutes default
let _cache = null;
let _cacheTime = 0;
let _etags = {};       // page -> ETag header from last successful response
let _fetchLock = null;  // dedup concurrent calls

/**
 * List starred repos for the configured GitHub user.
 * Returns [{ name, sshUrl, httpsUrl, description }]
 */
export async function listStarredRepos() {
  const token = process.env.GITHUB_TOKEN;
  const user = process.env.GITHUB_USER;
  if (!token || !user) {
    console.warn('⚠️  GITHUB_TOKEN or GITHUB_USER not set — cannot list projects');
    return [];
  }

  // Return cached result if fresh
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  // Deduplicate concurrent calls — only one fetch at a time
  if (_fetchLock) return _fetchLock;

  _fetchLock = _fetchStarredRepos(token, user);
  try {
    return await _fetchLock;
  } finally {
    _fetchLock = null;
  }
}

async function _fetchStarredRepos(token, user) {
  try {
    const repos = [];
    let page = 1;
    const perPage = 100;
    let allUnchanged = true;

    while (true) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      // Use conditional request if we have a cached ETag for this page
      if (_etags[page]) {
        headers['If-None-Match'] = _etags[page];
      }

      const res = await fetch(
        `https://api.github.com/users/${user}/starred?per_page=${perPage}&page=${page}`,
        { headers }
      );

      // Store ETag for future conditional requests
      const etag = res.headers.get('etag');
      if (etag) _etags[page] = etag;

      if (res.status === 304) {
        // Not Modified — cache is still valid
        if (_cache) {
          _cacheTime = Date.now();
          return _cache;
        }
        // Shouldn't happen, but fall through to normal fetch if no cache
        allUnchanged = false;
      }

      if (!res.ok && res.status !== 304) {
        console.error(`GitHub API error: ${res.status} ${res.statusText}`);
        break;
      }

      if (res.status !== 304) {
        allUnchanged = false;
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
          });
        }

        if (data.length < perPage) break;
      }

      page++;
    }

    if (repos.length > 0 || !_cache) {
      _cache = repos;
    }
    _cacheTime = Date.now();
    return _cache;
  } catch (err) {
    console.error('Failed to fetch starred repos:', err.message);
    // Serve stale cache on error for resilience
    return _cache || [];
  }
}

/**
 * Get the git clone URL for a specific project name.
 * Returns the SSH URL (for cloning with SSH keys).
 */
export async function getProjectGitUrl(projectName) {
  const repos = await listStarredRepos();
  const repo = repos.find(r => r.name === projectName);
  return repo?.sshUrl || null;
}

/**
 * Create a new GitHub repository from the BoilerPlate template, then star it
 * so it appears in the projects list.
 *
 * Uses the GitHub "Generate from template" API:
 *   POST /repos/{template_owner}/{template_repo}/generate
 *
 * @param {string} name - The name for the new repository
 * @param {string} [description] - Optional description
 * @param {boolean} [isPrivate] - Whether the repo should be private (default: false)
 * @returns {{ name, fullName, sshUrl, htmlUrl }} the created repo info
 */
export async function createProjectFromBoilerplate(name, description = '', isPrivate = false) {
  const token = process.env.GITHUB_TOKEN;
  const user = process.env.GITHUB_USER;
  if (!token || !user) {
    throw new Error('GITHUB_TOKEN or GITHUB_USER not configured');
  }

  const templateOwner = process.env.BOILERPLATE_OWNER || user;
  const templateRepo = process.env.BOILERPLATE_REPO || 'BoilerPlate';

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Generate repo from template
  const genRes = await fetch(
    `https://api.github.com/repos/${templateOwner}/${templateRepo}/generate`,
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
    const err = await genRes.json().catch(() => ({}));
    const msg = err.message || err.errors?.map(e => e.message).join(', ') || genRes.statusText;
    throw new Error(`GitHub: failed to create repo — ${msg}`);
  }

  const repo = await genRes.json();

  // 2. Star the new repo so it appears in the projects list
  const starRes = await fetch(
    `https://api.github.com/user/starred/${user}/${name}`,
    { method: 'PUT', headers: { ...headers, 'Content-Length': '0' } }
  );
  if (!starRes.ok) {
    console.warn(`Warning: created repo ${name} but failed to star it (${starRes.status})`);
  }

  // 3. Invalidate cache so the new project shows up immediately
  invalidateProjectCache();

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
 * Invalidate the cache (e.g. after starring a new repo).
 */
export function invalidateProjectCache() {
  _cache = null;
  _cacheTime = 0;
  _etags = {};
}
