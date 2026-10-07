// Commit attribution uses local creation events, scoped to one task execution.
// Repository history alone is insufficient: pulls bring in unrelated commits,
// including commits with the same identity when several agents share an email.
// The primary project clone and the task's secondary clones (cloned next to it
// by the runner) are inspected; anything else needs an explicit link.
import { getTaskById, updateTaskFields, clearTaskCommitRun } from '../../database.js';
import type { Task, TaskCommitRunRecord } from '../../database/tasks.js';
import { errorMessage } from '../../../lib/errors.js';

export interface TaskCommitRun {
  taskId: string;
  baselineHead: string | null;
  startedAt: string;
  /** Baseline HEAD of each secondary repo of the task ("owner/repo" → hash). */
  secondaryBaselines?: Record<string, string | null>;
}

// Do not infer a run from task.startedAt (which can belong to an earlier attempt),
// an agent's name, or its recently completed tasks. No context means no auto-link.
const commitRuns = new WeakMap<object, Map<string, TaskCommitRun>>();

export function beginTaskCommitRun(manager: object, agentId: string, run: TaskCommitRun): void {
  let runs = commitRuns.get(manager);
  if (!runs) commitRuns.set(manager, (runs = new Map()));
  runs.set(agentId, run);
}

export function getTaskCommitRun(manager: object, agentId: string): TaskCommitRun | undefined {
  return commitRuns.get(manager)?.get(agentId);
}

export function endTaskCommitRun(manager: object, agentId: string, taskId: string): void {
  if (getTaskCommitRun(manager, agentId)?.taskId === taskId) {
    commitRuns.get(manager)?.delete(agentId);
  }
}

export interface DetectedCommit {
  hash: string;
  msg: string;
  /** true = reachable from a remote-tracking ref, false = local-only.
   *  undefined when the unpushed query failed (unknown). */
  pushed?: boolean;
  /** "owner/repo" for a commit of a SECONDARY repo; absent for the primary. */
  repo?: string;
}

// A secondary repo name goes into a shell command: GitHub-shaped names only, and
// never a `.`/`..` segment (which would point outside the projects/ base).
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function isUsableRepoName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const parts = name.split('/');
  return parts.length === 2 && parts.every(p => REPO_SEGMENT.test(p) && p !== '.' && p !== '..');
}

/** `git` invocation for the primary clone (exec cwd) or a secondary clone, which
 *  the runner places under the same projects/ base as the primary (owner/repo).
 *  The name travels through a shell variable: an "owner/repo" such as dev/x
 *  spelled out after the `../../` would read as a system path to the runner's
 *  command filter. */
function gitIn(repo?: string | null): string {
  if (!repo) return 'git';
  return `R='${repo}'; git -C "$(git rev-parse --show-toplevel)/../../$R"`;
}

/** A failed Git query is unknown, never an empty successful result. */
async function _execGit(
  executionManager: any,
  agentId: string,
  command: string,
  timeout: number = 10000
): Promise<string | null> {
  if (typeof executionManager?.exec !== 'function') return null;
  try {
    const result = await executionManager.exec(agentId, command, { timeout });
    if (result.exitCode || result.code || result.status === 'error') return null;
    const output = (result.stdout || result.stderr || '').trim();
    return /^(fatal|error):/im.test(output) ? null : output;
  } catch (err: any) {
    console.warn(
      `⚠️ [git-reconcile] Query failed for agent ${agentId}: ${err?.message || 'unknown'}`
    );
    return null;
  }
}

/** Capture the repo HEAD before a run so the reconcile can diff baseline..HEAD
 *  afterwards. Returns null when the environment isn't ready, the project is
 *  not a git repo, or the command fails — callers fall back to a time window.
 *
 *  Deliberately NOT gated on hasEnvironment(): that map is API-side in-memory
 *  state populated by ensureProject, so after an API restart a CLI runner
 *  already sitting on the right repo never re-ensures and the gate would skip
 *  detection forever. exec() → runner /exec-shell resolves the agent's project
 *  dir server-side and works regardless; a non-repo answers "fatal:" which we
 *  filter. (This same gate is why recordTaskCompletion's detection could miss.)
 *  `repo` targets one of the task's secondary clones instead of the primary. */
export async function snapshotGitBaseline(
  executionManager: any,
  agentId: string,
  repo: string | null = null
): Promise<string | null> {
  if (typeof executionManager?.exec !== 'function') return null;
  if (repo && !isUsableRepoName(repo)) return null;
  const output = await _execGit(executionManager, agentId, `${gitIn(repo)} rev-parse HEAD`);
  if (!output) return null;
  // Tolerate noisy output — pick the first valid 40-hex hash
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[a-f0-9]{40}$/.test(trimmed)) {
      return trimmed;
    }
  }
  console.warn(
    `⚠️  [git-reconcile] Could not parse HEAD for agent ${agentId}: ${output.slice(0, 100)}`
  );
  return null;
}

// Sequencer replays and amends rewrite an EXISTING change: the new hash is a
// creation event in the reflog, but the work may predate the run (a previous
// task's unpushed commit replayed by `pull --rebase`). Git keeps the author
// date through all of them, so for these the author date must fall in the run
// too — unless the rewritten change is one this task already owns.
const REWRITE_OPERATION = /\((pick|reword|squash|fixup|edit|continue)\)|^commit \(amend\)/i;

// Reflogs that record work done in this clone: HEAD (every worktree) and local
// branches. Remote-tracking refs record what a fetch BROUGHT ("pull: storing
// head"), and the stash is not history.
const LOCAL_REFLOG = /^(HEAD|refs\/heads\/.+)@\{(\d+)\}$/;

const HASH = /^[a-f0-9]{7,40}$/;

export interface DetectOptions {
  baselineHead?: string | null;
  startedAt?: string | null;
  /** Close of the run's window (ISO): later events belong to someone else. */
  until?: string | null;
  secondaryRepo?: string | null;
  /** Hashes already linked to the task: a rewrite of one of them (rebased by a
   *  later run of the same task) is still this task's commit. */
  ownCommits?: string[];
}

/**
 * Require a creation event in this clone during this run. A commit's author,
 * committer, subject, timestamp or presence in a push range cannot prove this.
 * Reflog event dates describe the local operation, so cherry-picks retain their
 * original author dates without being lost. Pull/reset/checkout events never
 * count as creation. Missing reflogs or failed queries fail closed.
 */
export async function detectCommitsSinceBaseline(
  executionManager: any,
  agentId: string,
  options: DetectOptions = {}
): Promise<DetectedCommit[]> {
  return (await detectCommits(executionManager, agentId, options)) ?? [];
}

/** detectCommitsSinceBaseline, but null when a git query failed — "unknown",
 *  which a caller that must not lose a run's commits keeps retrying. */
export async function detectCommits(
  executionManager: any,
  agentId: string,
  {
    baselineHead,
    startedAt,
    until = null,
    secondaryRepo = null,
    ownCommits = [],
  }: DetectOptions = {}
): Promise<DetectedCommit[] | null> {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return [];
  if (secondaryRepo && !isUsableRepoName(secondaryRepo)) return [];
  const startSec = Math.floor(start / 1000);
  const untilMs = until ? Date.parse(until) : NaN;
  const untilSec = Number.isFinite(untilMs) ? Math.ceil(untilMs / 1000) : null;
  const git = gitIn(secondaryRepo);
  const reflog = await _execGit(
    executionManager,
    agentId,
    `${git} reflog show --all --format='%H%x09%gD%x09%gs%x09%s%x09%at' --date=unix`
  );
  if (reflog === null) return null;

  const local = new Map<string, DetectedCommit>();
  // Rewrites of changes older than the run, kept aside: linked only when they
  // rewrite one of the task's own commits.
  const olderRewrites = new Map<string, { key: string; commit: DetectedCommit }>();
  for (const line of reflog.split('\n')) {
    const [hash, selector, action, ...rest] = line.split('\t');
    const eventTime = selector?.match(LOCAL_REFLOG)?.[2];
    if (!/^[a-f0-9]{40}$/.test(hash) || !eventTime || !action?.includes(':')) continue;
    // Git records reflog times at second precision.
    if (Number(eventTime) < startSec) continue;
    if (untilSec !== null && Number(eventTime) > untilSec) continue;
    // The author date closes the line; an older format (or a test double) may
    // not carry it, in which case it is simply unknown.
    let authorTime: number | null = null;
    let subject = rest;
    if (rest.length >= 2 && /^\d+$/.test(rest[rest.length - 1])) {
      authorTime = Number(rest[rest.length - 1]);
      subject = rest.slice(0, -1);
    }
    // Git prefixes sequencer phases with the command actually typed, e.g.
    // "pull --rebase (pick)". Inspect the operation separately from the subject:
    // commit messages may themselves contain "(start)" or "Fast-forward".
    const separator = action.indexOf(':');
    const operation = action.slice(0, separator);
    const detail = action.slice(separator + 1).trimStart();
    if (!/^(commit|merge|pull|cherry-pick|revert|rebase|am|applypatch)\b/i.test(operation))
      continue;
    if (/\((start|finish|abort)\)/i.test(operation)) continue;
    if (/^(merge|pull)\b/i.test(operation) && /^Fast-forward\b/i.test(detail)) continue;
    const commit: DetectedCommit = {
      hash,
      msg: subject.join('\t').slice(0, 200),
      ...(secondaryRepo ? { repo: secondaryRepo } : {}),
    };
    if (REWRITE_OPERATION.test(operation) && authorTime !== null && authorTime < startSec) {
      olderRewrites.set(hash, { key: `${authorTime}\t${subject.join('\t')}`, commit });
      continue;
    }
    local.set(hash, commit);
  }

  const own = [...new Set(ownCommits.filter(h => HASH.test(h)))].slice(-100);
  if (olderRewrites.size && own.length) {
    // Same author date and subject as a commit the task already owns: the run
    // rebased (or amended) the task's own work. The hash is echoed back so a
    // missing object — which makes git fall back to HEAD — never matches.
    const known = await _execGit(
      executionManager,
      agentId,
      `${git} log --no-walk --ignore-missing --format='%H%x09%at%x09%s' ${own.join(' ')}`
    );
    const ownKeys = new Set<string>();
    for (const line of (known || '').split('\n')) {
      const [h, at, ...subj] = line.split('\t');
      if (!h || !own.some(o => h.startsWith(o) || o.startsWith(h))) continue;
      ownKeys.add(`${at}\t${subj.join('\t')}`);
    }
    for (const [hash, { key, commit }] of olderRewrites) {
      if (ownKeys.has(key) && !local.has(hash)) local.set(hash, commit);
    }
  }
  if (!local.size) return [];

  // Exclude commits already present at run start and abandoned pre-amend/rebase
  // versions. Reachability is checked from EVERY local and remote-tracking ref,
  // not HEAD alone: a commit made on a branch the agent then left (a PR branch,
  // then `git checkout main`) is still this run's work. If the baseline
  // vanished, local events still bound the fallback.
  const hasBaseline = !!baselineHead && /^[a-f0-9]{7,40}$/.test(baselineHead);
  const refs = 'HEAD --branches --remotes';
  let reachable = await _execGit(
    executionManager,
    agentId,
    `${git} log --format=%H ${refs}${hasBaseline ? ` --not ${baselineHead}` : ''}`
  );
  if (reachable === null && hasBaseline) {
    reachable = await _execGit(executionManager, agentId, `${git} log --format=%H ${refs}`);
  }
  if (reachable === null) return null;
  const hashes = new Set(reachable.split('\n'));
  const commits = [...local.values()].filter(commit => hashes.has(commit.hash));
  if (!commits.length) return [];

  // Include detached HEAD and do not truncate: truncation would incorrectly
  // label older local commits as pushed. A failed query leaves status unknown.
  const unpushedOutput = await _execGit(
    executionManager,
    agentId,
    `${git} log HEAD --branches --not --remotes --format=%H`
  );
  if (unpushedOutput !== null) {
    const unpushed = new Set(unpushedOutput.split('\n'));
    for (const commit of commits) commit.pushed = !unpushed.has(commit.hash);
  }
  return commits;
}

export interface ReconcileOptions {
  baselineHead?: string | null;
  startedAt?: string | null;
  until?: string | null;
  secondaryBaselines?: Record<string, string | null>;
  label?: string;
}

/**
 * Link every commit created during a run to the task, and refresh the
 * pushed/unpushed flag of already-linked ones. Idempotent (addTaskCommit
 * dedups by hash prefix), so it is safe to run repeatedly: mid-run from the
 * _waitForExecutionComplete sweep AND at run end from executeRunAgent's
 * finally — whichever way the run ended (update_task completion, status-only
 * move, no-decision retry, error, stop). Covers the primary clone and every
 * secondary repo the run took a baseline of.
 * Returns the number of NEWLY linked commits, and whether a repo could not be
 * read (`failed`: its commits are unknown, not absent).
 */
async function _reconcile(
  agentManager: any,
  executorAgentId: string,
  taskId: string,
  {
    baselineHead,
    startedAt,
    until = null,
    secondaryBaselines = {},
    label = 'Reconcile',
  }: ReconcileOptions
): Promise<{ linked: number; failed: boolean }> {
  const em = agentManager.executionManager;
  // Nothing can be read without an exec channel; that is not a failure to retry.
  if (typeof em?.exec !== 'function') return { linked: 0, failed: false };
  const task: any = await getTaskById(taskId);
  if (!task) return { linked: 0, failed: false };
  const linkedCommits: Array<{ hash: string; repo?: string | null }> = Array.isArray(task.commits)
    ? task.commits
    : [];
  const ownIn = (repo: string | null) =>
    linkedCommits.filter(c => (c.repo || null) === repo).map(c => c.hash);

  let failed = false;
  const detected: DetectedCommit[] = [];
  const primary = await detectCommits(em, executorAgentId, {
    baselineHead,
    startedAt,
    until,
    ownCommits: ownIn(null),
  });
  if (primary === null) failed = true;
  else detected.push(...primary);
  for (const [repo, head] of Object.entries(secondaryBaselines || {})) {
    const found = await detectCommits(em, executorAgentId, {
      baselineHead: head,
      startedAt,
      until,
      secondaryRepo: repo,
      ownCommits: ownIn(repo),
    });
    if (found === null) failed = true;
    else detected.push(...found);
  }
  if (detected.length === 0) return { linked: 0, failed };

  const known: string[] = linkedCommits.map(c => c.hash);
  const alreadyLinked = (hash: string) =>
    known.some(h => h === hash || h.startsWith(hash) || hash.startsWith(h));

  let fresh = 0;
  for (const c of detected) {
    const isNew = !alreadyLinked(c.hash);
    await agentManager.addTaskCommit(executorAgentId, taskId, c.hash, c.msg, {
      pushed: c.pushed,
      repo: c.repo || null,
    });
    if (isNew) fresh++;
  }

  if (fresh > 0) {
    const preview = detected.map(c => (c.repo ? `${c.repo}@` : '') + c.hash.slice(0, 7)).join(', ');
    console.log(
      `🔗 [${label}] Linked ${fresh} new commit(s) [${preview}] to task ${taskId} (baseline=${baselineHead ? baselineHead.slice(0, 7) : 'time-window'})`
    );
  }
  const unpushedCount = detected.filter(c => c.pushed === false).length;
  if (unpushedCount > 0) {
    console.warn(
      `⚠️  [${label}] ${unpushedCount}/${detected.length} commit(s) on task ${taskId} are NOT pushed to any remote yet`
    );
  }
  return { linked: fresh, failed };
}

export async function reconcileTaskCommits(
  agentManager: any,
  executorAgentId: string,
  taskId: string,
  options: ReconcileOptions = {}
): Promise<number> {
  return (await _reconcile(agentManager, executorAgentId, taskId, options)).linked;
}

/** The task's secondary repo names usable in a git command. */
function secondaryRepoNames(task: Pick<Task, 'secondaryRepos'>): string[] {
  const list: Array<{ fullName?: unknown } | null> = Array.isArray(task.secondaryRepos)
    ? task.secondaryRepos
    : [];
  const names = list.map(r => r?.fullName).filter(isUsableRepoName);
  return [...new Set(names)];
}

/** The manager the reconcile functions are handed (an AgentManager). */
type ReconcileManager = Parameters<typeof reconcileTaskCommits>[0];

/** Failed recoveries of a persisted run before its commits are given up on. */
const MAX_RECOVERY_ATTEMPTS = 5;

/**
 * Open the commit window of a run: snapshot the baselines (primary + secondary
 * clones), register the run in memory and persist it on the task row — so that
 * after an API restart the commits the agent made before it are still linked
 * (recoverPersistedCommitRun) instead of being lost for good. A previous run's
 * context still on the row (it died, or was stopped, before linking its
 * commits) is recovered first rather than overwritten.
 */
export async function startTaskCommitRun(
  manager: ReconcileManager,
  executorId: string,
  task: Pick<Task, 'id' | 'secondaryRepos'>,
  startedAt: string
): Promise<TaskCommitRun> {
  const row = await getTaskById(task.id);
  if (row?.commitRun) await recoverPersistedCommitRun(manager, row, 'PreviousRunReconcile');
  const em = manager.executionManager;
  const baselineHead = await snapshotGitBaseline(em, executorId);
  const secondaryBaselines: Record<string, string | null> = {};
  for (const repo of secondaryRepoNames(task)) {
    secondaryBaselines[repo] = await snapshotGitBaseline(em, executorId, repo);
  }
  const run: TaskCommitRun = { taskId: task.id, baselineHead, startedAt, secondaryBaselines };
  beginTaskCommitRun(manager, executorId, run);
  const record: TaskCommitRunRecord = { executorId, baselineHead, startedAt, secondaryBaselines };
  await updateTaskFields(task.id, { commitRun: record });
  return run;
}

/**
 * Close the commit window of a run: final reconcile (the run has drained, so
 * its last commits are in), then forget the run in memory and on the row — the
 * row's copy only while it is still this run's, and only when every repo could
 * be read (otherwise the commit sweeper retries it).
 */
export async function finishTaskCommitRun(
  manager: ReconcileManager,
  executorId: string,
  taskId: string,
  label: string
): Promise<void> {
  const run = getTaskCommitRun(manager, executorId);
  if (run?.taskId !== taskId) return;
  let failed = true;
  try {
    failed = (await _reconcile(manager, executorId, taskId, { ...run, label })).failed;
  } catch (err) {
    console.warn(
      `⚠️ [${label}] End-of-run commit reconcile failed for task ${taskId}: ${errorMessage(err)}`
    );
  }
  endTaskCommitRun(manager, executorId, taskId);
  if (failed) {
    // Keep the context for the sweeper, closed at this point.
    const record: TaskCommitRunRecord = {
      executorId,
      baselineHead: run.baselineHead,
      startedAt: run.startedAt,
      secondaryBaselines: run.secondaryBaselines || {},
      endedAt: new Date().toISOString(),
    };
    console.warn(
      `⚠️ [${label}] Commits of task ${taskId} could not be read — kept for a later recovery`
    );
    await updateTaskFields(taskId, { commitRun: record });
    return;
  }
  await clearTaskCommitRun(taskId, run.startedAt);
}

/**
 * Link the commits of a run this process no longer tracks (it died with a
 * previous process, its claim was healed, or it was stopped elsewhere), from the
 * context persisted on the task row, then forget it. The runner kept the clone,
 * so its reflog still says what was created during that run — up to the
 * moment the run ended (`endedAt`), when known. A run whose repos cannot be read
 * is kept and retried, up to MAX_RECOVERY_ATTEMPTS.
 */
export async function recoverPersistedCommitRun(
  manager: ReconcileManager,
  task: Pick<Task, 'id' | 'commitRun'>,
  label = 'RecoveredRun'
): Promise<number> {
  const rec = task.commitRun;
  if (!rec?.executorId || !rec.startedAt) {
    if (rec) await clearTaskCommitRun(task.id, rec.startedAt || null);
    return 0;
  }
  // Still tracked here: the live run will reconcile itself.
  if (getTaskCommitRun(manager, rec.executorId)?.taskId === task.id) return 0;
  let result = { linked: 0, failed: true };
  try {
    result = await _reconcile(manager, rec.executorId, task.id, {
      baselineHead: rec.baselineHead,
      startedAt: rec.startedAt,
      until: rec.endedAt || null,
      secondaryBaselines: rec.secondaryBaselines || {},
      label,
    });
  } catch (err) {
    console.warn(`⚠️ [${label}] Commit recovery failed for task ${task.id}: ${errorMessage(err)}`);
  }
  const attempts = (rec.recoverAttempts || 0) + 1;
  if (result.failed && attempts < MAX_RECOVERY_ATTEMPTS) {
    await updateTaskFields(task.id, {
      commitRun: {
        ...rec,
        endedAt: rec.endedAt || new Date().toISOString(),
        recoverAttempts: attempts,
      },
    });
    return result.linked;
  }
  if (result.failed) {
    console.error(
      `❌ [${label}] Giving up on the commits of a run of task ${task.id} after ${attempts} attempts — link them with update_task's commits argument`
    );
  }
  await clearTaskCommitRun(task.id, rec.startedAt);
  return result.linked;
}

/**
 * Link the commits of every run context of `environment` left behind with no
 * live run (the claim is gone and this process does not track it): runs that
 * died, were stopped elsewhere, or whose repos could not be read at the time.
 */
export async function sweepOrphanCommitRuns(
  manager: ReconcileManager,
  orphans: Array<Pick<Task, 'id' | 'commitRun'>>
): Promise<void> {
  for (const task of orphans) {
    const rec = task.commitRun;
    if (rec?.executorId && getTaskCommitRun(manager, rec.executorId)?.taskId === task.id) continue;
    await recoverPersistedCommitRun(manager, task, 'OrphanRunReconcile').catch(err =>
      console.warn(`⚠️ [OrphanRunReconcile] task ${task.id}: ${errorMessage(err)}`)
    );
  }
}
