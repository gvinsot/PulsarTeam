/**
 * Jira Sync Service
 *
 * Synchronises a Jira board with PulsarTeam workflow columns and tasks.
 *
 * Sync rules:
 *  - Columns: Jira → PulsarTeam (one-way)
 *  - Task creation: Jira → PulsarTeam (new issues appear as todos)
 *  - Status updates: bidirectional
 *
 * Env vars:
 *  JIRA_BOARD_URL   – full board URL (empty = feature disabled)
 *  JIRA_ORG_ID      – Atlassian org id (informational)
 *  JIRA_API_KEY     – PAT (Bearer) or API token (Basic with JIRA_USER_EMAIL)
 *  JIRA_USER_EMAIL  – required only when using classic API tokens
 */

import { getWorkflow, updateWorkflow } from './workflowManager.js';

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig() {
  const boardUrl = (process.env.JIRA_BOARD_URL || '').trim();
  if (!boardUrl) return null;

  // Parse: https://<domain>/jira/software/projects/<KEY>/boards/<id>
  const m = boardUrl.match(
    /https?:\/\/([^/]+)\/.*\/projects\/([^/]+)\/boards\/(\d+)/
  );
  if (!m) {
    console.error('[Jira] Cannot parse JIRA_BOARD_URL:', boardUrl);
    return null;
  }

  const apiKey = (process.env.JIRA_API_KEY || '').trim();
  if (!apiKey) {
    console.error('[Jira] JIRA_API_KEY is required');
    return null;
  }

  return {
    domain: m[1],
    projectKey: m[2],
    boardId: parseInt(m[3], 10),
    apiKey,
    userEmail: (process.env.JIRA_USER_EMAIL || '').trim(),
    baseUrl: `https://${m[1]}`,
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function authHeaders(cfg) {
  // Jira Cloud REST API requires Basic auth: email:api_token
  if (!cfg.userEmail) {
    console.error('[Jira] JIRA_USER_EMAIL is required (Basic auth with email:api_token)');
    return {};
  }
  const encoded = Buffer.from(`${cfg.userEmail}:${cfg.apiKey}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

async function jiraFetch(cfg, path, options = {}) {
  const url = `${cfg.baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeaders(cfg),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira API ${res.status}: ${res.statusText} — ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Column colours (Jira doesn't expose column colors, so we pick defaults) ─

const COLUMN_COLORS = [
  '#6b7280', '#3b82f6', '#eab308', '#22c55e', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#a855f7',
];

// ── Slug helper: turn a Jira column name into a valid PulsarTeam column id ───

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'column';
}

// ── Core sync logic ───────────────────────────────────────────────────────────

/**
 * Fetch board columns from Jira and update PulsarTeam workflow columns.
 * Returns the column mapping { jiraStatusName → pulsarColumnId }.
 */
export async function syncColumns(cfg) {
  if (!cfg) cfg = getConfig();
  if (!cfg) return null;

  // Get board configuration (columns + status mappings)
  const boardConfig = await jiraFetch(cfg, `/rest/agile/1.0/board/${cfg.boardId}/configuration`);
  const jiraColumns = boardConfig.columnConfig?.columns || [];

  if (jiraColumns.length === 0) {
    console.warn('[Jira] No columns found on board');
    return null;
  }

  // Build column mapping: Jira status id → PulsarTeam column id
  // Each Jira column has statuses[] — we map all statuses in a column to the same pulsar column
  const statusToColumn = {};
  const columns = jiraColumns.map((col, i) => {
    const id = slugify(col.name);
    for (const st of col.statuses || []) {
      statusToColumn[st.id] = id;
      statusToColumn[st.name?.toLowerCase()] = id;
    }
    return {
      id,
      label: col.name,
      color: COLUMN_COLORS[i % COLUMN_COLORS.length],
    };
  });

  // Load current workflow and update columns (preserve transitions that still reference valid columns)
  const workflow = await getWorkflow('_default');
  const oldColumnIds = new Set(workflow.columns.map(c => c.id));
  const newColumnIds = new Set(columns.map(c => c.id));

  // Preserve transitions where both from/to still exist
  const transitions = workflow.transitions.filter(
    t => newColumnIds.has(t.from) && (newColumnIds.has(t.to) || t.to === 'error')
  );

  await updateWorkflow('_default', {
    ...workflow,
    columns,
    transitions,
  });

  console.log(`[Jira] Synced ${columns.length} columns: ${columns.map(c => c.label).join(', ')}`);
  return statusToColumn;
}

/**
 * Fetch issues from the Jira board and create missing todos in PulsarTeam.
 * Returns { created: number, total: number }.
 */
export async function syncIssues(cfg, agentManager, statusToColumn) {
  if (!cfg) cfg = getConfig();
  if (!cfg) return { created: 0, total: 0 };

  if (!statusToColumn) {
    statusToColumn = await syncColumns(cfg);
  }
  if (!statusToColumn) return { created: 0, total: 0 };

  // Fetch all issues on the board (paginated)
  let startAt = 0;
  const maxResults = 50;
  let created = 0;
  let total = 0;

  // Build a set of existing Jira keys to avoid duplicates
  const existingJiraKeys = new Set();
  for (const [, agent] of agentManager.agents) {
    for (const todo of agent.todoList || []) {
      if (todo.jiraKey) existingJiraKeys.add(todo.jiraKey);
    }
  }

  while (true) {
    const data = await jiraFetch(
      cfg,
      `/rest/agile/1.0/board/${cfg.boardId}/issue?startAt=${startAt}&maxResults=${maxResults}&fields=summary,status,assignee,priority,issuetype`
    );

    const issues = data.issues || [];
    total += issues.length;

    for (const issue of issues) {
      if (existingJiraKeys.has(issue.key)) continue;

      const statusName = issue.fields?.status?.name?.toLowerCase() || '';
      const statusId = issue.fields?.status?.id || '';
      const columnId = statusToColumn[statusId] || statusToColumn[statusName] || 'backlog';
      const summary = issue.fields?.summary || issue.key;

      // Find the first enabled agent to own this task (prefer leader, fallback to any)
      let ownerAgent = null;
      for (const [, a] of agentManager.agents) {
        if (a.enabled === false) continue;
        if (a.isLeader) { ownerAgent = a; break; }
        if (!ownerAgent) ownerAgent = a;
      }

      if (!ownerAgent) {
        console.warn(`[Jira] No enabled agent to own issue ${issue.key}`);
        continue;
      }

      const todo = agentManager.addTodo(
        ownerAgent.id,
        `[${issue.key}] ${summary}`,
        null,
        { type: 'jira', name: 'Jira', key: issue.key },
        columnId
      );

      if (todo) {
        // Store Jira metadata on the todo
        const actualTodo = ownerAgent.todoList.find(t => t.id === todo.id);
        if (actualTodo) {
          actualTodo.jiraKey = issue.key;
          actualTodo.jiraStatusId = statusId;
        }
        created++;
      }
    }

    if (startAt + issues.length >= (data.total || issues.length)) break;
    startAt += maxResults;
  }

  if (created > 0) {
    console.log(`[Jira] Created ${created} new tasks from ${total} board issues`);
  }
  return { created, total };
}

/**
 * Push a PulsarTeam status change to Jira.
 * Called when a todo with a jiraKey changes status.
 */
export async function pushStatusToJira(jiraKey, newPulsarStatus) {
  const cfg = getConfig();
  if (!cfg) return;

  try {
    // Get available transitions for this issue
    const data = await jiraFetch(cfg, `/rest/api/3/issue/${jiraKey}/transitions`);
    const transitions = data.transitions || [];

    // Find a transition whose target status name matches our column label
    // We need the workflow columns to map pulsar status → display name
    const workflow = await getWorkflow('_default');
    const column = workflow.columns.find(c => c.id === newPulsarStatus);
    const targetLabel = column?.label?.toLowerCase() || newPulsarStatus;

    const match = transitions.find(t =>
      t.name?.toLowerCase() === targetLabel ||
      t.to?.name?.toLowerCase() === targetLabel ||
      slugify(t.name || '') === newPulsarStatus ||
      slugify(t.to?.name || '') === newPulsarStatus
    );

    if (!match) {
      console.log(`[Jira] No matching transition for ${jiraKey} → "${targetLabel}" (available: ${transitions.map(t => t.name).join(', ')})`);
      return;
    }

    await jiraFetch(cfg, `/rest/api/3/issue/${jiraKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });

    console.log(`[Jira] Pushed status ${jiraKey} → ${match.to?.name || match.name}`);
  } catch (err) {
    console.error(`[Jira] Failed to push status for ${jiraKey}:`, err.message);
  }
}

/**
 * Pull status updates from Jira for known tasks.
 * Checks if any tracked issue changed status and updates PulsarTeam accordingly.
 */
export async function pullStatusUpdates(cfg, agentManager, statusToColumn) {
  if (!cfg) cfg = getConfig();
  if (!cfg) return 0;

  if (!statusToColumn) {
    statusToColumn = await syncColumns(cfg);
  }
  if (!statusToColumn) return 0;

  let updated = 0;

  for (const [agentId, agent] of agentManager.agents) {
    for (const todo of agent.todoList || []) {
      if (!todo.jiraKey) continue;

      try {
        const issue = await jiraFetch(cfg, `/rest/api/3/issue/${todo.jiraKey}?fields=status`);
        const statusName = issue.fields?.status?.name?.toLowerCase() || '';
        const statusId = issue.fields?.status?.id || '';
        const expectedColumn = statusToColumn[statusId] || statusToColumn[statusName];

        if (expectedColumn && expectedColumn !== todo.status) {
          console.log(`[Jira] Status changed for ${todo.jiraKey}: "${todo.status}" → "${expectedColumn}"`);
          agentManager.setTodoStatus(agentId, todo.id, expectedColumn, {
            skipAutoRefine: false,
            by: 'jira-sync',
          });
          // Update stored Jira status
          todo.jiraStatusId = statusId;
          updated++;
        }
      } catch (err) {
        console.error(`[Jira] Failed to pull status for ${todo.jiraKey}:`, err.message);
      }
    }
  }

  if (updated > 0) console.log(`[Jira] Pulled ${updated} status updates from Jira`);
  return updated;
}

// ── Full sync (called periodically) ──────────────────────────────────────────

let _statusToColumn = null;

export async function fullSync(agentManager) {
  const cfg = getConfig();
  if (!cfg) return;

  try {
    _statusToColumn = await syncColumns(cfg);
    if (!_statusToColumn) return;

    await syncIssues(cfg, agentManager, _statusToColumn);
    await pullStatusUpdates(cfg, agentManager, _statusToColumn);
  } catch (err) {
    console.error('[Jira] Full sync failed:', err.message);
  }
}

/**
 * Start periodic Jira sync. Runs immediately on start, then every intervalMs.
 */
export function startJiraSync(agentManager, intervalMs = 60000) {
  const cfg = getConfig();
  if (!cfg) {
    console.log('[Jira] JIRA_BOARD_URL not set — sync disabled');
    return null;
  }

  console.log(`[Jira] Sync enabled for board ${cfg.boardId} on ${cfg.domain} (every ${intervalMs / 1000}s)`);

  // Initial sync
  fullSync(agentManager).catch(err =>
    console.error('[Jira] Initial sync error:', err.message)
  );

  // Periodic sync
  const interval = setInterval(() => {
    fullSync(agentManager).catch(err =>
      console.error('[Jira] Periodic sync error:', err.message)
    );
  }, intervalMs);

  return interval;
}

/**
 * Get current Jira sync status (for UI).
 */
export function getJiraSyncStatus() {
  const cfg = getConfig();
  return {
    enabled: !!cfg,
    boardUrl: process.env.JIRA_BOARD_URL || '',
    domain: cfg?.domain || '',
    projectKey: cfg?.projectKey || '',
    boardId: cfg?.boardId || null,
  };
}

/**
 * Notify Jira when a PulsarTeam todo status changes.
 * Called from agentManager.setTodoStatus.
 */
export function onTodoStatusChanged(todo, newStatus) {
  if (!todo.jiraKey) return;
  if (todo._jiraSyncInProgress) return; // prevent loop
  pushStatusToJira(todo.jiraKey, newStatus).catch(err =>
    console.error(`[Jira] Push error for ${todo.jiraKey}:`, err.message)
  );
}
