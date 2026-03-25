/**
 * Jira Sync Service — Single-column subprocess mode
 *
 * PulsarTeam acts as a subprocess for ONE Jira column:
 *  - When a ticket enters a watched Jira column → create a task in PulsarTeam
 *  - When a task reaches a configured PulsarTeam column → move the Jira ticket forward
 *
 * Configuration is done via Workflow transitions:
 *  - Trigger: "jira_ticket" — fires when a new Jira issue appears in the watched column
 *  - Action: "move_jira_status" — transitions the Jira issue to the next status
 *
 * Env vars:
 *  JIRA_BOARD_URL   – full board URL (empty = feature disabled)
 *  JIRA_API_KEY     – API token (Basic auth with JIRA_USER_EMAIL)
 *  JIRA_USER_EMAIL  – Atlassian account email
 */

import { getWorkflow } from './workflowManager.js';
import { saveAgent } from './database.js';

// ── Config ────────────────────────────────────────────────────────────────────

function getConfig() {
  const boardUrl = (process.env.JIRA_BOARD_URL || '').trim();
  if (!boardUrl) return null;

  const m = boardUrl.match(
    /https?:\/\/([^/]+)\/.*\/projects\/([^/]+)\/boards\/(\d+)/
  );
  if (!m) {
    console.error('[Jira] Cannot parse JIRA_BOARD_URL:', boardUrl);
    return null;
  }

  const apiKey = (process.env.JIRA_API_KEY || '').trim();
  const userEmail = (process.env.JIRA_USER_EMAIL || '').trim();
  if (!apiKey || !userEmail) {
    console.error('[Jira] JIRA_API_KEY and JIRA_USER_EMAIL are required');
    return null;
  }

  return {
    domain: m[1],
    projectKey: m[2],
    boardId: parseInt(m[3], 10),
    apiKey,
    userEmail,
    baseUrl: `https://${m[1]}`,
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function authHeaders(cfg) {
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

// ── Fetch Jira board columns (for UI dropdown) ──────────────────────────────

let _jiraColumnsCache = null;
let _jiraColumnsCacheTime = 0;

export async function getJiraColumns() {
  const cfg = getConfig();
  if (!cfg) return [];

  // Cache for 5 minutes
  if (_jiraColumnsCache && Date.now() - _jiraColumnsCacheTime < 300000) {
    return _jiraColumnsCache;
  }

  try {
    const boardConfig = await jiraFetch(cfg, `/rest/agile/1.0/board/${cfg.boardId}/configuration`);
    const jiraColumns = boardConfig.columnConfig?.columns || [];

    // Resolve status names (board config only has IDs)
    const columns = [];
    for (const col of jiraColumns) {
      const statusIds = (col.statuses || []).map(s => s.id);
      columns.push({
        name: col.name,
        statusIds,
      });
    }

    _jiraColumnsCache = columns;
    _jiraColumnsCacheTime = Date.now();
    return columns;
  } catch (err) {
    console.error('[Jira] Failed to fetch board columns:', err.message);
    return _jiraColumnsCache || [];
  }
}

// ── Core: poll Jira for issues matching watched columns ─────────────────────

/**
 * Poll Jira and process workflow triggers.
 * Scans workflow transitions for "jira_ticket" triggers, fetches matching
 * issues from Jira, and creates tasks in the configured PulsarTeam column.
 */
export async function pollJira(agentManager) {
  const cfg = getConfig();
  if (!cfg) return;

  const workflow = await getWorkflow('_default');
  if (!workflow?.transitions) return;

  // Find transitions with jira_ticket trigger
  const jiraTriggers = workflow.transitions.filter(
    t => t.trigger === 'jira_ticket' && t.jiraStatusIds?.length > 0
  );
  if (jiraTriggers.length === 0) return;

  // Build set of existing Jira keys
  const existingJiraKeys = new Set();
  for (const [, agent] of agentManager.agents) {
    for (const todo of agent.todoList || []) {
      if (todo.jiraKey) existingJiraKeys.add(todo.jiraKey);
    }
  }

  // Fetch all board issues
  let startAt = 0;
  const maxResults = 50;
  const allIssues = [];
  while (true) {
    const data = await jiraFetch(
      cfg,
      `/rest/agile/1.0/board/${cfg.boardId}/issue?startAt=${startAt}&maxResults=${maxResults}&fields=summary,status`
    );
    const issues = data.issues || [];
    allIssues.push(...issues);
    if (startAt + issues.length >= (data.total || issues.length)) break;
    startAt += maxResults;
  }

  let created = 0;

  for (const trigger of jiraTriggers) {
    const watchedStatusIds = new Set(trigger.jiraStatusIds);
    const targetColumn = trigger.from; // the PulsarTeam column to create the task in

    for (const issue of allIssues) {
      const statusId = issue.fields?.status?.id;
      if (!statusId || !watchedStatusIds.has(statusId)) continue;
      if (existingJiraKeys.has(issue.key)) continue;

      // Find owner agent (prefer leader)
      let ownerAgent = null;
      for (const [, a] of agentManager.agents) {
        if (a.enabled === false) continue;
        if (a.isLeader) { ownerAgent = a; break; }
        if (!ownerAgent) ownerAgent = a;
      }
      if (!ownerAgent) continue;

      const summary = issue.fields?.summary || issue.key;
      const todo = agentManager.addTodo(
        ownerAgent.id,
        `[${issue.key}] ${summary}`,
        null,
        { type: 'jira', name: 'Jira', key: issue.key },
        targetColumn
      );

      if (todo) {
        const actualTodo = ownerAgent.todoList.find(t => t.id === todo.id);
        if (actualTodo) {
          actualTodo.jiraKey = issue.key;
          actualTodo.jiraStatusId = statusId;
          saveAgent(ownerAgent);
        }
        existingJiraKeys.add(issue.key);
        created++;
        console.log(`[Jira] Imported ${issue.key} "${summary}" → column "${targetColumn}"`);
      }
    }
  }

  if (created > 0) {
    console.log(`[Jira] Poll: imported ${created} new issue(s)`);
    if (_io) {
      for (const [, agent] of agentManager.agents) {
        if (agent.todoList?.some(t => t.jiraKey)) {
          _io.emit('agent:updated', agentManager._sanitize(agent));
        }
      }
    }
  }
}

// ── Action: move Jira issue to next status ─────────────────────────────────

/**
 * Transition a Jira issue to one of the target status IDs.
 * Called when a PulsarTeam task with a jiraKey reaches a column with a
 * "move_jira_status" action.
 */
export async function moveJiraIssue(jiraKey, targetStatusIds) {
  const cfg = getConfig();
  if (!cfg || !jiraKey || !targetStatusIds?.length) return false;

  try {
    const data = await jiraFetch(cfg, `/rest/api/3/issue/${jiraKey}/transitions`);
    const transitions = data.transitions || [];

    const targetSet = new Set(targetStatusIds);
    const match = transitions.find(t => targetSet.has(t.to?.id));

    if (!match) {
      console.log(`[Jira] No transition for ${jiraKey} to status IDs [${targetStatusIds.join(',')}] (available: ${transitions.map(t => `${t.name}→${t.to?.id}`).join(', ')})`);
      return false;
    }

    await jiraFetch(cfg, `/rest/api/3/issue/${jiraKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });

    console.log(`[Jira] Moved ${jiraKey} → ${match.to?.name} (${match.to?.id})`);
    return true;
  } catch (err) {
    console.error(`[Jira] Failed to move ${jiraKey}:`, err.message);
    return false;
  }
}

// ── Hook: called from agentManager.setTodoStatus ────────────────────────────

/**
 * When a todo with a jiraKey changes status, check if the new column has a
 * "move_jira_status" action and execute it.
 */
export async function onTodoStatusChanged(todo, newStatus) {
  if (!todo.jiraKey) return;

  const cfg = getConfig();
  if (!cfg) return;

  try {
    const workflow = await getWorkflow('_default');
    // Find transitions FROM this new status that have a move_jira_status action
    const matching = (workflow.transitions || []).filter(t => t.from === newStatus);

    for (const transition of matching) {
      for (const action of transition.actions || []) {
        if (action.type === 'move_jira_status' && action.jiraStatusIds?.length) {
          await moveJiraIssue(todo.jiraKey, action.jiraStatusIds);
          return;
        }
      }
    }
  } catch (err) {
    console.error(`[Jira] onTodoStatusChanged error for ${todo.jiraKey}:`, err.message);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let _io = null;

export function startJiraSync(agentManager, io, intervalMs = 30000) {
  const cfg = getConfig();
  if (!cfg) {
    console.log('[Jira] JIRA_BOARD_URL not set — sync disabled');
    return null;
  }

  _io = io;
  console.log(`[Jira] Sync enabled for ${cfg.domain} board ${cfg.boardId} (poll every ${intervalMs / 1000}s)`);

  // Initial poll
  pollJira(agentManager).catch(err =>
    console.error('[Jira] Initial poll error:', err.message)
  );

  return setInterval(() => {
    pollJira(agentManager).catch(err =>
      console.error('[Jira] Poll error:', err.message)
    );
  }, intervalMs);
}

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

export async function fullSync(agentManager) {
  await pollJira(agentManager);
}

// ── Webhook: real-time notifications from Jira ──────────────────────────────

const WEBHOOK_SECRET = (process.env.JIRA_WEBHOOK_SECRET || process.env.JIRA_API_KEY || '').trim();

/**
 * Verify webhook request authenticity.
 * Supports multiple header formats used by different Jira webhook types:
 *  - X-Automation-Webhook-Token (Jira Automation rules)
 *  - X-Atlassian-Webhook-Identifier (Jira system webhooks — no secret, just presence)
 *  - Authorization: Bearer ... (custom setups)
 *  - ?secret=... query param (manual config)
 */
export function verifyWebhook(req) {
  if (!WEBHOOK_SECRET) return false;
  const token =
    req.headers['x-automation-webhook-token'] ||
    req.headers['x-jira-webhook-secret'] ||
    req.query.secret ||
    (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null);
  if (token && token === WEBHOOK_SECRET) return true;
  // Jira system webhooks: no secret header — allow if request comes from Atlassian
  // (X-Atlassian-Webhook-Identifier is always present on system webhooks)
  if (req.headers['x-atlassian-webhook-identifier']) return true;
  return false;
}

/**
 * Handle a Jira webhook event.
 * Supported: issue_updated, issue_created (status transitions).
 */
export async function handleWebhook(payload, agentManager) {
  const cfg = getConfig();
  if (!cfg) return;

  const event = payload.webhookEvent;
  const issue = payload.issue;
  if (!issue?.key || !issue?.fields?.status) return;

  const statusId = issue.fields.status.id;
  const summary = issue.fields.summary || issue.key;

  console.log(`[Jira] Webhook: ${event} ${issue.key} → status "${issue.fields.status.name}" (${statusId})`);

  const workflow = await getWorkflow('_default');
  if (!workflow?.transitions) return;

  // ── Check if this issue matches a jira_ticket trigger (new import) ──
  const jiraTriggers = workflow.transitions.filter(
    t => t.trigger === 'jira_ticket' && t.jiraStatusIds?.length > 0
  );

  // Check if issue already tracked
  let existingTodo = null;
  let existingAgentId = null;
  for (const [agentId, agent] of agentManager.agents) {
    const found = (agent.todoList || []).find(t => t.jiraKey === issue.key);
    if (found) {
      existingTodo = found;
      existingAgentId = agentId;
      break;
    }
  }

  if (!existingTodo) {
    // Try to import as new task
    for (const trigger of jiraTriggers) {
      if (!new Set(trigger.jiraStatusIds).has(statusId)) continue;

      let ownerAgent = null;
      for (const [, a] of agentManager.agents) {
        if (a.enabled === false) continue;
        if (a.isLeader) { ownerAgent = a; break; }
        if (!ownerAgent) ownerAgent = a;
      }
      if (!ownerAgent) return;

      const todo = agentManager.addTodo(
        ownerAgent.id,
        `[${issue.key}] ${summary}`,
        null,
        { type: 'jira', name: 'Jira', key: issue.key },
        trigger.from
      );
      if (todo) {
        const actualTodo = ownerAgent.todoList.find(t => t.id === todo.id);
        if (actualTodo) {
          actualTodo.jiraKey = issue.key;
          actualTodo.jiraStatusId = statusId;
          saveAgent(ownerAgent);
        }
        console.log(`[Jira] Webhook: imported ${issue.key} → column "${trigger.from}"`);
        if (_io) {
          _io.emit('agent:updated', agentManager._sanitize(ownerAgent));
        }
      }
      return;
    }
  }

  // ── Existing task: check if Jira status moved away from watched columns ──
  // (means the ticket was moved in Jira, not by us)
  if (existingTodo && existingTodo.jiraStatusId !== statusId) {
    existingTodo.jiraStatusId = statusId;
    console.log(`[Jira] Webhook: ${issue.key} status updated to "${issue.fields.status.name}"`);
    // Don't auto-move the PulsarTeam task — Jira status changes from outside
    // are informational. The workflow transitions in PulsarTeam drive the flow.
  }
}

/**
 * Register a webhook in Jira for the configured project.
 * Called on startup if JIRA_WEBHOOK_URL is set.
 */
export async function registerWebhook() {
  const cfg = getConfig();
  const webhookUrl = (process.env.JIRA_WEBHOOK_URL || '').trim();
  if (!cfg || !webhookUrl) return;

  try {
    // List existing webhooks to avoid duplicates
    const existing = await jiraFetch(cfg, '/rest/webhooks/1.0/webhook');
    const alreadyRegistered = (Array.isArray(existing) ? existing : []).find(
      w => w.url === webhookUrl
    );

    if (alreadyRegistered) {
      console.log(`[Jira] Webhook already registered: ${alreadyRegistered.name} (id: ${alreadyRegistered.self})`);
      return;
    }

    const webhook = await jiraFetch(cfg, '/rest/webhooks/1.0/webhook', {
      method: 'POST',
      body: JSON.stringify({
        name: 'PulsarTeam Sync',
        url: webhookUrl,
        events: [
          'jira:issue_created',
          'jira:issue_updated',
        ],
        filters: {
          'issue-related-events-section': `project = ${cfg.projectKey}`,
        },
        excludeBody: false,
      }),
    });

    console.log(`[Jira] Webhook registered: ${webhookUrl}`);
  } catch (err) {
    console.error(`[Jira] Failed to register webhook:`, err.message);
    console.log('[Jira] You can register it manually in Jira: Settings > System > WebHooks');
    console.log(`[Jira]   URL: ${webhookUrl}`);
    console.log(`[Jira]   Events: Issue Created, Issue Updated`);
    console.log(`[Jira]   JQL filter: project = ${cfg.projectKey}`);
  }
}
