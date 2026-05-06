import express from 'express';
import { z } from 'zod';
import {
  getAllProjects, getProjectById, getProjectByName, createProject, updateProject, deleteProject,
  getBoardsForProject, setBoardProject,
  getReposForBoard, getReposForProject, createBoardRepo, deleteBoardRepo,
  getStoragesForBoard, getStoragesForProject, createBoardStorage, deleteBoardStorage,
  getBoardById,
} from '../services/database.js';
import { listRepos } from '../services/gitProvider.js';
import { readSecret } from '../secrets.js';

// ── In-memory caches for GitHub explorer endpoints ─────────────────────────
const ACTIVITY_CACHE_TTL = 60 * 60 * 1000;
const BRANCHES_CACHE_TTL = 15 * 60 * 1000;
const TREE_CACHE_TTL = 5 * 60 * 1000;
const FILE_CACHE_TTL = 5 * 60 * 1000;
const _activityCache = new Map<string, { data: any; time: number }>();
const _branchesCache = new Map<string, { data: any; time: number }>();
const _treeCache = new Map<string, { data: any; time: number }>();
const _fileCache = new Map<string, { data: any; time: number }>();

const projectNameSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_\- .]+$/, 'Invalid project name');
const projectBodySchema = z.object({
  name: projectNameSchema,
  description: z.string().max(10000).optional().default(''),
  rules: z.string().max(10000).optional().default(''),
});
const projectUpdateSchema = z.object({
  name: projectNameSchema.optional(),
  description: z.string().max(10000).optional(),
  rules: z.string().max(10000).optional(),
});
const repoBodySchema = z.object({
  provider: z.enum(['github', 'gitlab']),
  fullName: z.string().min(1).max(200),
  htmlUrl: z.string().url().max(500).optional().or(z.literal('')).default(''),
  defaultBranch: z.string().max(100).optional().default(''),
});
const storageBodySchema = z.object({
  provider: z.enum(['onedrive', 'google_drive']),
  displayName: z.string().min(1).max(200),
  path: z.string().max(500).optional().default(''),
  rootId: z.string().max(200).optional().default(''),
});

export function projectRoutes() {
  const router = express.Router();

  // ── DB-backed projects CRUD ──────────────────────────────────────────────

  router.get('/', async (req: any, res) => {
    try {
      const projects = await getAllProjects();
      // Enrich with board/repo/storage counts
      const enriched = await Promise.all(projects.map(async p => {
        const boards = await getBoardsForProject(p.id);
        const repos = await getReposForProject(p.id);
        const storages = await getStoragesForProject(p.id);
        return {
          ...p,
          boardCount: boards.length,
          repoCount: repos.length,
          storageCount: storages.length,
        };
      }));
      res.json(enriched);
    } catch (err: any) {
      console.error('Failed to list projects:', err.message);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  router.get('/:id', async (req: any, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const boards = await getBoardsForProject(project.id);
      const repos = await getReposForProject(project.id);
      const storages = await getStoragesForProject(project.id);
      res.json({ ...project, boards, repos, storages });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req: any, res) => {
    try {
      const body = projectBodySchema.parse(req.body);
      const existing = await getProjectByName(body.name);
      if (existing) return res.status(409).json({ error: 'A project with this name already exists' });
      const project = await createProject(body.name, body.description, body.rules, req.user?.userId || null);
      res.status(201).json(project);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req: any, res) => {
    try {
      const body = projectUpdateSchema.parse(req.body);
      const updated = await updateProject(req.params.id, body);
      if (!updated) return res.status(404).json({ error: 'Project not found' });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req: any, res) => {
    try {
      const ok = await deleteProject(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Project not found' });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Project ↔ Board linking ──────────────────────────────────────────────

  router.get('/:id/boards', async (req, res) => {
    try {
      const boards = await getBoardsForProject(req.params.id);
      res.json(boards);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/boards/:boardId', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const board = await getBoardById(req.params.boardId);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      await setBoardProject(req.params.boardId, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id/boards/:boardId', async (req, res) => {
    try {
      await setBoardProject(req.params.boardId, null);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Board repos / storages (mounted under /projects for cohesion) ────────

  router.get('/boards/:boardId/repos', async (req, res) => {
    try {
      res.json(await getReposForBoard(req.params.boardId));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/boards/:boardId/repos', async (req, res) => {
    try {
      const body = repoBodySchema.parse(req.body);
      const board = await getBoardById(req.params.boardId);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      const repo = await createBoardRepo(
        req.params.boardId,
        body.provider,
        body.fullName,
        body.htmlUrl || null,
        body.defaultBranch || null
      );
      res.status(201).json(repo);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/boards/:boardId/repos/:repoId', async (req, res) => {
    try {
      const ok = await deleteBoardRepo(req.params.repoId);
      if (!ok) return res.status(404).json({ error: 'Repo not found' });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/boards/:boardId/storages', async (req, res) => {
    try {
      res.json(await getStoragesForBoard(req.params.boardId));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/boards/:boardId/storages', async (req, res) => {
    try {
      const body = storageBodySchema.parse(req.body);
      const board = await getBoardById(req.params.boardId);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      const storage = await createBoardStorage(
        req.params.boardId,
        body.provider,
        body.displayName,
        body.path || null,
        body.rootId || null
      );
      res.status(201).json(storage);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/boards/:boardId/storages/:storageId', async (req, res) => {
    try {
      const ok = await deleteBoardStorage(req.params.storageId);
      if (!ok) return res.status(404).json({ error: 'Storage not found' });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Helper: list available repos from configured git connections ─────────
  // Used by the UI to populate a picker when attaching a repo to a board.
  router.get('/available-repos', async (req, res) => {
    try {
      const repos = await listRepos();
      res.json(repos.map(r => ({
        provider: r.provider,
        fullName: r.fullName,
        htmlUrl: r.htmlUrl,
        defaultBranch: r.defaultBranch,
        description: r.description,
      })));
    } catch (err: any) {
      console.error('Failed to list available repos:', err.message);
      res.json([]);
    }
  });

  // ── GitHub repo explorer (used by repo detail UI) ────────────────────────

  const ghHeaders = () => ({
    Authorization: `Bearer ${readSecret('GITHUB_TOKEN')}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });

  router.get('/github-activity/:owner/:repo', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });

    const { owner, repo } = req.params;
    const cacheKey = `${owner}/${repo}`;
    const cached = _activityCache.get(cacheKey);
    if (cached && Date.now() - cached.time < ACTIVITY_CACHE_TTL) return res.json(cached.data);

    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [commitsRes, tagsRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=50`, { headers: ghHeaders() }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=20`, { headers: ghHeaders() }),
      ]);

      let commits: any[] = [];
      let tags: any[] = [];

      if (commitsRes.ok) {
        const commitsData = await commitsRes.json();
        commits = commitsData.map((c: any) => ({
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
        tags = tagsData.map((t: any) => ({
          name: t.name,
          sha: t.commit.sha,
          shortSha: t.commit.sha.substring(0, 7),
          url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(t.name)}`,
        }));
      }

      const data = { commits, tags, fetchedAt: new Date().toISOString() };
      _activityCache.set(cacheKey, { data, time: Date.now() });
      res.json(data);
    } catch (err: any) {
      console.error(`Failed to fetch GitHub activity for ${owner}/${repo}:`, err.message);
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch GitHub activity' });
    }
  });

  router.get('/github-branches/:owner/:repo', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });

    const { owner, repo } = req.params;
    const cacheKey = `branches:${owner}/${repo}`;
    const cached = _branchesCache.get(cacheKey);
    if (cached && Date.now() - cached.time < BRANCHES_CACHE_TTL) return res.json(cached.data);

    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, { headers: ghHeaders() });
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
      const data = await ghRes.json();
      const branches = data.map((b: any) => ({ name: b.name, sha: b.commit.sha }));
      _branchesCache.set(cacheKey, { data: branches, time: Date.now() });
      res.json(branches);
    } catch (err: any) {
      console.error(`Failed to fetch branches for ${owner}/${repo}:`, err.message);
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch branches' });
    }
  });

  router.get('/github-tree/:owner/:repo/:ref', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });

    const { owner, repo, ref } = req.params;
    const cacheKey = `tree:${owner}/${repo}:${ref}`;
    const cached = _treeCache.get(cacheKey);
    if (cached && Date.now() - cached.time < TREE_CACHE_TTL) return res.json(cached.data);

    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, { headers: ghHeaders() });
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
      const data = await ghRes.json();
      const tree = (data.tree || []).map((item: any) => ({
        path: item.path,
        type: item.type,
        size: item.size || 0,
        sha: item.sha,
      }));
      const result = { tree, truncated: !!data.truncated };
      _treeCache.set(cacheKey, { data: result, time: Date.now() });
      res.json(result);
    } catch (err: any) {
      console.error(`Failed to fetch tree for ${owner}/${repo}@${ref}:`, err.message);
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch file tree' });
    }
  });

  router.get('/github-file/:owner/:repo/:ref/*', async (req, res) => {
    const token = readSecret('GITHUB_TOKEN');
    if (!token) return res.status(400).json({ error: 'GITHUB_TOKEN not configured' });

    const { owner, repo, ref } = req.params;
    const filePath = (req.params as any)[0];
    if (!filePath) return res.status(400).json({ error: 'File path required' });

    const cacheKey = `file:${owner}/${repo}:${ref}:${filePath}`;
    const cached = _fileCache.get(cacheKey);
    if (cached && Date.now() - cached.time < FILE_CACHE_TTL) return res.json(cached.data);

    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
        { headers: ghHeaders() }
      );
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
      const data = await ghRes.json();

      let content: string | null = null;
      let isBinary = false;
      if (data.encoding === 'base64' && data.content) {
        try {
          content = Buffer.from(data.content, 'base64').toString('utf-8');
        } catch {
          isBinary = true;
        }
      } else if (data.type === 'file' && data.download_url) {
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
    } catch (err: any) {
      console.error(`Failed to fetch file ${filePath} for ${owner}/${repo}@${ref}:`, err.message);
      if (cached) return res.json(cached.data);
      res.status(500).json({ error: 'Failed to fetch file content' });
    }
  });

  return router;
}
