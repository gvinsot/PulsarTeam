import express from 'express';
import { listStarredRepos, invalidateProjectCache, createProjectFromBoilerplate } from '../services/githubProjects.js';

// In-memory cache for GitHub activity data (TTL 1h)
const ACTIVITY_CACHE_TTL = 60 * 60 * 1000;
const _activityCache = new Map();

export function projectRoutes() {
  const router = express.Router();

  // List available projects (GitHub starred repos)
  router.get('/', async (req, res) => {
    try {
      const repos = await listStarredRepos();
      const projects = repos.map(r => ({
        name: r.name,
        fullName: r.fullName,
        gitUrl: r.sshUrl,
        htmlUrl: r.htmlUrl,
        description: r.description,
        defaultBranch: r.defaultBranch,
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
    invalidateProjectCache();
    res.json({ success: true });
  });

  // Get GitHub activity (commits + tags) for a repo
  router.get('/github-activity/:owner/:repo', async (req, res) => {
    const token = process.env.GITHUB_TOKEN;
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

  return router;
}
