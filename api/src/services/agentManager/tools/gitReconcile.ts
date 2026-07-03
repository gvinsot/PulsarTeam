// ─── Terminal-independent git commit/push reconcile ─────────────────────────
// CLI runners (claude code, aider, codex, …) run `git commit` / `git push`
// inside their own interactive PTY: nothing flows through the @run_command
// tool, so the real-time detector in commitDetection.ts never sees it — and
// the CLI's TUI often doesn't render output the terminal-side parsers could
// catch anyway. The only reliable source of truth is the repo itself. These
// helpers query the agent's execution environment (runner /exec-shell,
// cwd = the agent's project clone) directly:
//
//   1. snapshotGitBaseline()        — capture HEAD when a workflow action starts.
//   2. detectCommitsSinceBaseline() — list exactly the commits created during
//      the run (baseline..HEAD), each with a pushed/unpushed flag derived from
//      `git log --branches --not --remotes` (robust for new branches, where
//      @{u} does not exist yet).
//   3. reconcileTaskCommits()       — link them to the task via addTaskCommit
//      (idempotent, prefix-aware dedup), updating pushed flags on re-visit.
//
// Known limitation: detection runs in the PRIMARY project clone only —
// commits made in secondary repos are not swept (same as the pre-existing
// completion-time detection in recordTaskCompletion).

import { getTaskById } from '../../database.js';

export interface DetectedCommit {
  hash: string;
  msg: string;
  /** true = reachable from a remote-tracking ref, false = local-only.
   *  undefined when the unpushed query failed (unknown). */
  pushed?: boolean;
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
export async function snapshotGitBaseline(executionManager: any, agentId: string): Promise<string | null> {
  if (typeof executionManager?.exec !== 'function') return null;
  try {
    const r = await executionManager.exec(agentId, 'git rev-parse HEAD', { timeout: 10000 });
    const head = ((r.stdout || '') + (r.stderr || '')).trim();
    return /^[a-f0-9]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * List the commits created during a run, terminal-independently.
 * Prefers the exact rev-range `baselineHead..HEAD`; falls back to a
 * `--since=startedAt` window when no baseline was captured (e.g. the API
 * restarted mid-run). Returns [] when neither anchor is available.
 */
export async function detectCommitsSinceBaseline(
  executionManager: any,
  agentId: string,
  { baselineHead, startedAt }: { baselineHead?: string | null; startedAt?: string | null } = {},
): Promise<DetectedCommit[]> {
  if (typeof executionManager?.exec !== 'function') return [];

  let logCmd: string;
  if (baselineHead && /^[a-f0-9]{7,40}$/.test(baselineHead)) {
    logCmd = `git log --format="%H %s" ${baselineHead}..HEAD`;
  } else if (startedAt && !isNaN(new Date(startedAt).getTime())) {
    logCmd = `git log --format="%H %s" --since="${new Date(startedAt).toISOString()}" -30`;
  } else {
    return [];
  }

  let output = '';
  try {
    const r = await executionManager.exec(agentId, logCmd, { timeout: 10000 });
    output = ((r.stdout || '') + (r.stderr || '')).trim();
  } catch {
    return [];
  }
  if (!output || /^fatal:/im.test(output)) return [];

  const commits: DetectedCommit[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^([a-f0-9]{40})\s*(.*)/);
    if (m) commits.push({ hash: m[1], msg: (m[2] || '').slice(0, 200) });
  }
  if (commits.length === 0) return commits;

  // Unpushed set: commits on any local branch that no remote-tracking ref
  // contains. A successful `git push` from this clone updates the local
  // remote-tracking ref, so no network fetch is needed for an accurate answer.
  try {
    const r = await executionManager.exec(agentId, 'git log --branches --not --remotes --format=%H -100', { timeout: 10000 });
    const raw = ((r.stdout || '') + (r.stderr || '')).trim();
    if (!/^fatal:/im.test(raw)) {
      const unpushed = new Set(raw.split('\n').map(s => s.trim()).filter(s => /^[a-f0-9]{40}$/.test(s)));
      for (const c of commits) c.pushed = !unpushed.has(c.hash);
    }
  } catch {
    /* pushed flags stay undefined (unknown) */
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
  { baselineHead, startedAt, label = 'Reconcile' }:
    { baselineHead?: string | null; startedAt?: string | null; label?: string } = {},
): Promise<number> {
  const detected = await detectCommitsSinceBaseline(
    agentManager.executionManager, executorAgentId, { baselineHead, startedAt },
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
    console.log(`🔗 [${label}] Linked ${fresh} new commit(s) [${preview}] to task ${taskId} (baseline=${baselineHead ? baselineHead.slice(0, 7) : 'time-window'})`);
  }
  const unpushedCount = detected.filter(c => c.pushed === false).length;
  if (unpushedCount > 0) {
    console.warn(`⚠️  [${label}] ${unpushedCount}/${detected.length} commit(s) on task ${taskId} are NOT pushed to any remote yet`);
  }
  return fresh;
}
