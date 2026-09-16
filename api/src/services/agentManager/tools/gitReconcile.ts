// Commit attribution uses local creation events, scoped to one task execution.
// Repository history alone is insufficient: pulls bring in unrelated commits,
// including commits with the same identity when several agents share an email.
// Only the primary project clone is inspected; secondary repos need explicit links.
import { getTaskById } from '../../database.js';

export interface TaskCommitRun {
  taskId: string;
  baselineHead: string | null;
  startedAt: string;
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
 *  filter. (This same gate is why recordTaskCompletion's detection could miss.) */
export async function snapshotGitBaseline(
  executionManager: any,
  agentId: string
): Promise<string | null> {
  if (typeof executionManager?.exec !== 'function') return null;
  const output = await _execGit(executionManager, agentId, 'git rev-parse HEAD');
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
  { baselineHead, startedAt }: { baselineHead?: string | null; startedAt?: string | null } = {}
): Promise<DetectedCommit[]> {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return [];
  const reflog = await _execGit(
    executionManager,
    agentId,
    "git reflog show --format='%H%x09%gD%x09%gs%x09%s' --date=unix HEAD"
  );
  if (!reflog) return [];

  const local = new Map<string, DetectedCommit>();
  for (const line of reflog.split('\n')) {
    const [hash, selector, action, ...subject] = line.split('\t');
    const eventTime = selector?.match(/@\{(\d+)\}$/)?.[1];
    if (!/^[a-f0-9]{40}$/.test(hash) || !eventTime || !action?.includes(':')) continue;
    // Git records reflog times at second precision.
    if (Number(eventTime) < Math.floor(start / 1000)) continue;
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
    local.set(hash, { hash, msg: subject.join('\t').slice(0, 200) });
  }
  if (!local.size) return [];

  // Exclude commits already present at run start and abandoned pre-amend/rebase
  // versions. If the baseline vanished, local events still bound the fallback.
  const hasBaseline = !!baselineHead && /^[a-f0-9]{7,40}$/.test(baselineHead);
  let reachable = await _execGit(
    executionManager,
    agentId,
    `git log --format=%H ${hasBaseline ? `${baselineHead}..HEAD` : 'HEAD'}`
  );
  if (reachable === null && hasBaseline) {
    reachable = await _execGit(executionManager, agentId, 'git log --format=%H HEAD');
  }
  if (reachable === null) return [];
  const hashes = new Set(reachable.split('\n'));
  const commits = [...local.values()].filter(commit => hashes.has(commit.hash));
  if (!commits.length) return [];

  // Include detached HEAD and do not truncate: truncation would incorrectly
  // label older local commits as pushed. A failed query leaves status unknown.
  const unpushedOutput = await _execGit(
    executionManager,
    agentId,
    'git log HEAD --branches --not --remotes --format=%H'
  );
  if (unpushedOutput !== null) {
    const unpushed = new Set(unpushedOutput.split('\n'));
    for (const commit of commits) commit.pushed = !unpushed.has(commit.hash);
  }
  return commits;
}

/**
 * Link every commit created during a run to the task, and refresh the
 * pushed/unpushed flag of already-linked ones. Idempotent (addTaskCommit
 * dedups by hash prefix), so it is safe to run repeatedly: mid-run from the
 * _waitForExecutionComplete sweep AND at run end from executeRunAgent's
 * finally — whichever way the run ended (update_task completion, status-only
 * move, no-decision retry, error, stop).
 * Returns the number of NEWLY linked commits.
 */
export async function reconcileTaskCommits(
  agentManager: any,
  executorAgentId: string,
  taskId: string,
  {
    baselineHead,
    startedAt,
    label = 'Reconcile',
  }: { baselineHead?: string | null; startedAt?: string | null; label?: string } = {}
): Promise<number> {
  const detected = await detectCommitsSinceBaseline(
    agentManager.executionManager,
    executorAgentId,
    { baselineHead, startedAt }
  );
  if (detected.length === 0) return 0;

  const task: any = await getTaskById(taskId);
  if (!task) return 0;
  const known: string[] = (task.commits || []).map((c: any) => c.hash);
  const alreadyLinked = (hash: string) =>
    known.some(h => h === hash || h.startsWith(hash) || hash.startsWith(h));

  let fresh = 0;
  for (const c of detected) {
    const isNew = !alreadyLinked(c.hash);
    await agentManager.addTaskCommit(executorAgentId, taskId, c.hash, c.msg, { pushed: c.pushed });
    if (isNew) fresh++;
  }

  if (fresh > 0) {
    const preview = detected.map(c => c.hash.slice(0, 7)).join(', ');
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
  return fresh;
}
