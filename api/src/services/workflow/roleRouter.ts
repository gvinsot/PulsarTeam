/**
 * RoleRouter — automatic agent-role selection for workflow actions.
 *
 * A run_agent / assign_agent action can set role === AUTO_ROLE ('__auto__')
 * instead of a fixed role. When it does, `resolveAutoRole` asks the
 * admin-configured "Role Router LLM" (settings.roleRouterLlmConfigId) to read
 * the task and choose the best-fit role among the roles actually available on
 * the task's board.
 *
 * On any failure (no model configured, model deleted, LLM error, unparseable
 * answer, no eligible role) this THROWS. The caller (ActionExecutor.executeAction)
 * turns the throw into an { error } result so WorkflowEngine marks the task in
 * error with the message — which also stops the chain and prevents the
 * on_enter / condition retry from re-invoking the LLM in a loop.
 */

import { getSettings } from '../configManager.js';
import { getLlmConfig } from '../database.js';
import { createProvider } from '../llmProviders.js';

const ROLE_ROUTER_TIMEOUT_MS = 30_000;
const ROLE_DESC_MAX_CHARS = 300;

/**
 * Collect the distinct roles of agents eligible to act on this task, keyed by
 * role, with a short description sourced from one agent's instructions (used to
 * help the LLM disambiguate similarly-named roles).
 *
 * The board is a preference, not a filter (same rule as AgentSelector): route
 * within the board's own roles when it has any, otherwise offer every role the
 * owner has an agent for instead of failing the action outright.
 */
function _collectAvailableRoles(
  agents: Map<any, any>,
  ownerId: string | null,
  boardId: string | null
) {
  const roleMap = new Map<string, { agents: string[]; description: string; onBoard: boolean }>();
  for (const a of agents.values()) {
    if (a.enabled === false) continue;
    if (ownerId && a.ownerId && a.ownerId !== ownerId) continue;
    const role = (a.role || '').trim();
    if (!role) continue;
    let entry = roleMap.get(role);
    if (!entry) {
      entry = { agents: [], description: '', onBoard: false };
      roleMap.set(role, entry);
    }
    entry.agents.push(a.name || a.id);
    if (boardId && a.boardId === boardId) entry.onBoard = true;
    if (!entry.description && a.instructions) {
      entry.description = String(a.instructions)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, ROLE_DESC_MAX_CHARS);
    }
  }
  if (boardId) {
    const onBoard = new Map([...roleMap].filter(([, entry]) => entry.onBoard));
    if (onBoard.size > 0) return onBoard;
    if (roleMap.size > 0) {
      console.warn(
        `[RoleRouter] board="${boardId}" has no enabled agent — routing across every available role`
      );
    }
  }
  return roleMap;
}

/**
 * Resolve an automatic role for a task.
 *
 * @param {Object} task     - the task (needs id, boardId, text/title, type, project)
 * @param {Object} context  - { agentManager, ownerId }
 * @returns {Promise<string>} the chosen role (guaranteed to be one of the
 *   available roles). Throws on any failure.
 */
export async function resolveAutoRole(task: any, { agentManager, ownerId }: any): Promise<string> {
  const boardId = task.boardId || null;
  const roleMap = _collectAvailableRoles(agentManager.agents, ownerId || null, boardId);
  const roles = [...roleMap.keys()];

  if (roles.length === 0) {
    throw new Error(
      'Automatic role selection: no eligible agent role is available — add an agent (or check it is enabled) and retry.'
    );
  }
  // Nothing to route when a single role exists — use it without an LLM call so
  // the workflow keeps working even before the Role Router LLM is configured.
  if (roles.length === 1) {
    console.log(
      `[RoleRouter] task="${task.id}": only one role available ("${roles[0]}") — using it without LLM.`
    );
    return roles[0];
  }

  const settings = await getSettings();
  const llmConfigId = (settings.roleRouterLlmConfigId || '').toString().trim();
  if (!llmConfigId) {
    throw new Error(
      'Automatic role selection is enabled on this action, but no "Workflow Role Router LLM" is configured in Admin Settings.'
    );
  }
  const cfg = await getLlmConfig(llmConfigId);
  if (!cfg) {
    throw new Error(
      `Automatic role selection: the configured Role Router LLM (id=${llmConfigId}) no longer exists — pick another one in Admin Settings.`
    );
  }

  const roleList = roles
    .map(r => {
      const desc = roleMap.get(r)!.description;
      return `- ${r}${desc ? `: ${desc}` : ''}`;
    })
    .join('\n');

  const sys =
    'You are a task router for a multi-agent software team. Given a task and the ' +
    'list of available agent roles, choose the single role best suited to carry ' +
    'out the task. Reply with ONLY the exact role name copied verbatim from the ' +
    'list — no quotes, no punctuation, no explanation.';
  const user = [
    `Task title: ${task.title || task.text || '(untitled)'}`,
    task.title && task.text && task.text !== task.title
      ? `Task details: ${String(task.text).slice(0, 2000)}`
      : '',
    task.type ? `Task type: ${task.type}` : '',
    task.project ? `Project: ${task.project}` : '',
    '',
    'Available roles:',
    roleList,
    '',
    'Reply with ONLY one role name from the list above.',
  ]
    .filter(Boolean)
    .join('\n');

  const provider = createProvider({
    provider: cfg.provider,
    model: cfg.model,
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
  });

  let resp: any;
  try {
    resp = await provider.chat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      {
        maxTokens: 50,
        temperature: cfg.temperature ?? 0,
        signal: AbortSignal.timeout(ROLE_ROUTER_TIMEOUT_MS),
      }
    );
  } catch (err: any) {
    throw new Error(
      `Automatic role selection: the Role Router LLM (${cfg.provider}/${cfg.model}) call failed — ${err?.message || err}.`
    );
  }

  const raw = (resp?.content || '')
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, '')
    .trim();
  const lower = raw.toLowerCase();
  // Exact match first; then tolerate the model echoing extra words around it.
  const picked =
    roles.find(r => r.toLowerCase() === lower) || roles.find(r => lower.includes(r.toLowerCase()));
  if (!picked) {
    throw new Error(
      `Automatic role selection: the Role Router LLM returned "${raw}", which is not one of the available roles (${roles.join(', ')}).`
    );
  }

  console.log(
    `[RoleRouter] task="${task.id}": routed to role "${picked}" (of ${roles.length}) via ${cfg.provider}/${cfg.model}`
  );
  return picked;
}
