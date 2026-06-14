import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJiraCredentialsForAgent } from '../routes/jira.js';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import { createProviderFetch } from './providerFetch.js';

const jiraProviderFetch = createProviderFetch({
  errorLabel: 'Jira API error',
  getAuth: (agentId, boardId) => {
    const creds = getJiraCredentialsForAgent(agentId, boardId);
    if (!creds) throw new Error('Not connected to Jira. Please configure Jira credentials for this agent first.');
    return {
      authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`,
      base: `https://${creds.domain}`,
    };
  },
  defaultHeaders: { Accept: 'application/json' },
  nullStatuses: [204],
  parse: 'json',
  maxErrorChars: 300,
});

/**
 * Helper to call Jira REST API with per-agent credentials.
 */
async function jiraFetch(agentId: string | null, boardId: string | null, path: string, options: Record<string, any> = {}) {
  return jiraProviderFetch(path, agentId, boardId, options);
}

/**
 * Recursively extract plain text from an Atlassian Document Format (ADF) node.
 */
function extractAdfText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    return node.content.map(extractAdfText).join(node.type === 'paragraph' ? '\n' : '');
  }
  return '';
}

/**
 * Build ADF document from plain text.
 */
function textToAdf(text: string) {
  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  const content = paragraphs.map(p => ({
    type: 'paragraph',
    content: [{ type: 'text', text: p.trim() }],
  }));
  return {
    type: 'doc',
    version: 1,
    content: content.length > 0 ? content : [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Create the Jira MCP server with all tools registered.
 * @param {string|null} agentId - When provided, tools use agent-specific credentials.
 */
export function createJiraMcpServer(agentId: string | null = null, pulsarBoardId: string | null = null) {
  const server = new McpServer({
    name: 'Jira',
    version: '1.0.0',
  });

  // ── Tool: get_myself ──────────────────────────────────────────────
  server.tool(
    'get_myself',
    'Get the current authenticated Jira user profile.',
    {},
    async () => {
      const user = await jiraFetch(agentId, pulsarBoardId, '/rest/api/3/myself');
      return {
        content: [{
          type: 'text',
          text: `Jira User Profile:\nName: ${user.displayName}\nEmail: ${user.emailAddress}\nAccount ID: ${user.accountId}\nTimezone: ${user.timeZone}`
        }],
      };
    }
  );

  // ── Tool: list_projects ───────────────────────────────────────────
  server.tool(
    'list_projects',
    'List all Jira projects accessible to the authenticated user.',
    {},
    async () => {
      const projects = await jiraFetch(agentId, pulsarBoardId, '/rest/api/3/project?expand=description');
      const list = (Array.isArray(projects) ? projects : []).map(p =>
        `- ${p.key}: ${p.name} (${p.projectTypeKey})${p.description ? ` — ${p.description.slice(0, 100)}` : ''}`
      ).join('\n');
      return {
        content: [{ type: 'text', text: `Jira Projects (${projects.length}):\n${list || '(none)'}` }],
      };
    }
  );

  // ── Tool: search_issues ───────────────────────────────────────────
  server.tool(
    'search_issues',
    'Search Jira issues using JQL (Jira Query Language). Returns key, summary, status, assignee, and priority.',
    {
      jql: z.string().describe('JQL query (e.g. "project = PROJ AND status = \'In Progress\'", "assignee = currentUser()", "text ~ keyword")'),
      maxResults: z.number().optional().default(20).describe('Max results (default 20, max 100)'),
    },
    async ({ jql, maxResults }) => {
      const limit = Math.min(maxResults || 20, 100);
      const data = await jiraFetch(
        agentId,
        pulsarBoardId,
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=summary,status,assignee,priority,issuetype,created,updated`
      );
      const issues = data.issues || [];
      if (issues.length === 0) {
        return { content: [{ type: 'text', text: `No issues found for JQL: "${jql}"` }] };
      }
      const list = issues.map((i: any, idx: number) => {
        const f = i.fields;
        return `${idx + 1}. ${i.key}: ${f.summary}\n   Status: ${f.status?.name || 'Unknown'} | Type: ${f.issuetype?.name || '?'} | Priority: ${f.priority?.name || '?'}\n   Assignee: ${f.assignee?.displayName || 'Unassigned'} | Updated: ${f.updated || '?'}`;
      }).join('\n\n');
      return {
        content: [{ type: 'text', text: `Found ${data.total || issues.length} issue(s) (showing ${issues.length}):\n\n${list}` }],
      };
    }
  );

  // ── Tool: get_issue ───────────────────────────────────────────────
  server.tool(
    'get_issue',
    'Get detailed information about a specific Jira issue including description, comments, and attachments.',
    {
      issueKey: z.string().describe('The Jira issue key (e.g. "PROJ-123")'),
    },
    async ({ issueKey }) => {
      const issue = await jiraFetch(
        agentId,
        pulsarBoardId,
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,priority,labels,assignee,reporter,issuetype,created,updated,comment,attachment,subtasks`
      );
      const f = issue.fields;
      const descText = extractAdfText(f.description);
      const comments = (f.comment?.comments || []).map((c: any) =>
        `  - ${c.author?.displayName || 'Unknown'} (${c.created?.slice(0, 10)}): ${extractAdfText(c.body).slice(0, 200)}`
      ).join('\n');
      const attachments = (f.attachment || []).map((a: any) =>
        `  - ${a.filename} (${(a.size / 1024).toFixed(1)} KB)`
      ).join('\n');
      const subtasks = (f.subtasks || []).map((s: any) =>
        `  - ${s.key}: ${s.fields?.summary || '?'} [${s.fields?.status?.name || '?'}]`
      ).join('\n');

      return {
        content: [{
          type: 'text',
          text: [
            `Issue: ${issue.key}`,
            `Summary: ${f.summary}`,
            `Type: ${f.issuetype?.name || '?'} | Status: ${f.status?.name || '?'} | Priority: ${f.priority?.name || '?'}`,
            `Assignee: ${f.assignee?.displayName || 'Unassigned'} | Reporter: ${f.reporter?.displayName || '?'}`,
            `Labels: ${(f.labels || []).join(', ') || 'none'}`,
            `Created: ${f.created} | Updated: ${f.updated}`,
            `\n--- Description ---\n${descText || '(no description)'}`,
            comments ? `\n--- Comments (${f.comment?.comments?.length || 0}) ---\n${comments}` : '\n--- Comments ---\n(none)',
            attachments ? `\n--- Attachments ---\n${attachments}` : '',
            subtasks ? `\n--- Subtasks ---\n${subtasks}` : '',
          ].filter(Boolean).join('\n')
        }],
      };
    }
  );

  // ── Tool: create_issue ────────────────────────────────────────────
  server.tool(
    'create_issue',
    'Create a new Jira issue in a project.',
    {
      projectKey: z.string().describe('The project key (e.g. "PROJ")'),
      summary: z.string().describe('Issue summary/title'),
      description: z.string().optional().describe('Issue description (plain text, will be converted to ADF)'),
      issueType: z.string().optional().default('Task').describe('Issue type: Task, Bug, Story, Epic, Sub-task (default: Task)'),
      priority: z.string().optional().describe('Priority: Highest, High, Medium, Low, Lowest'),
      assigneeAccountId: z.string().optional().describe('Assignee account ID (use get_myself or search to find IDs)'),
      labels: z.string().optional().describe('Comma-separated labels'),
    },
    async ({ projectKey, summary, description, issueType, priority, assigneeAccountId, labels }) => {
      const fields: any = {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType || 'Task' },
      };
      if (description) fields.description = textToAdf(description);
      if (priority) fields.priority = { name: priority };
      if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };
      if (labels) fields.labels = labels.split(',').map(l => l.trim());

      const result = await jiraFetch(agentId, pulsarBoardId, '/rest/api/3/issue', {
        method: 'POST',
        body: JSON.stringify({ fields }),
      });

      return {
        content: [{ type: 'text', text: `Issue created: ${result.key}\nURL: https://${getJiraCredentialsForAgent(agentId)?.domain}/browse/${result.key}` }],
      };
    }
  );

  // ── Tool: update_issue ────────────────────────────────────────────
  server.tool(
    'update_issue',
    'Update fields of an existing Jira issue (summary, description, priority, labels, assignee).',
    {
      issueKey: z.string().describe('The Jira issue key (e.g. "PROJ-123")'),
      summary: z.string().optional().describe('New summary'),
      description: z.string().optional().describe('New description (plain text)'),
      priority: z.string().optional().describe('New priority: Highest, High, Medium, Low, Lowest'),
      assigneeAccountId: z.string().optional().describe('New assignee account ID (or "unassigned" to clear)'),
      labels: z.string().optional().describe('New labels (comma-separated, replaces existing)'),
    },
    async ({ issueKey, summary, description, priority, assigneeAccountId, labels }) => {
      const fields: any = {};
      if (summary) fields.summary = summary;
      if (description) fields.description = textToAdf(description);
      if (priority) fields.priority = { name: priority };
      if (assigneeAccountId === 'unassigned') fields.assignee = null;
      else if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };
      if (labels) fields.labels = labels.split(',').map(l => l.trim());

      await jiraFetch(agentId, pulsarBoardId, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });

      return {
        content: [{ type: 'text', text: `Issue ${issueKey} updated successfully.` }],
      };
    }
  );

  // ── Tool: add_comment ─────────────────────────────────────────────
  server.tool(
    'add_comment',
    'Add a comment to a Jira issue.',
    {
      issueKey: z.string().describe('The Jira issue key (e.g. "PROJ-123")'),
      comment: z.string().describe('Comment text (plain text, will be converted to ADF)'),
    },
    async ({ issueKey, comment }) => {
      await jiraFetch(agentId, pulsarBoardId, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body: textToAdf(comment) }),
      });
      return {
        content: [{ type: 'text', text: `Comment added to ${issueKey} (${comment.length} chars).` }],
      };
    }
  );

  // ── Tool: transition_issue ────────────────────────────────────────
  server.tool(
    'transition_issue',
    'Transition a Jira issue to a new status. First call with no transitionId to list available transitions.',
    {
      issueKey: z.string().describe('The Jira issue key (e.g. "PROJ-123")'),
      transitionId: z.string().optional().describe('The transition ID to execute. Omit to list available transitions.'),
    },
    async ({ issueKey, transitionId }) => {
      const data = await jiraFetch(agentId, pulsarBoardId, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
      const transitions = data.transitions || [];

      if (!transitionId) {
        const list = transitions.map((t: any) =>
          `  - ID: ${t.id} → "${t.name}" (to: ${t.to?.name || '?'})`
        ).join('\n');
        return {
          content: [{ type: 'text', text: `Available transitions for ${issueKey}:\n${list || '(none)'}` }],
        };
      }

      const match = transitions.find((t: any) => t.id === transitionId);
      if (!match) {
        return {
          content: [{ type: 'text', text: `Transition ID "${transitionId}" not available. Available: ${transitions.map((t: any) => `${t.id}="${t.name}"`).join(', ')}` }],
        };
      }

      await jiraFetch(agentId, pulsarBoardId, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: transitionId } }),
      });

      return {
        content: [{ type: 'text', text: `Issue ${issueKey} transitioned via "${match.name}" → ${match.to?.name || 'new status'}.` }],
      };
    }
  );

  // ── Tool: list_boards ─────────────────────────────────────────────
  server.tool(
    'list_boards',
    'List all Jira boards (Scrum and Kanban).',
    {
      maxResults: z.number().optional().default(50).describe('Max results (default 50)'),
    },
    async ({ maxResults }) => {
      const data = await jiraFetch(agentId, pulsarBoardId, `/rest/agile/1.0/board?maxResults=${maxResults || 50}`);
      const boards = data.values || [];
      const list = boards.map((b: any) =>
        `  - ID: ${b.id} | "${b.name}" (${b.type}) — ${b.location?.displayName || b.location?.projectKey || '?'}`
      ).join('\n');
      return {
        content: [{ type: 'text', text: `Jira Boards (${boards.length}):\n${list || '(none)'}` }],
      };
    }
  );

  // ── Tool: get_board_columns ───────────────────────────────────────
  server.tool(
    'get_board_columns',
    'Get the columns/statuses of a specific Jira board.',
    {
      boardId: z.number().describe('The Jira board ID (use list_boards to find it)'),
    },
    async ({ boardId }) => {
      const config = await jiraFetch(agentId, pulsarBoardId, `/rest/agile/1.0/board/${boardId}/configuration`);
      const columns = (config.columnConfig?.columns || []).map((col: any) => {
        const statuses = (col.statuses || []).map((s: any) => s.id).join(',');
        return `  - "${col.name}" (status IDs: ${statuses || 'none'})`;
      }).join('\n');
      return {
        content: [{ type: 'text', text: `Board ${boardId} "${config.name || '?'}" columns:\n${columns || '(none)'}` }],
      };
    }
  );

  // ── Tool: get_sprint ──────────────────────────────────────────────
  server.tool(
    'get_sprint',
    'Get the active sprint for a Scrum board, including sprint issues.',
    {
      boardId: z.number().describe('The Jira board ID'),
    },
    async ({ boardId }) => {
      const data = await jiraFetch(agentId, pulsarBoardId, `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
      const sprints = data.values || [];
      if (sprints.length === 0) {
        return { content: [{ type: 'text', text: `No active sprint found for board ${boardId}.` }] };
      }
      const sprint = sprints[0];
      let issueText = '';
      try {
        const issues = await jiraFetch(agentId, pulsarBoardId, `/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=50&fields=summary,status,assignee,priority`);
        issueText = (issues.issues || []).map((i: any) =>
          `  - ${i.key}: ${i.fields.summary} [${i.fields.status?.name}] (${i.fields.assignee?.displayName || 'Unassigned'})`
        ).join('\n');
      } catch (e) {
        issueText = '(could not fetch sprint issues)';
      }
      return {
        content: [{
          type: 'text',
          text: `Active Sprint: "${sprint.name}" (ID: ${sprint.id})\nGoal: ${sprint.goal || '(none)'}\nStart: ${sprint.startDate || '?'} | End: ${sprint.endDate || '?'}\n\nIssues:\n${issueText || '(none)'}`
        }],
      };
    }
  );

  // ── Tool: assign_issue ────────────────────────────────────────────
  server.tool(
    'assign_issue',
    'Assign or unassign a Jira issue.',
    {
      issueKey: z.string().describe('The Jira issue key (e.g. "PROJ-123")'),
      accountId: z.string().optional().describe('The account ID to assign (omit or "unassigned" to unassign)'),
    },
    async ({ issueKey, accountId }) => {
      await jiraFetch(agentId, pulsarBoardId, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, {
        method: 'PUT',
        body: JSON.stringify({ accountId: accountId === 'unassigned' ? null : accountId || null }),
      });
      return {
        content: [{ type: 'text', text: accountId && accountId !== 'unassigned' ? `Issue ${issueKey} assigned to ${accountId}.` : `Issue ${issueKey} unassigned.` }],
      };
    }
  );

  return server;
}

/**
 * Create an Express handler for the Jira MCP endpoint.
 * Reads X-Agent-Id header to provide agent-specific credential resolution.
 */
export function createJiraMcpHandler() {
  return createMcpHttpHandler('Jira', ({ agentId, boardId }) =>
    createJiraMcpServer(agentId, boardId));
}
