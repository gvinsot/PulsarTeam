import express from 'express';
import { listStarredRepos, invalidateProjectCache } from '../services/githubProjects.js';

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
        description: r.description
      }));
      res.json(projects);
    } catch (err) {
      console.error('Failed to list projects:', err);
      res.json([]);
    }
  });

  // Force refresh the project cache
  router.post('/refresh', (req, res) => {
    invalidateProjectCache();
    res.json({ success: true });
  });

  return router;
}
