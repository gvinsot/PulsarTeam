// ── Runner workspace preparation ─────────────────────────────────────────────
//
// The one place that knows how to make a runner container actually READY to
// work on a repo: clone present, and the agent's git credentials installed in
// its HOME.
//
// Why this module exists — "some agents can push, some can't":
//
//   `executionManager.bindAgent()` only STORES credentials API-side; they reach
//   the runner on the next `/projects/ensure` (ensureProject/switchProject) or
//   `/credentials/git` (installGitCredentials) call. Both task-execution paths
//   used to skip every one of those calls whenever
//
//       task.repoFullName === agent.project        (nothing to switch to)
//     or the task carried no repo at all,
//
//   which is API-side state: `agent.project` is persisted, so it survives an API
//   restart AND the replacement of the runner container. A recycled runner then
//   has no clone of the repo (the runner falls back to cwd=/app) and no
//   `~/.git-credentials`, so the agent's first `git push` dies with
//
//       fatal: could not read Username for 'https://github.com'
//
//   while an agent whose task moved it to a DIFFERENT repo took the
//   `switchProject` branch, got both the clone and the token, and pushed fine.
//   That is the whole inconsistency: not a bad instruction to the agent, a
//   missing (and cheap) idempotent ensure.
//
// `ensureProject` is idempotent on the runner side (clone-or-update, existing
// working copies preserved) and debounced API-side by a 60s TTL, so calling it
// on the "already on the right repo" path costs at most one HTTP round-trip per
// agent per minute.
//
// The chat path (services/agentManager/chat.ts) already did this and documents
// the same failure mode; these helpers exist so the task paths, the workflow
// action executor and chat share one implementation instead of three.

import { buildRepoCloneUrl } from '../repoUrl.js';
import { errorMessage } from '../../lib/errors.js';

/** What `getGitHubCredentialsForAgent` resolves to. */
export interface AgentGitCredentials {
  token: string;
  login?: string | null;
  username?: string | null;
  provider?: string;
}

/** A task-scoped repo cloned alongside the primary one. */
export interface SecondaryRepoRef {
  provider?: string;
  fullName: string;
}

/** The agent fields the preparation reads. */
export interface WorkspaceAgent {
  id: string;
  name?: string;
  project?: string | null;
  boardId?: string | null;
}

/**
 * The execution-manager surface used here. `AgentManager.executionManager` is
 * typed `any`, so this states what is actually called rather than widening the
 * lie; every member is optional because the sandbox-less test doubles omit most
 * of them.
 */
export interface WorkspaceExecutionManager {
  setSecondaryRepos?(agentId: string, repos: SecondaryRepoRef[] | null): void;
  ensureProject?(
    agentId: string,
    project: string | null,
    gitUrl: string | null,
    gitCredentials: AgentGitCredentials | null
  ): Promise<void>;
  switchProject?(
    agentId: string,
    project: string,
    gitUrl: string | null,
    gitCredentials: AgentGitCredentials | null
  ): Promise<void>;
  installGitCredentials?(agentId: string, creds: AgentGitCredentials | null): Promise<void>;
  getProject?(agentId: string): string | null;
}

export interface EnsureAgentWorkspaceOptions {
  /** `owner/repo` the task is bound to, or null when it carries none. */
  repo: string | null;
  /** Clone URL carried by the task row, if any; falls back to the github URL. */
  repoHtmlUrl?: string | null;
  /** Task-scoped secondary repos, cloned alongside the primary. */
  secondaryRepos?: SecondaryRepoRef[];
  /** Credentials resolved by `resolveAgentGitCredentials`. */
  gitCredentials?: AgentGitCredentials | null;
}

export interface EnsureAgentWorkspaceResult {
  /** True when the runner was moved to a repo the agent wasn't on before —
   *  the caller still owns the API-side history/context switch. */
  switched: boolean;
  /** True when the runner was asked to prepare a repo (ensure or switch). */
  prepared: boolean;
}

/**
 * Resolve the agent's GitHub credentials, never throwing: a credential lookup
 * failure must not abort a task, it just means the runner keeps whatever token
 * it already has.
 */
export async function resolveAgentGitCredentials(
  agent: WorkspaceAgent | null | undefined
): Promise<AgentGitCredentials | null> {
  if (!agent?.id) return null;
  try {
    const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
    return await getGitHubCredentialsForAgent(agent.id, agent.boardId || null);
  } catch (err) {
    console.warn(
      `🤖 [Runner] Could not resolve git credentials for agent ${agent.id.slice(0, 8)}: ${errorMessage(err)}`
    );
    return null;
  }
}

/**
 * Make the runner ready for `repo` and make sure it holds the agent's git
 * credentials. Throws when the runner ends up on a different repo than the task
 * requires, or when the underlying ensure/switch fails — the callers turn that
 * into their own task-level error (the action executor recognises GitHub auth
 * failures there and raises a user-facing alert).
 */
export async function ensureAgentWorkspace(
  executionManager: WorkspaceExecutionManager | null | undefined,
  agent: WorkspaceAgent,
  {
    repo,
    repoHtmlUrl = null,
    secondaryRepos = [],
    gitCredentials = null,
  }: EnsureAgentWorkspaceOptions
): Promise<EnsureAgentWorkspaceResult> {
  const switched = !!repo && repo !== (agent.project || null);
  if (!executionManager) return { switched, prepared: false };

  // Push the keep-set FIRST so every subsequent ensure (including the frequent
  // primary-only ones from tool batches) preserves the secondaries instead of
  // pruning them.
  executionManager.setSecondaryRepos?.(agent.id, secondaryRepos);

  const gitUrl = repo ? repoHtmlUrl || buildRepoCloneUrl(repo) : null;

  if (repo && gitUrl) {
    // A switch (or a new secondary) must bypass the ensure debounce; the
    // "already on it" case goes through the debounced, idempotent ensure, which
    // is precisely what repairs a recycled runner.
    if (switched || secondaryRepos.length > 0) {
      await executionManager.switchProject?.(agent.id, repo, gitUrl, gitCredentials);
    } else {
      await executionManager.ensureProject?.(agent.id, repo, gitUrl, gitCredentials);
    }
    // The runner is the source of truth about where it actually is.
    const envProject = executionManager.getProject?.(agent.id);
    if (envProject && envProject !== repo) {
      throw new Error(`Execution environment is on "${envProject}" but task requires "${repo}"`);
    }
    return { switched, prepared: true };
  }

  if (repo && !gitUrl) {
    console.warn(`🤖 [Runner] No git URL for repo "${repo}" — execution env may not match`);
  }
  // No repo to clone: the token still has to reach the runner, or the agent
  // cannot clone/push anything it decides to touch on its own.
  if (gitCredentials?.token) {
    await executionManager.installGitCredentials?.(agent.id, gitCredentials);
  }
  return { switched, prepared: false };
}
