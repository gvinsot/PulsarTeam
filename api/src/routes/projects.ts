import express from 'express';
import { listRepos, invalidateCache, createProjectFromBoilerplate } from '../services/gitProvider.js';
import { readSecret } from '../secrets.js';

// In-memory cache for GitHub activity data (TTL 1h)
const ACTIVITY_CACHE_TTL = 60 * 60 * 1000;
const _activityCache = new Map();

// In-memory cache for repo explorer (branches, tree, file content)
const BRANCHES_CACHE_TTL = 15 * 60 * 1000; // 15 min
const TREE_CACHE_TTL = 5 * 60 * 1000;      // 5 min
const FILE_CACHE_TTL = 5 * 60 * 1000;      // 5 min
const _branchesCache = new Map();
const _treeCache = new Map();
const _fileCache = new Map();

export function projectRoutes() {
  const router = express.Router();

  // List available projects (from all git connections)
  router.get('/', async (req, res) => {
    try {
      const repos = await listRepos();
      const projects = repos.map(r => ({
        name: r.name,
        fullName: r.fullName,
        gitUrl: r.sshUrl,
        htmlUrl: r.htmlUrl,
        description: r.description,
        defaultBranch: r.defaultBranch,
        provider: r.provider,
      }));
      res.json(projects);
    } catch (err) {
      console.error('Failed to list projects:', err);
      res.json([]);
    }
  });

  // Create a new project (GitHub repo from BoilerPlate template)
  router.post('/', async (req, res) => {
    try {
      const { name, description, isPrivate } = req.body;
      if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name.trim())) {
        return res.status(400).json({ error: 'Invalid project name. Use only letters, numbers, hyphens, dots, and underscores.' });
      }
      const result = await createProjectFromBoilerplate(name.trim(), description || '', !!isPrivate);
      res.json(result);
    } catch (err) {
      console.error('Failed to create project:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Force refresh the project cache
  router.post('/refresh', (req, res) => {
    invalidateCache();
    res.json({ success: true });
  });

  // Get GitHub activity (commits + tags) for a repo
  router.get('/github-activity/:owner/:repo', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) {
      return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });
    }

    const { owner, repo } = req.params;
    const cacheKey = `${owner}/${repo}`;

    // Return cached data if fresh
    const cached = _activityCache.get(cacheKey);
    if (cached && Date.now() - cached.time < ACTIVITY_CACHE_TTL) {
      return res.json(cached.data);
    }

    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      // Fetch commits (last 30 days) and tags in parallel
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [commitsRes, tagsRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=50`, { headers }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=20`, { headers }),
      ]);

      let commits = [];
      let tags = [];

      if (commitsRes.ok) {
        const commitsData = await commitsRes.json();
        commits = commitsData.map(c => ({
          sha: c.sha,
          shortSha: c.sha.substring(0, 7),
          message: c.commit.message.split('\n')[0],
          author: c.commit.author?.name || c.author?.login || 'Unknown',
          authorAvatar: c.author?.avatar_url || null,
          date: c.commit.author?.date || c.commit.committer?.date,
          url: c.html_url,
        }));
      }

      if (tagsRes.ok) {
        const tagsData = await tagsRes.json();
        tags = tagsData.map(t => ({
          name: t.name,
          sha: t.commit.sha,
          shortSha: t.commit.sha.substring(0, 7),
          url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(t.name)}`,
        }));
      }

      const data = { commits, tags, fetchedAt: new Date().toISOString() };
      _activityCache.set(cacheKey, { data, time: Date.now() });
      res.json(data);
    } catch (err) {
      console.error(`Failed to fetch GitHub activity for ${owner}/${repo}:`, err.message);
      // Return stale cache on error
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch GitHub activity' });
    }
  });

  // ── Repo Explorer endpoints ────────────────────────────────────────────

  const ghHeaders = () => ({
    Authorization: `Bearer ${readSecret('GITHUB_TOKEN')}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  // List branches for a repo
  router.get('/github-branches/:owner/:repo', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });

    const { owner, repo } = req.params;
    const cacheKey = `branches:${owner}/${repo}`;
    const cached = _branchesCache.get(cacheKey);
    if (cached && Date.now() - cached.time < BRANCHES_CACHE_TTL) {
      return res.json(cached.data);
    }

    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
        { headers: ghHeaders() }
      );
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
      const data = await ghRes.json();
      const branches = data.map(b => ({ name: b.name, sha: b.commit.sha }));
      _branchesCache.set(cacheKey, { data: branches, time: Date.now() });
      res.json(branches);
    } catch (err) {
      console.error(`Failed to fetch branches for ${owner}/${repo}:`, err.message);
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch branches' });
    }
  });

  // Get file tree for a given ref (branch/tag/sha)
  router.get('/github-tree/:owner/:repo/:ref', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });

    const { owner, repo, ref } = req.params;
    const cacheKey = `tree:${owner}/${repo}:${ref}`;
    const cached = _treeCache.get(cacheKey);
    if (cached && Date.now() - cached.time < TREE_CACHE_TTL) {
      return res.json(cached.data);
    }

    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
        { headers: ghHeaders() }
      );
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
      const data = await ghRes.json();
      const tree = (data.tree || []).map(item => ({
        path: item.path,
        type: item.type,   // 'blob' or 'tree'
        size: item.size || 0,
        sha: item.sha,
      }));
      const result = { tree, truncated: !!data.truncated };
      _treeCache.set(cacheKey, { data: result, time: Date.now() });
      res.json(result);
    } catch (err) {
      console.error(`Failed to fetch tree for ${owner}/${repo}@${ref}:`, err.message);
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch file tree' });
    }
  });

  // Get file content for a given path and ref
  router.get('/github-file/:owner/:repo/:ref/*', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });

    const { owner, repo, ref } = req.params;
    const filePath = req.params[0]; // wildcard captures the rest
    if (!filePath) return res.status(400).json({ error: 'File path required' });

    const cacheKey = `file:${owner}/${repo}:${ref}:${filePath}`;
    const cached = _fileCache.get(cacheKey);
    if (cached && Date.now() - cached.time < FILE_CACHE_TTL) {
      return res.json(cached.data);
    }

    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
        { headers: ghHeaders() }
      );
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
      const data = await ghRes.json();

      // GitHub returns base64-encoded content for files
      let content = null;
      let isBinary = false;
      if (data.encoding === 'base64' && data.content) {
        try {
          content = Buffer.from(data.content, 'base64').toString('utf-8');
        } catch {
          isBinary = true;
        }
      } else if (data.type === 'file' && data.download_url) {
        // Large files: fetch via download_url
        isBinary = true;
      }

      const result = {
        name: data.name,
        path: data.path,
        size: data.size,
        type: data.type,
        content,
        isBinary,
        htmlUrl: data.html_url,
        downloadUrl: data.download_url,
      };
      _fileCache.set(cacheKey, { data: result, time: Date.now() });
      res.json(result);
    } catch (err) {
      console.error(`Failed to fetch file ${filePath} for ${owner}/${repo}@${ref}:`, err.message);
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch file content' });
    }
  });

  return router;
}
