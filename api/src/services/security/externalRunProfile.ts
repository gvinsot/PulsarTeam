// ── The restricted profile an agent runs under while working an external task ─
//
// Approval (lib/taskTrust.ts) means a human read the task. It does not mean the
// text is harmless: an instruction can hide in plain sight, and the agent that
// executes it holds a shell, credentials, MCP servers and a git remote. So an
// external task — approved or not — only ever runs inside this profile,
// whatever the agent's own configuration says:
//
//   • credentials are left out of the prompt and of the CLI instruction file;
//   • no MCP server is reachable (native `mcp_call`, the CLI gateway's
//     `list_mcps` / `call_mcp_tool`), no other agent can be asked, no skill
//     edited, no task moved or deleted — `update_task` works on this task only;
//   • the run starts from an EMPTY context and leaves an empty context behind:
//     the conversation history is dropped and the CLI session restarted when
//     the agent enters the profile and again when it leaves it. Otherwise
//     secrets from earlier chats would be readable by the injected run, and the
//     injected text would linger into the next, fully privileged, task.
//
// The profile is PERSISTED on the agent (`agent.securityProfile`), not held in
// memory, so it survives a crash and is visible to every API replica — the CLI
// instruction file is fetched by the runner from whichever replica answers.
// It fails closed: an agent that crashed inside it stays restricted until its
// next non-external run (or an explicit context reload) resets it.
//
// What it does NOT do: narrow the runner permissions (network, skipped
// permission prompts). Two runner behaviours make that unsafe today
// (runner-service/src/backends/claude_code.py):
//   • `_apply_permissions_to_settings` MERGES deny rules into settings.json and
//     never removes them — one confined spawn would leave `git`, `npm`, `curl`…
//     denied on that agent for good;
//   • without --dangerously-skip-permissions the CLI asks for approval on every
//     tool, and nobody answers the PTY of a workflow run.
// Network confinement for CLI runners needs those fixed first; native agents
// get the `run_command` filter below.

import { saveAgent } from '../database/agents.js';
import { getTaskByActionRunningAgent } from '../database/tasks.js';
import { isExternalTask } from '../../lib/taskTrust.js';
import { isCliRunner } from '../runners.js';
import { errorMessage } from '../../lib/errors.js';

export interface AgentSecurityProfile {
  mode: 'external';
  /** The external task this profile was entered for. */
  taskId: string;
  since: string;
}

interface ProfileCarrier {
  id: string;
  name?: string;
  runner?: string | null;
  securityProfile?: AgentSecurityProfile | null;
  conversationHistory?: unknown[];
  [key: string]: unknown;
}

/** Is the agent currently confined to the external-task profile? */
export function isRestrictedAgent(agent: ProfileCarrier | null | undefined): boolean {
  return agent?.securityProfile?.mode === 'external';
}

/** Credentials to render into a prompt or instruction file. */
export function effectiveCredentials(
  agent: ProfileCarrier & { credentials?: Record<string, string> }
): Record<string, string> {
  return isRestrictedAgent(agent) ? {} : agent.credentials || {};
}

/**
 * Native tools an agent may not call inside the profile. Everything here
 * either reaches beyond the task (other agents, MCP servers, the skill
 * library, other boards) or destroys evidence.
 */
const BLOCKED_NATIVE_TOOLS = new Set([
  'mcp_call',
  'ask_agent',
  'create_skill',
  'update_skill',
  'delete_skill',
  'move_task_to_board',
  'delete_task',
]);

/**
 * Shell commands that open a network connection or publish code. The runner
 * enforces `internetAccess:false` for Claude Code through its settings, but the
 * native `run_command` path only checks shellAccess — this closes the obvious
 * doors there. A heuristic, like any command filter: the history reset and the
 * missing credentials are what bound the damage if it is bypassed.
 */
const NETWORK_COMMAND_RE =
  /(^|[\s;&|(`$])(curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|ftp|nslookup|dig|ping)(\s|$)|\bgit\s+(push|remote\s+(add|set-url))\b|\b(npm|pnpm|yarn)\s+publish\b|\/dev\/tcp\//i;

/**
 * Why a native tool call is refused inside the profile, or null when allowed.
 * `args` is the parsed argument list the native tool loop hands the hooks.
 */
export function restrictedToolRefusal(
  agent: ProfileCarrier,
  toolName: string,
  args: unknown[]
): string | null {
  if (!isRestrictedAgent(agent)) return null;
  const profile = agent.securityProfile!;
  if (BLOCKED_NATIVE_TOOLS.has(toolName)) {
    return `⛔ "${toolName}" is disabled while working on an external task (restricted security profile).`;
  }
  if (toolName === 'run_command' && NETWORK_COMMAND_RE.test(args.map(String).join(' '))) {
    return '⛔ Network and publishing commands are disabled while working on an external task (restricted security profile).';
  }
  if (toolName === 'update_task') {
    const target = String(args[0] ?? '');
    if (target && !profile.taskId.startsWith(target) && target !== profile.taskId) {
      return '⛔ Only the external task being worked on can be updated (restricted security profile).';
    }
  }
  return null;
}

/**
 * Is the agent confined, judged from the DATABASE as well as its own flag?
 * The CLI gateway and the runner-instructions endpoint may be served by a
 * replica whose in-memory agent is stale; the running task row is shared.
 */
export async function isAgentConfined(agent: ProfileCarrier | null | undefined): Promise<boolean> {
  if (!agent) return false;
  if (isRestrictedAgent(agent)) return true;
  try {
    const running = await getTaskByActionRunningAgent(agent.id);
    return isExternalTask(running);
  } catch {
    // Unknown means confined: this answers "may secrets and tools be exposed".
    return true;
  }
}

/** The external task id the agent is confined to, when it is. */
export async function confinedTaskId(agent: ProfileCarrier): Promise<string | null> {
  if (isRestrictedAgent(agent)) return agent.securityProfile!.taskId;
  const running = await getTaskByActionRunningAgent(agent.id).catch(() => null);
  return isExternalTask(running) ? running!.id : null;
}

interface ProfileManager {
  executionManager?: {
    closeCliTerminalSessions?: (agentId: string) => Promise<boolean>;
    closeTerminalSession?: (agentId: string) => Promise<boolean>;
  } | null;
  addActionLog?: (agentId: string, type: string, message: string) => void;
  _emit?: (event: string, payload: unknown) => void;
  _sanitize?: (agent: unknown) => unknown;
}

/**
 * Put the agent in the profile the task needs BEFORE the task's text reaches
 * it. Entering, leaving, or switching between two external tasks resets the
 * context (see the module header). Running a tenant task on an agent that is
 * not confined, or resuming the same external task, changes nothing.
 */
export async function enterRunProfileForTask(
  agentManager: ProfileManager,
  agent: ProfileCarrier,
  task: { id: string; trustLevel?: string | null }
): Promise<void> {
  const wantExternal = isExternalTask(task);
  const current = agent.securityProfile || null;
  if (!wantExternal && !current) return;
  if (wantExternal && current?.taskId === task.id) return;

  agent.securityProfile = wantExternal
    ? { mode: 'external', taskId: task.id, since: new Date().toISOString() }
    : null;
  if (!agent.securityProfile) delete agent.securityProfile;

  // A fresh context on both sides of the boundary. The conversation goes; task
  // execution flags are left alone on purpose (clearHistory would also reset
  // them, racing the run that is about to start).
  agent.conversationHistory = [];
  agent.currentThinking = '';
  agent.runnerSessions = {};
  delete agent._compactionArmed;
  await saveAgent(agent as Parameters<typeof saveAgent>[0]);

  // The CLI's permissions and instruction file are applied at spawn: closing
  // the session makes the next input spawn a CLI under the new profile.
  if (isCliRunner(agent as Parameters<typeof isCliRunner>[0])) {
    const exec = agentManager.executionManager;
    try {
      if (exec?.closeCliTerminalSessions) await exec.closeCliTerminalSessions(agent.id);
      else if (exec?.closeTerminalSession) await exec.closeTerminalSession(agent.id);
    } catch (err) {
      console.warn(
        `⚠️ [SecurityProfile] Could not restart the CLI session of "${agent.name}": ${errorMessage(err)}`
      );
    }
  }

  const message = wantExternal
    ? `Restricted profile ON for external task ${task.id.slice(0, 8)} — context reset, no credentials, no MCP`
    : 'Restricted profile OFF — context reset before a regular task';
  console.log(`🛡️ [SecurityProfile] "${agent.name}": ${message}`);
  agentManager.addActionLog?.(agent.id, 'info', message);
  agentManager._emit?.('agent:updated', agentManager._sanitize?.(agent) ?? agent);
}

/** Leave the profile without starting a task — used by an explicit context reload. */
export function clearRunProfile(agent: ProfileCarrier): boolean {
  if (!agent.securityProfile) return false;
  delete agent.securityProfile;
  return true;
}

export const __testing = { BLOCKED_NATIVE_TOOLS, NETWORK_COMMAND_RE };
