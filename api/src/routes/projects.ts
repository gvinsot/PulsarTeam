import express from 'express';
import { requireRole } from '../middleware/auth.js';
import { checkBoardAccess, checkProjectAccess } from '../middleware/authz.js';
import {
  getProjectsForUser, getProjectByName, createProject, updateProject, deleteProject,
  getBoardsForProject, setBoardProject,
  getReposForBoard, getReposForProject, getAccessibleBoardRepos,
  getStoragesForBoard, getStoragesForProject,
  getOAuthToken,
} from '../services/database.js';
import { validateBody } from '../lib/validate.js';
import { createProjectSchema, updateProjectSchema } from '../schemas/projects.js';
import { analyzeRepoCallGraph } from '../services/codeGraphAnalyzer.js';
import { getSettings } from '../services/configManager.js';

// ── In-memory caches for GitHub explorer endpoints ─────────────────────────
const ACTIVITY_CACHE_TTL = 60 * 1000;
const BRANCHES_CACHE_TTL = 15 * 60 * 1000;
const TREE_CACHE_TTL = 5 * 60 * 1000;
const FILE_CACHE_TTL = 5 * 60 * 1000;
const CODE_GRAPH_CACHE_TTL = 10 * 60 * 1000;
const _activityCache = new Map<string, { data: any; time: number }>();
const _branchesCache = new Map<string, { data: any; time: number }>();
const _treeCache = new Map<string, { data: any; time: number }>();
const _fileCache = new Map<string, { data: any; time: number }>();
const _codeGraphCache = new Map<string, { data: any; time: number }>();

// Entries are only TTL-checked on read, so without bounds the caches grow
// monotonically until OOM. Expired entries are kept for a while past their
// TTL because the handlers serve them as a stale fallback when GitHub is
// unreachable; the size cap (FIFO via Map insertion order) is the hard bound.
const CACHE_STALE_FALLBACK_FACTOR = 10;
function cacheSet(
  cache: Map<string, { data: any; time: number }>,
  key: string,
  data: any,
  ttl: number,
  maxEntries: number,
): void {
  const cutoff = Date.now() - ttl * CACHE_STALE_FALLBACK_FACTOR;
  for (const [k, v] of cache) {
    if (v.time < cutoff) cache.delete(k);
  }
  cache.delete(key);
  cache.set(key, { data, time: Date.now() });
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Shared cache-lookup → fetch → serve-stale-on-error pattern for the GitHub
// explorer GET endpoints. The serve-stale policy is stated once here. `cached`
// is captured BEFORE build() runs so the pre-fetch snapshot is served as the
// stale fallback even if a concurrent request repopulated the cache mid-await.
async function serveCached(
  res: any,
  opts: {
    cache: Map<string, { data: any; time: number }>;
    key: string;
    ttl: number;
    maxEntries: number;
    force?: boolean;
    logContext: string;   // e.g. `tree for ${owner}/${repo}@${ref}` — preserves console detail
    responseError: string; // generic body message, e.g. 'Failed to fetch file tree'
    build: () => Promise<any>;
  },
): Promise<void> {
  const cached = opts.cache.get(opts.key);
  if (!opts.force && cached && Date.now() - cached.time < opts.ttl) {
    res.json(cached.data);
    return;
  }
  try {
    const data = await opts.build();
    cacheSet(opts.cache, opts.key, data, opts.ttl, opts.maxEntries);
    res.json(data);
  } catch (err: any) {
    console.error(`Failed to fetch ${opts.logContext}:`, err.message);
    if (cached) {
      res.json(cached.data);
      return;
    }
    res.status(500).json({ error: opts.responseError });
  }
}

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
      const userId = req.user?.userId || null;
      const role = req.user?.role || 'basic';
      const projects = await getProjectsForUser(userId, role);
      // Enrich with board/repo/storage counts
      const enriched = await Promise.all(projects.map(async p => {
        const boards = await getBoardsForProject(p.id, userId, role);
        const repos = await getReposForProject(p.id, userId, role);
        const storages = await getStoragesForProject(p.id, userId, role);
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
      const userId = req.user?.userId || null;
      const role = req.user?.role || 'basic';
      const boards = await getBoardsForProject(project.id, userId, role);
      const repos = await getReposForProject(project.id, userId, role);
      const storages = await getStoragesForProject(project.id, userId, role);
      res.json({ ...project, boards, repos, storages });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // Mutations require advanced/admin — basic users may not create/modify projects globally.
  router.post('/', requireRole('admin', 'advanced'), validateBody(createProjectSchema), async (req: any, res) => {
    try {
      const body = req.body;
      const existing = await getProjectByName(body.name);
      if (existing) return res.status(409).json({ error: 'A project with this name already exists' });
      const project = await createProject(body.name, body.description, body.rules, req.user?.userId || null);
      res.status(201).json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', requireRole('admin', 'advanced'), validateBody(updateProjectSchema), uuidOnly(async (req: any, res: any) => {
    try {
      const access = await checkProjectAccess(req.params.id, req.user?.userId, req.user?.role, 'edit');
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      const updated = await updateProject(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Project not found' });
      res.json(updated);
    } catch (err: any) {
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
      const boards = await getBoardsForProject(req.params.id, req.user?.userId || null, req.user?.role || 'basic');
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
        // No GitHub plugin connected on this board is a normal state, not an
        // error — the picker simply has no repos to offer. Return an empty
        // list (200) so the frontend doesn't log a noisy 400 in the console.
        return res.json([]);
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
        // A board without a OneDrive plugin is a normal state (storage is
        // optional), not a client error — returning 400 made every task-open on
        // such a board log a console error. Return an empty list (200) instead.
        // When a drive IS connected the list always contains at least the Drive
        // root below, so the frontend reads an empty result as "no drive".
        return res.json([]);
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
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

    await serveCached(res, {
      cache: _activityCache, key: cacheKey, ttl: ACTIVITY_CACHE_TTL, maxEntries: 500, force: forceRefresh,
      logContext: `GitHub activity for ${owner}/${repo}`, responseError: 'Failed to fetch GitHub activity',
      build: async () => {
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

        return { commits, tags, fetchedAt: new Date().toISOString() };
      },
    });
  });

  router.get('/github-branches/:owner/:repo', async (req, res) => {
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo } = req.params;
    const cacheKey = `branches:${req.query.boardId}:${owner}/${repo}`;

    await serveCached(res, {
      cache: _branchesCache, key: cacheKey, ttl: BRANCHES_CACHE_TTL, maxEntries: 500,
      logContext: `branches for ${owner}/${repo}`, responseError: 'Failed to fetch branches',
      build: async () => {
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, { headers: auth.headers });
        if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
        const data = await ghRes.json();
        return data.map((b: any) => ({ name: b.name, sha: b.commit.sha }));
      },
    });
  });

  router.get('/github-tree/:owner/:repo/:ref', async (req, res) => {
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo, ref } = req.params;
    const cacheKey = `tree:${req.query.boardId}:${owner}/${repo}:${ref}`;

    await serveCached(res, {
      cache: _treeCache, key: cacheKey, ttl: TREE_CACHE_TTL, maxEntries: 100,
      logContext: `tree for ${owner}/${repo}@${ref}`, responseError: 'Failed to fetch file tree',
      build: async () => {
        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, { headers: auth.headers });
        if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`);
        const data = await ghRes.json();
        const tree = (data.tree || []).map((item: any) => ({
          path: item.path,
          type: item.type,
          size: item.size || 0,
          sha: item.sha,
        }));
        return { tree, truncated: !!data.truncated };
      },
    });
  });

  router.get('/github-file/:owner/:repo/:ref/*', async (req, res) => {
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo, ref } = req.params;
    const filePath = (req.params as any)[0];
    if (!filePath) return res.status(400).json({ error: 'File path required' });

    const cacheKey = `file:${req.query.boardId}:${owner}/${repo}:${ref}:${filePath}`;

    await serveCached(res, {
      cache: _fileCache, key: cacheKey, ttl: FILE_CACHE_TTL, maxEntries: 1000,
      logContext: `file ${filePath} for ${owner}/${repo}@${ref}`, responseError: 'Failed to fetch file content',
      build: async () => {
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

        return {
          name: data.name,
          path: data.path,
          size: data.size,
          type: data.type,
          content,
          isBinary,
          htmlUrl: data.html_url,
          downloadUrl: data.download_url,
        };
      },
    });
  });

  // ── Code call-graph analysis ──────────────────────────────────────────────
  // On-demand: scans the repo tree, parses UI / service source files, and
  // returns a graph of UI features → backend services (or the reverse).
  // Optional LLM simplification when admin has configured `codeGraphLlmConfigId`.

  router.post('/code-graph/:owner/:repo', async (req, res) => {
    const auth = await resolveBoardGitHubAuth(req, res);
    if (!auth.ok) return;

    const { owner, repo } = req.params;
    const direction = (req.body?.direction === 'service-to-ui') ? 'service-to-ui' : 'ui-to-service';
    const refresh = req.body?.refresh === true || req.body?.refresh === '1';
    const ref = (req.body?.ref || 'main').toString();

    const cacheKey = `cg:${req.query.boardId}:${owner}/${repo}:${ref}:${direction}`;
    const cached = _codeGraphCache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.time < CODE_GRAPH_CACHE_TTL) {
      return res.json(cached.data);
    }

    try {
      // 1) Fetch the recursive tree.
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { headers: auth.headers },
      );
      if (!treeRes.ok) {
        const text = await treeRes.text();
        console.error(`[CodeGraph] tree fetch ${treeRes.status}: ${text.slice(0, 200)}`);
        return res.status(502).json({ error: `GitHub tree fetch failed (${treeRes.status})` });
      }
      const treeData = await treeRes.json();
      const treeFiles = (treeData.tree || []).map((it: any) => ({
        path: it.path, type: it.type, size: it.size || 0,
      }));

      // 2) File fetcher closure — uses GitHub contents API and caches results.
      const fetchFile = async (filePath: string): Promise<string | null> => {
        const fileKey = `cg-file:${owner}/${repo}:${ref}:${filePath}`;
        const c = _fileCache.get(fileKey);
        if (c && Date.now() - c.time < FILE_CACHE_TTL) return c.data;
        const ghRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(filePath)}?ref=${encodeURIComponent(ref)}`,
          { headers: auth.headers, signal: AbortSignal.timeout(15_000) },
        );
        if (!ghRes.ok) return null;
        const data = await ghRes.json();
        if (data.encoding === 'base64' && data.content) {
          try {
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            cacheSet(_fileCache, fileKey, content, FILE_CACHE_TTL, 1000);
            return content;
          } catch {
            return null;
          }
        }
        return null;
      };

      // 3) Resolve the LLM config (admin setting) if any.
      let llmConfigId: string | null = null;
      try {
        const settings = await getSettings();
        llmConfigId = (settings.codeGraphLlmConfigId || '').toString() || null;
      } catch { /* ignore */ }

      // 4) Run the analyzer.
      const graph = await analyzeRepoCallGraph({
        owner, repo, ref, direction,
        treeFiles,
        truncated: !!treeData.truncated,
        fetchFile,
        llmConfigId,
      });

      const result = { ...graph, fetchedAt: new Date().toISOString(), ref };
      cacheSet(_codeGraphCache, cacheKey, result, CODE_GRAPH_CACHE_TTL, 50);
      res.json(result);
    } catch (err: any) {
      console.error(`[CodeGraph] analysis failed for ${owner}/${repo}:`, err.message);
      res.status(500).json({ error: `Code graph analysis failed: ${err.message}` });
    }
  });

  return router;
}
