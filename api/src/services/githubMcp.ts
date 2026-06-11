import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getGitHubAccessTokenForAgent } from '../routes/github.js';

const GITHUB_API = 'https://api.github.com';

async function githubFetch(path: string, agentId: string | null = null, boardId: string | null = null, options: Record<string, any> = {}) {
  const token = await getGitHubAccessTokenForAgent(agentId, boardId);
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'PulsarTeam',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

export function createGitHubMcpServer(agentId = null, boardId = null) {
  const server = new McpServer({
    name: 'GitHub',
    version: '1.0.0',
  });

  // ── get_authenticated_user ──────────────────────────────────────────
  server.tool(
    'get_authenticated_user',
    'Get the authenticated GitHub user profile (login, name, email, repos count).',
    {},
    async () => {
      const user = await githubFetch('/user', agentId, boardId);
      return {
        content: [{
          type: 'text',
          text: `GitHub User:\nLogin: ${user.login}\nName: ${user.name || 'N/A'}\nEmail: ${user.email || 'N/A'}\nPublic repos: ${user.public_repos}\nPrivate repos: ${user.total_private_repos || 'N/A'}\nFollowers: ${user.followers}\nFollowing: ${user.following}`
        }],
      };
    }
  );

  // ── list_repos ──────────────────────────────────────────────────────
  server.tool(
    'list_repos',
    'List repositories accessible to the authenticated user.',
    {
      type: z.enum(['all', 'owner', 'public', 'private', 'member']).optional().default('all').describe('Filter by repo type'),
      sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional().default('updated').describe('Sort field'),
      per_page: z.number().optional().default(30).describe('Results per page (max 100)'),
      page: z.number().optional().default(1).describe('Page number'),
    },
    async ({ type, sort, per_page, page }) => {
      const params = new URLSearchParams({
        type: type || 'all',
        sort: sort || 'updated',
        per_page: String(Math.min(per_page || 30, 100)),
        page: String(page || 1),
      });
      const repos = await githubFetch(`/user/repos?${params}`, agentId, boardId);

      if (!repos.length) {
        return { content: [{ type: 'text', text: 'No repositories found.' }] };
      }

      const list = repos.map((r, i) => {
        const vis = r.private ? '🔒' : '🌐';
        return `${i + 1}. ${vis} ${r.full_name} — ${r.description || 'No description'}\n   ⭐ ${r.stargazers_count} | 🍴 ${r.forks_count} | Lang: ${r.language || 'N/A'} | Updated: ${r.updated_at?.slice(0, 10)}`;
      }).join('\n\n');

      return { content: [{ type: 'text', text: `Repositories (${repos.length}):\n\n${list}` }] };
    }
  );

  // ── get_repo ────────────────────────────────────────────────────────
  server.tool(
    'get_repo',
    'Get detailed information about a specific repository.',
    {
      owner: z.string().describe('Repository owner (user or organization)'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      const r = await githubFetch(`/repos/${owner}/${repo}`, agentId, boardId);
      return {
        content: [{
          type: 'text',
          text: `Repository: ${r.full_name}\nDescription: ${r.description || 'None'}\nVisibility: ${r.private ? 'Private' : 'Public'}\nDefault branch: ${r.default_branch}\nLanguage: ${r.language || 'N/A'}\nStars: ${r.stargazers_count} | Forks: ${r.forks_count} | Watchers: ${r.watchers_count}\nOpen issues: ${r.open_issues_count}\nCreated: ${r.created_at?.slice(0, 10)}\nUpdated: ${r.updated_at?.slice(0, 10)}\nClone URL: ${r.clone_url}\nTopics: ${(r.topics || []).join(', ') || 'None'}`
        }],
      };
    }
  );

  // ── list_issues ─────────────────────────────────────────────────────
  server.tool(
    'list_issues',
    'List issues for a repository. Supports filtering by state, labels, assignee.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('Issue state filter'),
      labels: z.string().optional().describe('Comma-separated label names'),
      assignee: z.string().optional().describe('Filter by assignee username, or "none" / "*"'),
      sort: z.enum(['created', 'updated', 'comments']).optional().default('created'),
      per_page: z.number().optional().default(30),
    },
    async ({ owner, repo, state, labels, assignee, sort, per_page }) => {
      const params = new URLSearchParams({
        state: state || 'open',
        sort: sort || 'created',
        per_page: String(Math.min(per_page || 30, 100)),
      });
      if (labels) params.set('labels', labels);
      if (assignee) params.set('assignee', assignee);

      const issues = await githubFetch(`/repos/${owner}/${repo}/issues?${params}`, agentId, boardId);
      const filtered = issues.filter(i => !i.pull_request);

      if (!filtered.length) {
        return { content: [{ type: 'text', text: `No issues found for ${owner}/${repo} (state: ${state}).` }] };
      }

      const list = filtered.map((issue, i) => {
        const labels = (issue.labels || []).map(l => l.name).join(', ');
        return `${i + 1}. #${issue.number} [${issue.state}] ${issue.title}\n   Assignee: ${issue.assignee?.login || 'Unassigned'} | Labels: ${labels || 'None'} | Comments: ${issue.comments}\n   Created: ${issue.created_at?.slice(0, 10)} | Updated: ${issue.updated_at?.slice(0, 10)}`;
      }).join('\n\n');

      return { content: [{ type: 'text', text: `Issues for ${owner}/${repo} (${filtered.length}):\n\n${list}` }] };
    }
  );

  // ── get_issue ───────────────────────────────────────────────────────
  server.tool(
    'get_issue',
    'Get detailed information about a specific issue, including body and comments.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      issue_number: z.number().describe('Issue number'),
    },
    async ({ owner, repo, issue_number }) => {
      const issue = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}`, agentId, boardId);
      const labels = (issue.labels || []).map(l => l.name).join(', ');

      let commentsText = '';
      if (issue.comments > 0) {
        const comments = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}/comments?per_page=20`, agentId, boardId);
        commentsText = '\n\n--- Comments ---\n' + comments.map((c, i) =>
          `[${i + 1}] ${c.user?.login} (${c.created_at?.slice(0, 10)}):\n${c.body}`
        ).join('\n\n');
      }

      return {
        content: [{
          type: 'text',
          text: `Issue #${issue.number}: ${issue.title}\nState: ${issue.state}\nAuthor: ${issue.user?.login}\nAssignee: ${issue.assignee?.login || 'Unassigned'}\nLabels: ${labels || 'None'}\nMilestone: ${issue.milestone?.title || 'None'}\nCreated: ${issue.created_at?.slice(0, 10)}\nUpdated: ${issue.updated_at?.slice(0, 10)}\n\n--- Body ---\n${issue.body || '(empty)'}${commentsText}`
        }],
      };
    }
  );

  // ── create_issue ────────────────────────────────────────────────────
  server.tool(
    'create_issue',
    'Create a new issue in a repository.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      title: z.string().describe('Issue title'),
      body: z.string().optional().describe('Issue body (markdown)'),
      labels: z.string().optional().describe('Comma-separated label names'),
      assignees: z.string().optional().describe('Comma-separated assignee usernames'),
    },
    async ({ owner, repo, title, body, labels, assignees }) => {
      const payload: any = { title };
      if (body) payload.body = body;
      if (labels) payload.labels = labels.split(',').map(l => l.trim());
      if (assignees) payload.assignees = assignees.split(',').map(a => a.trim());

      const issue = await githubFetch(`/repos/${owner}/${repo}/issues`, agentId, boardId, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      return {
        content: [{
          type: 'text',
          text: `Issue created: #${issue.number} "${issue.title}"\nURL: ${issue.html_url}`
        }],
      };
    }
  );

  // ── update_issue ────────────────────────────────────────────────────
  server.tool(
    'update_issue',
    'Update an existing issue (title, body, state, labels, assignees).',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      issue_number: z.number().describe('Issue number'),
      title: z.string().optional().describe('New title'),
      body: z.string().optional().describe('New body'),
      state: z.enum(['open', 'closed']).optional().describe('New state'),
      labels: z.string().optional().describe('Comma-separated label names (replaces existing)'),
      assignees: z.string().optional().describe('Comma-separated assignee usernames (replaces existing)'),
    },
    async ({ owner, repo, issue_number, title, body, state, labels, assignees }) => {
      const payload: any = {};
      if (title !== undefined) payload.title = title;
      if (body !== undefined) payload.body = body;
      if (state) payload.state = state;
      if (labels) payload.labels = labels.split(',').map(l => l.trim());
      if (assignees) payload.assignees = assignees.split(',').map(a => a.trim());

      const issue = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}`, agentId, boardId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });

      return {
        content: [{
          type: 'text',
          text: `Issue #${issue.number} updated: "${issue.title}" [${issue.state}]\nURL: ${issue.html_url}`
        }],
      };
    }
  );

  // ── add_issue_comment ───────────────────────────────────────────────
  server.tool(
    'add_issue_comment',
    'Add a comment to an issue or pull request.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      issue_number: z.number().describe('Issue or PR number'),
      body: z.string().describe('Comment body (markdown)'),
    },
    async ({ owner, repo, issue_number, body }) => {
      const comment = await githubFetch(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });

      return {
        content: [{
          type: 'text',
          text: `Comment added to #${issue_number}\nComment ID: ${comment.id}\nURL: ${comment.html_url}`
        }],
      };
    }
  );

  // ── list_pull_requests ──────────────────────────────────────────────
  server.tool(
    'list_pull_requests',
    'List pull requests for a repository.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      state: z.enum(['open', 'closed', 'all']).optional().default('open'),
      sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional().default('created'),
      per_page: z.number().optional().default(30),
    },
    async ({ owner, repo, state, sort, per_page }) => {
      const params = new URLSearchParams({
        state: state || 'open',
        sort: sort || 'created',
        per_page: String(Math.min(per_page || 30, 100)),
      });

      const prs = await githubFetch(`/repos/${owner}/${repo}/pulls?${params}`, agentId, boardId);

      if (!prs.length) {
        return { content: [{ type: 'text', text: `No pull requests found for ${owner}/${repo} (state: ${state}).` }] };
      }

      const list = prs.map((pr, i) => {
        const reviewStatus = pr.draft ? '📝 Draft' : '🔀 Ready';
        return `${i + 1}. #${pr.number} [${reviewStatus}] ${pr.title}\n   ${pr.head?.ref} → ${pr.base?.ref} | Author: ${pr.user?.login}\n   Created: ${pr.created_at?.slice(0, 10)} | Updated: ${pr.updated_at?.slice(0, 10)}`;
      }).join('\n\n');

      return { content: [{ type: 'text', text: `Pull Requests for ${owner}/${repo} (${prs.length}):\n\n${list}` }] };
    }
  );

  // ── get_pull_request ────────────────────────────────────────────────
  server.tool(
    'get_pull_request',
    'Get detailed information about a specific pull request, including diff stats and review status.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      pull_number: z.number().describe('Pull request number'),
    },
    async ({ owner, repo, pull_number }) => {
      const pr = await githubFetch(`/repos/${owner}/${repo}/pulls/${pull_number}`, agentId, boardId);

      let reviewsText = '';
      try {
        const reviews = await githubFetch(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=10`, agentId, boardId);
        if (reviews.length) {
          reviewsText = '\n\n--- Reviews ---\n' + reviews.map(r =>
            `${r.user?.login}: ${r.state} (${r.submitted_at?.slice(0, 10)})`
          ).join('\n');
        }
      } catch { /* reviews may not be available */ }

      return {
        content: [{
          type: 'text',
          text: `PR #${pr.number}: ${pr.title}\nState: ${pr.state}${pr.draft ? ' (Draft)' : ''}${pr.merged ? ' (Merged)' : ''}\nAuthor: ${pr.user?.login}\nBranch: ${pr.head?.ref} → ${pr.base?.ref}\nMergeable: ${pr.mergeable ?? 'checking...'}\nChanges: +${pr.additions} -${pr.deletions} in ${pr.changed_files} file(s)\nCommits: ${pr.commits}\nReview comments: ${pr.review_comments}\nCreated: ${pr.created_at?.slice(0, 10)}\nUpdated: ${pr.updated_at?.slice(0, 10)}\n\n--- Description ---\n${pr.body || '(empty)'}${reviewsText}\n\nURL: ${pr.html_url}`
        }],
      };
    }
  );

  // ── create_pull_request ─────────────────────────────────────────────
  server.tool(
    'create_pull_request',
    'Create a new pull request.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      title: z.string().describe('PR title'),
      head: z.string().describe('Branch containing changes (e.g. "feature-branch" or "user:feature-branch" for cross-repo)'),
      base: z.string().describe('Branch to merge into (e.g. "main")'),
      body: z.string().optional().describe('PR description (markdown)'),
      draft: z.boolean().optional().default(false).describe('Create as draft PR'),
    },
    async ({ owner, repo, title, head, base, body, draft }) => {
      const pr = await githubFetch(`/repos/${owner}/${repo}/pulls`, agentId, boardId, {
        method: 'POST',
        body: JSON.stringify({ title, head, base, body, draft }),
      });

      return {
        content: [{
          type: 'text',
          text: `Pull request created: #${pr.number} "${pr.title}"\n${pr.head?.ref} → ${pr.base?.ref}\nURL: ${pr.html_url}`
        }],
      };
    }
  );

  // ── list_branches ───────────────────────────────────────────────────
  server.tool(
    'list_branches',
    'List branches in a repository.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      per_page: z.number().optional().default(30),
    },
    async ({ owner, repo, per_page }) => {
      const params = new URLSearchParams({ per_page: String(Math.min(per_page || 30, 100)) });
      const branches = await githubFetch(`/repos/${owner}/${repo}/branches?${params}`, agentId, boardId);

      const list = branches.map((b, i) =>
        `${i + 1}. ${b.name}${b.protected ? ' 🔒' : ''} — ${b.commit?.sha?.slice(0, 7)}`
      ).join('\n');

      return { content: [{ type: 'text', text: `Branches for ${owner}/${repo} (${branches.length}):\n\n${list}` }] };
    }
  );

  // ── get_file_content ────────────────────────────────────────────────
  server.tool(
    'get_file_content',
    'Get the content of a file from a repository.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path within the repository'),
      ref: z.string().optional().describe('Branch, tag, or commit SHA (defaults to default branch)'),
    },
    async ({ owner, repo, path, ref }) => {
      const params = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const data = await githubFetch(`/repos/${owner}/${repo}/contents/${path}${params}`, agentId, boardId);

      if (Array.isArray(data)) {
        const items = data.map(item =>
          `${item.type === 'dir' ? '📁' : '📄'} ${item.name} (${item.type}, ${item.size || 0} bytes)`
        ).join('\n');
        return { content: [{ type: 'text', text: `Directory listing for ${path}:\n\n${items}` }] };
      }

      if (data.encoding === 'base64' && data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const truncated = content.length > 10000 ? content.slice(0, 10000) + '\n\n... (truncated)' : content;
        return { content: [{ type: 'text', text: `File: ${data.path} (${data.size} bytes)\nSHA: ${data.sha}\n\n${truncated}` }] };
      }

      return { content: [{ type: 'text', text: `File: ${data.path}\nType: ${data.type}\nSize: ${data.size}\nSHA: ${data.sha}\nDownload URL: ${data.download_url}` }] };
    }
  );

  // ── search_code ─────────────────────────────────────────────────────
  server.tool(
    'search_code',
    'Search for code across GitHub repositories using GitHub code search.',
    {
      query: z.string().describe('Search query. Supports qualifiers like repo:owner/name, language:js, path:src/'),
      per_page: z.number().optional().default(20),
    },
    async ({ query, per_page }) => {
      const params = new URLSearchParams({
        q: query,
        per_page: String(Math.min(per_page || 20, 100)),
      });
      const result = await githubFetch(`/search/code?${params}`, agentId, boardId);
      const items = result.items || [];

      if (!items.length) {
        return { content: [{ type: 'text', text: `No code results for: "${query}"` }] };
      }

      const list = items.map((item, i) =>
        `${i + 1}. ${item.repository?.full_name}/${item.path}\n   Score: ${item.score?.toFixed(2)} | SHA: ${item.sha?.slice(0, 7)}`
      ).join('\n\n');

      return { content: [{ type: 'text', text: `Code search "${query}" — ${result.total_count} result(s):\n\n${list}` }] };
    }
  );

  // ── list_commits ────────────────────────────────────────────────────
  server.tool(
    'list_commits',
    'List recent commits on a branch.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      sha: z.string().optional().describe('Branch name or commit SHA to start from'),
      per_page: z.number().optional().default(20),
    },
    async ({ owner, repo, sha, per_page }) => {
      const params = new URLSearchParams({ per_page: String(Math.min(per_page || 20, 100)) });
      if (sha) params.set('sha', sha);

      const commits = await githubFetch(`/repos/${owner}/${repo}/commits?${params}`, agentId, boardId);

      const list = commits.map((c, i) => {
        const msg = c.commit?.message?.split('\n')[0] || '';
        return `${i + 1}. ${c.sha?.slice(0, 7)} — ${msg}\n   Author: ${c.commit?.author?.name} | Date: ${c.commit?.author?.date?.slice(0, 10)}`;
      }).join('\n\n');

      return { content: [{ type: 'text', text: `Commits for ${owner}/${repo} (${commits.length}):\n\n${list}` }] };
    }
  );

  // ── list_workflows ──────────────────────────────────────────────────
  server.tool(
    'list_workflows',
    'List GitHub Actions workflows for a repository.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      const data = await githubFetch(`/repos/${owner}/${repo}/actions/workflows`, agentId, boardId);
      const workflows = data.workflows || [];

      if (!workflows.length) {
        return { content: [{ type: 'text', text: `No workflows found for ${owner}/${repo}.` }] };
      }

      const list = workflows.map((w, i) =>
        `${i + 1}. ${w.name} (${w.state})\n   Path: ${w.path} | ID: ${w.id}`
      ).join('\n\n');

      return { content: [{ type: 'text', text: `Workflows for ${owner}/${repo} (${workflows.length}):\n\n${list}` }] };
    }
  );

  // ── list_workflow_runs ──────────────────────────────────────────────
  server.tool(
    'list_workflow_runs',
    'List recent workflow runs (CI/CD) for a repository.',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      status: z.enum(['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending']).optional(),
      per_page: z.number().optional().default(10),
    },
    async ({ owner, repo, status, per_page }) => {
      const params = new URLSearchParams({ per_page: String(Math.min(per_page || 10, 100)) });
      if (status) params.set('status', status);

      const data = await githubFetch(`/repos/${owner}/${repo}/actions/runs?${params}`, agentId, boardId);
      const runs = data.workflow_runs || [];

      if (!runs.length) {
        return { content: [{ type: 'text', text: `No workflow runs found for ${owner}/${repo}.` }] };
      }

      const list = runs.map((r, i) => {
        const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : r.status === 'in_progress' ? '🔄' : '⏸️';
        return `${i + 1}. ${icon} ${r.name} #${r.run_number}\n   Status: ${r.status} | Conclusion: ${r.conclusion || 'pending'}\n   Branch: ${r.head_branch} | Commit: ${r.head_sha?.slice(0, 7)}\n   Started: ${r.created_at?.slice(0, 19)} | URL: ${r.html_url}`;
      }).join('\n\n');

      return { content: [{ type: 'text', text: `Workflow runs for ${owner}/${repo} (${data.total_count} total):\n\n${list}` }] };
    }
  );

  return server;
}

export function createGitHubMcpHandler() {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const agentId = req.headers['x-agent-id'] || null;
      const boardId = req.headers['x-board-id'] || null;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createGitHubMcpServer(agentId, boardId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[GitHub MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
