import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Octokit } from '@octokit/rest';

const router = Router();

// PUT /tasks/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Update allowed fields
    const { title, description, column, agentId, type, priority, dueDate } = req.body;
    if (title !== undefined)       task.title       = title;
    if (description !== undefined) task.description = description;
    if (column !== undefined)      task.column      = column;
    if (agentId !== undefined)     task.agentId     = agentId;
    if (type !== undefined)        task.type        = type;
    if (priority !== undefined)    task.priority    = priority;
    if (dueDate !== undefined)     task.dueDate     = dueDate;
    task.updatedAt = new Date().toISOString();

    mgr.saveTasksToDb();
    mgr._emit('task:updated', task);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /tasks/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const ok = mgr.deleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: extract owner/repo from task context ────────────────────────────
function resolveOwnerRepo(task, mgr) {
  // 1) task.project like "owner/repo"
  if (task.project && task.project.includes('/')) {
    const [owner, repo] = task.project.split('/');
    if (owner && repo) return { owner, repo };
  }
  // 2) task.githubIssue
  if (task.githubIssue?.owner && task.githubIssue?.repo) {
    return { owner: task.githubIssue.owner, repo: task.githubIssue.repo };
  }
  // 3) agent sshUrl like git@github.com:owner/repo.git
  if (task.agentId) {
    const agent = mgr.agents.get(task.agentId);
    if (agent?.sshUrl) {
      const m = agent.sshUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) return { owner: m[1], repo: m[2] };
    }
    // 4) agent projectName
    if (agent?.projectName && agent.projectName.includes('/')) {
      const [owner, repo] = agent.projectName.split('/');
      if (owner && repo) return { owner, repo };
    }
  }
  return null;
}

// GET /tasks/:id/commits/:hash/diff — fetch commit diff from GitHub
router.get('/:id/commits/:hash/diff', requireAuth, async (req, res) => {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return res.status(501).json({ error: 'GITHUB_TOKEN not configured' });

    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const ownerRepo = resolveOwnerRepo(task, mgr);
    if (!ownerRepo) {
      return res.status(400).json({ error: 'Cannot determine GitHub repository for this task' });
    }

    const octokit = new Octokit({ auth: token });
    const { data: commit } = await octokit.repos.getCommit({
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      ref: req.params.hash,
    });

    res.json({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author?.name || commit.author?.login || 'unknown',
      date: commit.commit.author?.date,
      stats: commit.stats,
      files: (commit.files || []).map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch || '',
      })),
    });
  } catch (err) {
    console.error('Commit diff error:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Commit not found on GitHub' });
    res.status(500).json({ error: err.message });
  }
});

export default router;