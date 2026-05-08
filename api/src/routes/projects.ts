import express from 'express';
import { z } from 'zod';
import { requireRole, checkBoardAccess, checkProjectAccess } from '../middleware/auth.js';
import {
  getAllProjects, getProjectByName, createProject, updateProject, deleteProject,
  getBoardsForProject, setBoardProject,
  getReposForBoard, getReposForProject, getAccessibleBoardRepos,
  getStoragesForBoard, getStoragesForProject,
  getOAuthToken,
} from '../services/database.js';

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
// Guard for routes whose `:id` must be a UUID — falls through to the next
// matching route when the path segment is a literal (e.g. `available-repos`).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function uuidOnly(handler: any) {
  return (req: any, res: any, next: any) => {
    if (!UUID_RE.test(req.params.id || '')) return next();
    return handler(req, res, next);
  };
}

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

  router.get('/:id', uuidOnly(async (req: any, res: any) => {
    try {
      const access = await checkProjectAccess(req.params.id, req.user?.userId, req.user?.role || 'basic', 'read');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      const project = access.project;
      const boards = await getBoardsForProject(project.id);
      const repos = await getReposForProject(project.id);
      const storages = await getStoragesForProject(project.id);
      res.json({ ...project, boards, repos, storages });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // Mutations require advanced/admin — basic users may not create/modify projects globally.
  router.post('/', requireRole('admin', 'advanced'), async (req: any, res) => {
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

  router.put('/:id', requireRole('admin', 'advanced'), uuidOnly(async (req: any, res: any) => {
    try {
      const access = await checkProjectAccess(req.params.id, req.user?.userId, req.user?.role, 'edit');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      const body = projectUpdateSchema.parse(req.body);
      const updated = await updateProject(req.params.id, body);
      if (!updated) return res.status(404).json({ error: 'Project not found' });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
      res.status(500).json({ error: err.message });
    }
  }));

  router.delete('/:id', requireRole('admin', 'advanced'), uuidOnly(async (req: any, res: any) => {
    try {
      const access = await checkProjectAccess(req.params.id, req.user?.userId, req.user?.role, 'admin');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      const ok = await deleteProject(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Project not found' });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // ── Project ↔ Board linking ──────────────────────────────────────────────

  router.get('/:id/boards', uuidOnly(async (req: any, res: any) => {
    try {
      const access = await checkProjectAccess(req.params.id, req.user?.userId, req.user?.role, 'read');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      const boards = await getBoardsForProject(req.params.id);
      res.json(boards);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  router.post('/:id/boards/:boardId', uuidOnly(async (req: any, res: any) => {
    try {
      // Linking requires edit on both the project AND admin on the board.
      const projectAccess = await checkProjectAccess(req.params.id, req.user?.userId, req.user?.role, 'edit');
      if (!projectAccess.ok) return res.status(projectAccess.status || 403).json({ error: projectAccess.error });
      const boardAccess = await checkBoardAccess(req.params.boardId, req.user?.userId, req.user?.role, 'admin');
      if (!boardAccess.ok) return res.status(boardAccess.status || 403).json({ error: boardAccess.error });
      await setBoardProject(req.params.boardId, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  router.delete('/:id/boards/:boardId', uuidOnly(async (req: any, res: any) => {
    try {
      const projectAccess = await checkProjectAccess(req.params.id, req.user?.userId, req.user?.role, 'edit');
      if (!projectAccess.ok) return res.status(projectAccess.status || 403).json({ error: projectAccess.error });
      const boardAccess = await checkBoardAccess(req.params.boardId, req.user?.userId, req.user?.role, 'admin');
      if (!boardAccess.ok) return res.status(boardAccess.status || 403).json({ error: boardAccess.error });
      await setBoardProject(req.params.boardId, null);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // ── Board storages (mounted under /projects for cohesion) ───────────────
  // Repos used on a board are derived from tasks (see /boards/:id/repos below).

  router.get('/boards/:boardId/repos', async (req: any, res) => {
    try {
      const access = await checkBoardAccess(req.params.boardId, req.user?.userId, req.user?.role, 'read');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      res.json(await getReposForBoard(req.params.boardId));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/boards/:boardId/storages', async (req: any, res) => {
    try {
      const access = await checkBoardAccess(req.params.boardId, req.user?.userId, req.user?.role, 'read');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      res.json(await getStoragesForBoard(req.params.boardId));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── (Global) repos pool used by agent pickers (Add Agent, Broadcast) ─────
  // Returns the distinct union of repos used by tasks on boards the user can access.
  router.get('/available-repos', async (req: any, res) => {
    try {
      const repos = await getAccessibleBoardRepos(req.user?.userId || null, req.user?.role || 'user');
      res.json(repos.map(r => ({
        provider: r.provider,
        fullName: r.fullName,
        htmlUrl: r.htmlUrl,
        defaultBranch: '',
        description: '',
      })));
    } catch (err: any) {
      console.error('Failed to list available repos:', err.message);
      res.json([]);
    }
  });

  // (Board-scoped) Repos accessible via the board's GitHub plugin OAuth token.
  // This is what the BoardReposPanel uses to populate the "Add Repo" picker.
  router.get('/boards/:boardId/available-repos', async (req: any, res) => {
    try {
      const access = await checkBoardAccess(req.params.boardId, req.user?.userId, req.user?.role, 'read');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });

      const tok = getOAuthToken('github', 'board', req.params.boardId);
      if (!tok || !tok.accessToken) {
        return res.status(400).json({
          error: 'No GitHub plugin connected on this board',
          code: 'GITHUB_NOT_CONNECTED',
        });
      }

      // Fetch repos accessible to the connected GitHub user/installation.
      // Pulls up to 3 pages of 100 (= 300 repos) — sufficient for most setups.
      const headers = {
        Authorization: `Bearer ${tok.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PulsarTeam',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      const out: any[] = [];
      for (let page = 1; page <= 3; page++) {
        const ghRes = await fetch(
          `https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=updated`,
          { headers }
        );
        if (!ghRes.ok) {
          const body = await ghRes.text();
          console.error(`[GitHub] /user/repos failed (${ghRes.status}):`, body.slice(0, 200));
          return res.status(502).json({ error: `GitHub API ${ghRes.status}` });
        }
        const data = await ghRes.json();
        if (!Array.isArray(data) || data.length === 0) break;
        for (const r of data) {
          out.push({
            provider: 'github',
            fullName: r.full_name,
            htmlUrl: r.html_url,
            defaultBranch: r.default_branch,
            description: r.description || '',
          });
        }
        if (data.length < 100) break;
      }

      res.json(out);
    } catch (err: any) {
      console.error('Failed to list board repos:', err.message);
      res.status(500).json({ error: 'Failed to list repos' });
    }
  });

  // (Board-scoped) Storage roots accessible via the board's OneDrive plugin.
  // Returns the top-level folders of the connected user's OneDrive — used to
  // populate the storage picker on tasks. Google Drive is not currently wired
  // into the per-board OAuth store and is therefore omitted.
  router.get('/boards/:boardId/available-storages', async (req: any, res) => {
    try {
      const access = await checkBoardAccess(req.params.boardId, req.user?.userId, req.user?.role, 'read');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });

      const tok = getOAuthToken('onedrive', 'board', req.params.boardId);
      if (!tok || !tok.accessToken) {
        return res.status(400).json({
          error: 'No drive connected',
          code: 'DRIVE_NOT_CONNECTED',
        });
      }

      const headers = {
        Authorization: `Bearer ${tok.accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'PulsarTeam',
      };

      const ghRes = await fetch(
        // Top-level items, sort by name. Folder filter is applied client-side
        // because Graph's `$filter=folder ne null` requires a specific header.
        `https://graph.microsoft.com/v1.0/me/drive/root/children?$top=200&$orderby=name&$select=id,name,folder,parentReference,webUrl`,
        { headers }
      );
      if (!ghRes.ok) {
        const body = await ghRes.text();
        console.error(`[OneDrive] /me/drive/root/children failed (${ghRes.status}):`, body.slice(0, 200));
        return res.status(502).json({ error: `OneDrive API ${ghRes.status}` });
      }
      const data = await ghRes.json();
      const items = Array.isArray(data?.value) ? data.value : [];
      const folders = items.filter((i: any) => i.folder).map((i: any) => ({
        provider: 'onedrive',
        path: `/${i.name}`,
        displayName: i.name,
        webUrl: i.webUrl || null,
      }));
      // Always include the drive root as a target option
      const out = [{ provider: 'onedrive', path: '/', displayName: 'Drive root', webUrl: null }, ...folders];
      res.json(out);
    } catch (err: any) {
      console.error('Failed to list board storages:', err.message);
      res.status(500).json({ error: 'Failed to list storages' });
    }
  });

  // ── GitHub repo explorer (used by repo detail UI) ────────────────────────
  // All endpoints authenticate via the board's GitHub plugin OAuth token,
  // passed as a `?boardId=` query parameter.

  async function resolveBoardGitHubAuth(req: any, res: any): Promise<{ ok: true; headers: Record<string, string> } | { ok: false }> {
    const boardId = (req.query?.boardId as string | undefined) || '';
    if (!boardId) {
      res.status(400).json({ error: 'boardId query parameter required' });
      return { ok: false };
    }
    // IDOR protection: verify the caller can access this board before using
    // the board's OAuth credentials to fetch GitHub data on its behalf.
    const access = await checkBoardAccess(boardId, req.user?.userId, req.user?.role, 'read');
    if (!access.ok) {
      res.status(access.status || 403).json({ error: access.error });
      return { ok: false };
    }
    const tok = getOAuthToken('github', 'board', boardId);
    if (!tok || !tok.accessToken) {
      res.status(400).json({ error: 'No GitHub plugin connected on this board', code: 'GITHUB_NOT_CONNECTED' });
      return { ok: false };
    }
    return {
      ok: true,
      headers: {
        Authorization: `Bearer ${tok.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PulsarTeam',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
  }

  router.get('/github-activity/:owner/:repo', async (req, res) => {
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo } = req.params;
    const cacheKey = `${req.query.boardId}:${owner}/${repo}`;
    const cached = _activityCache.get(cacheKey);
    if (cached && Date.now() - cached.time < ACTIVITY_CACHE_TTL) return res.json(cached.data);

    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [commitsRes, tagsRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=50`, { headers: auth.headers }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=20`, { headers: auth.headers }),
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
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo } = req.params;
    const cacheKey = `branches:${req.query.boardId}:${owner}/${repo}`;
    const cached = _branchesCache.get(cacheKey);
    if (cached && Date.now() - cached.time < BRANCHES_CACHE_TTL) return res.json(cached.data);

    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, { headers: auth.headers });
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
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo, ref } = req.params;
    const cacheKey = `tree:${req.query.boardId}:${owner}/${repo}:${ref}`;
    const cached = _treeCache.get(cacheKey);
    if (cached && Date.now() - cached.time < TREE_CACHE_TTL) return res.json(cached.data);

    try {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, { headers: auth.headers });
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
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo, ref } = req.params;
    const filePath = (req.params as any)[0];
    if (!filePath) return res.status(400).json({ error: 'File path required' });

    const cacheKey = `file:${req.query.boardId}:${owner}/${repo}:${ref}:${filePath}`;
    const cached = _fileCache.get(cacheKey);
    if (cached && Date.now() - cached.time < FILE_CACHE_TTL) return res.json(cached.data);

    try {
      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
        { headers: auth.headers }
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
