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

import { getWorkflow, getSettings, getAllBoardWorkflows, getWorkflowForBoard } from './configManager.js';
import { saveAgent } from './database.js';
import { processTransition } from './transitionProcessor.js';

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

// ── Execute transition actions after Jira import ────────────────────────────

async function executeTransitionActions(trigger, task, agentId, agentManager) {
  const actions = trigger.actions || [];
  if (actions.length === 0) return;

  for (const action of actions) {
    if (action.type === 'change_status' && action.target) {
      agentManager.setTaskStatus(agentId, task.id, action.target, { skipAutoRefine: false, by: 'jira-sync' });
      console.log(`[Jira] Action: moved "${task.text?.slice(0, 50)}" → ${action.target}`);
    } else if (action.type === 'assign_agent' && action.role) {
      // Handled by _checkAutoRefine via autoAssignRole on the target column
    } else if (action.type === 'run_agent') {
      const enrichedTask = {
        ...task, agentId,
        _transition: {
          agent: action.role || '',
          mode: action.mode || 'execute',
          instructions: action.instructions || '',
          to: action.targetStatus || null,
        }
      };
      processTransition(enrichedTask, agentManager, _io).catch(err =>
        console.error(`[Jira] Action run_agent error:`, err.message)
      );
    } else if (action.type === 'move_jira_status' && action.jiraStatusIds?.length) {
      await moveJiraIssue(task.jiraKey, action.jiraStatusIds);
    } else if (action.type === 'jira_ai_comment' && task.jiraKey) {
      analyzeAndCommentJira(task.jiraKey, task, agentId, agentManager, action.instructions || '', action.role || '').catch(err =>
        console.error(`[Jira] AI comment action error:`, err.message)
      );
    }
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

  // Check if Jira is disabled via settings
  const settings = await getSettings();
  if (settings.jiraEnabled === 'false') return;

  // Scan ALL board workflows for jira_ticket triggers
  const boardWorkflows = await getAllBoardWorkflows();
  const allTriggers = []; // { trigger, boardId }
  for (const { boardId, workflow } of boardWorkflows) {
    for (const t of workflow.transitions || []) {
      if (t.trigger === 'jira_ticket' && t.jiraStatusIds?.length > 0) {
        allTriggers.push({ trigger: t, boardId });
      }
    }
  }
  if (allTriggers.length === 0) return;

  // Build set of existing Jira keys
  const existingJiraKeys = new Set();
  for (const [, agent] of agentManager.agents) {
    for (const task of agent.todoList || []) {
      if (task.jiraKey) existingJiraKeys.add(task.jiraKey);
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

  for (const { trigger, boardId } of allTriggers) {
    const watchedStatusIds = new Set(trigger.jiraStatusIds);
    const targetColumn = trigger.from; // the PulsarTeam column to create the task in

    for (const issue of allIssues) {
      const statusId = issue.fields?.status?.id;
      if (!statusId || !watchedStatusIds.has(statusId)) continue;
      if (existingJiraKeys.has(issue.key)) continue;

      // Find creator agent (prefer leader)
      let creatorAgent = null;
      for (const [, a] of agentManager.agents) {
        if (a.enabled === false) continue;
        if (a.isLeader) { creatorAgent = a; break; }
        if (!creatorAgent) creatorAgent = a;
      }
      if (!creatorAgent) continue;

      const summary = issue.fields?.summary || issue.key;
      const task = agentManager.addTask(
        creatorAgent.id,
        `[${issue.key}] ${summary}`,
        null,
        { type: 'jira', name: 'Jira', key: issue.key },
        targetColumn,
        { boardId, skipAutoRefine: true }
      );

      if (task) {
        const actualTask = creatorAgent.todoList.find(t => t.id === task.id);
        if (actualTask) {
          actualTask.jiraKey = issue.key;
          actualTask.jiraStatusId = statusId;
          saveAgent(creatorAgent);
        }
        existingJiraKeys.add(issue.key);
        created++;
        console.log(`[Jira] Imported ${issue.key} "${summary}" → board "${boardId}" column "${targetColumn}"`);
        // Execute transition actions (change_status, run_agent, etc.)
        await executeTransitionActions(trigger, actualTask || task, creatorAgent.id, agentManager);
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

// ── Fetch full Jira issue details (for AI analysis) ─────────────────────────

/**
 * Fetch detailed information about a Jira issue including description,
 * comments, priority, labels, assignee, etc.
 */
export async function getJiraIssueDetails(jiraKey) {
  const cfg = getConfig();
  if (!cfg || !jiraKey) return null;

  try {
    const issue = await jiraFetch(
      cfg,
      `/rest/api/3/issue/${encodeURIComponent(jiraKey)}?fields=summary,description,status,priority,labels,assignee,reporter,issuetype,created,updated,comment`
    );

    // Convert ADF description to plain text (simplified)
    const descText = extractAdfText(issue.fields?.description);

    // Extract existing comments
    const comments = (issue.fields?.comment?.comments || []).map(c => ({
      author: c.author?.displayName || 'Unknown',
      body: extractAdfText(c.body),
      created: c.created,
    }));

    return {
      key: issue.key,
      summary: issue.fields?.summary || '',
      description: descText,
      status: issue.fields?.status?.name || '',
      priority: issue.fields?.priority?.name || '',
      type: issue.fields?.issuetype?.name || '',
      labels: issue.fields?.labels || [],
      assignee: issue.fields?.assignee?.displayName || 'Unassigned',
      reporter: issue.fields?.reporter?.displayName || 'Unknown',
      created: issue.fields?.created || '',
      updated: issue.fields?.updated || '',
      comments,
    };
  } catch (err) {
    console.error(`[Jira] Failed to fetch issue details for ${jiraKey}:`, err.message);
    return null;
  }
}

/**
 * Recursively extract plain text from an Atlassian Document Format (ADF) node.
 */
function extractAdfText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    return node.content.map(extractAdfText).join(node.type === 'paragraph' ? '\n' : '');
  }
  return '';
}

// ── Action: add a comment to a Jira issue ───────────────────────────────────

/**
 * Post a comment on a Jira issue using ADF format (Jira Cloud v3 API).
 */
export async function addCommentToJira(jiraKey, commentText) {
  const cfg = getConfig();
  if (!cfg || !jiraKey || !commentText) return false;

  try {
    // Build ADF document from plain text (split paragraphs on double newline)
    const paragraphs = commentText.split(/\n{2,}/).filter(Boolean);
    const adfContent = paragraphs.map(p => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p.trim() }],
    }));

    await jiraFetch(cfg, `/rest/api/3/issue/${encodeURIComponent(jiraKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: adfContent.length > 0 ? adfContent : [{ type: 'paragraph', content: [{ type: 'text', text: commentText }] }],
        },
      }),
    });

    console.log(`[Jira] Comment added to ${jiraKey} (${commentText.length} chars)`);
    return true;
  } catch (err) {
    console.error(`[Jira] Failed to add comment to ${jiraKey}:`, err.message);
    return false;
  }
}

// ── Action: AI-analyze a task and post comment to Jira ──────────────────────

/**
 * Use an AI agent to analyze a Jira task and post the analysis as a comment.
 * Called as a workflow action when a task enters a column.
 *
 * @param {string} jiraKey - The Jira issue key (e.g. KAN-7)
 * @param {object} task - The PulsarTeam task object
 * @param {string} agentId - The creator agent ID
 * @param {object} agentManager - The AgentManager instance
 * @param {string} instructions - Custom analysis instructions from workflow config
 * @param {string} role - Agent role to use for the analysis
 */
export async function analyzeAndCommentJira(jiraKey, task, agentId, agentManager, instructions, role) {
  if (!jiraKey) return;

  // Fetch full issue details from Jira
  const issueDetails = await getJiraIssueDetails(jiraKey);
  if (!issueDetails) {
    console.error(`[Jira] Cannot analyze ${jiraKey}: failed to fetch issue details`);
    return;
  }

  // Find an appropriate agent
  let agent = null;
  if (role) {
    const agents = Array.from(agentManager.agents.values());
    agent = agents.find(
      a => a.enabled !== false && a.status === 'idle' && (a.role || '').toLowerCase() === role.toLowerCase()
    );
  }
  if (!agent) {
    // Fallback: use any idle enabled agent (prefer leader)
    const agents = Array.from(agentManager.agents.values());
    agent = agents.find(a => a.enabled !== false && a.status === 'idle' && a.isLeader)
      || agents.find(a => a.enabled !== false && a.status === 'idle');
  }

  if (!agent) {
    console.log(`[Jira] No idle agent available for AI analysis of ${jiraKey} — skipping`);
    return;
  }

  // Build the analysis prompt
  const existingComments = issueDetails.comments.length > 0
    ? issueDetails.comments.map(c => `- ${c.author} (${c.created}): ${c.body}`).join('\n')
    : 'None';

  const defaultInstructions = `Analyze this Jira ticket and provide a structured assessment covering:
1. Clarity: Is the ticket well-defined? Are requirements clear?
2. Scope: Estimated complexity and effort
3. Dependencies: Any obvious dependencies or blockers?
4. Acceptance criteria: Are they defined? If not, suggest some
5. Risks: Any potential risks or concerns?
6. Recommendations: Actionable next steps`;

  const prompt = `You are analyzing a Jira ticket that just entered a new workflow column. Analyze it and provide a concise, actionable comment.

--- JIRA TICKET ---
Key: ${issueDetails.key}
Type: ${issueDetails.type}
Priority: ${issueDetails.priority}
Status: ${issueDetails.status}
Summary: ${issueDetails.summary}
Description:
${issueDetails.description || '(no description)'}
Labels: ${issueDetails.labels.join(', ') || 'none'}
Assignee: ${issueDetails.assignee}
Reporter: ${issueDetails.reporter}
Created: ${issueDetails.created}
Existing comments:
${existingComments}
--- END TICKET ---

${instructions || defaultInstructions}

IMPORTANT: Reply with ONLY the comment text to post on the Jira ticket. Do not include any JSON, markdown fences, or meta-instructions. Write as if you are posting directly on the ticket. Start with a brief header like "[AI Analysis]" or "[PulsarTeam Review]".`;

  console.log(`[Jira] AI analyzing ${jiraKey} via agent "${agent.name}"...`);

  try {
    let fullResponse = '';

    if (_io) {
      _io.emit('agent:stream:start', {
        agentId: agent.id,
        agentName: agent.name,
        project: agent.project || null,
      });
    }

    try {
      const result = await agentManager.sendMessage(
        agent.id,
        `[Jira AI Analysis] ${prompt}`,
        (chunk) => {
          fullResponse += chunk;
          if (_io) {
            _io.emit('agent:stream:chunk', {
              agentId: agent.id,
              agentName: agent.name,
              project: agent.project || null,
              chunk,
            });
          }
        }
      );

      const response = (result?.content || fullResponse).trim();

      if (response) {
        const success = await addCommentToJira(jiraKey, response);
        if (success) {
          console.log(`[Jira] AI comment posted to ${jiraKey} via "${agent.name}"`);
        }
      } else {
        console.log(`[Jira] AI analysis returned empty response for ${jiraKey}`);
      }
    } finally {
      if (_io) {
        _io.emit('agent:stream:end', {
          agentId: agent.id,
          agentName: agent.name,
          project: agent.project || null,
        });
        _io.emit('agent:updated', agentManager._sanitize(agent));
      }
    }
  } catch (err) {
    console.error(`[Jira] AI analysis failed for ${jiraKey}:`, err.message);
  }
}

// ── Hook: called from agentManager.setTaskStatus ────────────────────────────

/**
 * When a task with a jiraKey changes status, check if the new column has a
 * "move_jira_status" action and execute it.
 */
export async function onTaskStatusChanged(task, newStatus, agentManager) {
  if (!task.jiraKey) return;

  const cfg = getConfig();
  if (!cfg) return;

  try {
    const workflow = await getWorkflowForBoard(task.boardId);
    // Find transitions FROM this new status that have a move_jira_status or jira_ai_comment action
    const matching = (workflow.transitions || []).filter(t => t.from === newStatus);

    for (const transition of matching) {
      for (const action of transition.actions || []) {
        if (action.type === 'move_jira_status' && action.jiraStatusIds?.length) {
          await moveJiraIssue(task.jiraKey, action.jiraStatusIds);
        } else if (action.type === 'jira_ai_comment' && agentManager) {
          analyzeAndCommentJira(task.jiraKey, task, task.agentId, agentManager, action.instructions || '', action.role || '').catch(err =>
            console.error(`[Jira] AI comment error on status change:`, err.message)
          );
        }
      }
    }
  } catch (err) {
    console.error(`[Jira] onTaskStatusChanged error for ${task.jiraKey}:`, err.message);
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

export async function getJiraSyncStatus() {
  const cfg = getConfig();
  const settings = await getSettings();
  const settingEnabled = settings.jiraEnabled !== 'false';
  return {
    enabled: !!cfg && settingEnabled,
    configured: !!cfg,
    settingEnabled,
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

  // Check if Jira is disabled via settings
  const settingsWH = await getSettings();
  if (settingsWH.jiraEnabled === 'false') return;

  const event = payload.webhookEvent;
  const issue = payload.issue;
  if (!issue?.key || !issue?.fields?.status) return;

  const statusId = issue.fields.status.id;
  const summary = issue.fields.summary || issue.key;

  console.log(`[Jira] Webhook: ${event} ${issue.key} → status "${issue.fields.status.name}" (${statusId})`);

  // Scan all board workflows for jira_ticket triggers
  const boardWorkflows = await getAllBoardWorkflows();
  const allTriggers = []; // { trigger, boardId }
  for (const { boardId, workflow } of boardWorkflows) {
    for (const t of workflow.transitions || []) {
      if (t.trigger === 'jira_ticket' && t.jiraStatusIds?.length > 0) {
        allTriggers.push({ trigger: t, boardId });
      }
    }
  }
  console.log(`[Jira] Webhook: ${allTriggers.length} jira_ticket trigger(s), statusId="${statusId}", watched: ${allTriggers.map(({ trigger: t }) => JSON.stringify(t.jiraStatusIds)).join(', ') || 'none'}`);

  // Check if issue already tracked
  let existingTask = null;
  let existingAgentId = null;
  for (const [agentId, agent] of agentManager.agents) {
    const found = (agent.todoList || []).find(t => t.jiraKey === issue.key);
    if (found) {
      existingTask = found;
      existingAgentId = agentId;
      break;
    }
  }

  if (!existingTask) {
    // Try to import as new task
    for (const { trigger, boardId } of allTriggers) {
      if (!new Set(trigger.jiraStatusIds).has(statusId)) continue;

      let creatorAgent = null;
      for (const [, a] of agentManager.agents) {
        if (a.enabled === false) continue;
        if (a.isLeader) { creatorAgent = a; break; }
        if (!creatorAgent) creatorAgent = a;
      }
      if (!creatorAgent) return;

      const task = agentManager.addTask(
        creatorAgent.id,
        `[${issue.key}] ${summary}`,
        null,
        { type: 'jira', name: 'Jira', key: issue.key },
        trigger.from,
        { boardId, skipAutoRefine: true }
      );
      if (task) {
        const actualTask = creatorAgent.todoList.find(t => t.id === task.id);
        if (actualTask) {
          actualTask.jiraKey = issue.key;
          actualTask.jiraStatusId = statusId;
          saveAgent(creatorAgent);
        }
        console.log(`[Jira] Webhook: imported ${issue.key} → board "${boardId}" column "${trigger.from}"`);
        // Execute transition actions (change_status, run_agent, etc.)
        await executeTransitionActions(trigger, actualTask || task, creatorAgent.id, agentManager);
        if (_io) {
          _io.emit('agent:updated', agentManager._sanitize(creatorAgent));
        }
      }
      return;
    }
  }

  // ── Existing task: check if Jira status moved away from watched columns ──
  // (means the ticket was moved in Jira, not by us)
  if (existingTask && existingTask.jiraStatusId !== statusId) {
    existingTask.jiraStatusId = statusId;
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
