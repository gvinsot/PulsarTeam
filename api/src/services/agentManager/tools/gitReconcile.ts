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
//      the run (baseline..HEAD, restricted to the clone's own committer
//      identity so commits that merely ARRIVED via fetch/pull are not credited
//      to the task), each with a pushed/unpushed flag derived from
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

/**
 * Non-throwing git exec helper. The runner /exec-shell returns status="error"
 * for ANY non-zero git exit, which the provider turns into a THROWN Error
 * (with the real output stashed on err.stdout). This helper recovers the
 * output and logs every failure so prod issues are visible.
 *
 * Returns the command output on success (which may be the empty string — a
 * legitimate result, e.g. `git log --branches --not --remotes` when every
 * commit is pushed) and `null` only when the command could not run at all
 * (no environment, or a throw with no recoverable output). Callers must
 * distinguish these: empty output = "successful, empty result"; null =
 * "unknown". Collapsing the two would let an exec failure masquerade as an
 * empty unpushed set and wrongly mark commits as pushed.
 */
async function _execGit(
  executionManager: any,
  agentId: string,
  command: string,
  timeout: number = 10000
): Promise<string | null> {
  if (typeof executionManager?.exec !== 'function') return null;
  try {
    const r = await executionManager.exec(agentId, command, { timeout });
    // Pick one stream (provider sets stdout==stderr for CLI runners) to avoid
    // double-parsing. Prefer stdout, fall back to stderr.
    const output = (r.stdout || r.stderr || '').trim();
    return output;
  } catch (err: any) {
    // The provider throws on non-zero exit, but the real output is on the error.
    const recovered = (err?.stdout || err?.stderr || err?.message || '').trim();
    if (recovered) {
      console.warn(
        `⚠️  [git-reconcile] exec error for agent ${agentId}: ${command} → ${recovered.slice(0, 200)}`
      );
      return recovered;
    }
    console.warn(
      `⚠️  [git-reconcile] exec exception for agent ${agentId}: ${command} → ${err?.message || 'unknown'}`
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
 * The slice of `executionManager` these helpers actually use. Declared
 * structurally so the real manager (and the test fakes) satisfy it without a
 * cast, and so the exported helpers don't widen the file's `any` count.
 */
export interface GitExecEnv {
  exec?: (
    agentId: string,
    command: string,
    opts?: { timeout?: number }
  ) => Promise<{ stdout?: string; stderr?: string }>;
}

/** Single-quote a value for the shell command string these helpers build. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The identity this clone commits as — `git config user.email`, which
 * ensure_agent_project writes from GIT_USER_NAME/GIT_USER_EMAIL
 * (agent@pulsarteam.local by default).
 *
 * This is what separates "the agent committed" from "the commit merely arrived
 * in the clone": see the note on the committer filter in
 * detectCommitsSinceBaseline. Returns null when the clone has no identity
 * configured, which callers must read as "cannot filter" — never as "match
 * nothing", or a misconfigured clone would stop linking its own commits.
 */
export async function cloneCommitterEmail(
  executionManager: GitExecEnv,
  agentId: string
): Promise<string | null> {
  const output = await _execGit(executionManager, agentId, 'git config user.email', 5000);
  if (!output) return null;
  const email = output.split('\n')[0].trim();
  // Anything with whitespace or a quote is not an identity we will splice into
  // a command line; treat it as unknown rather than try to sanitise it.
  if (!email || /[\s'"`$\\]/.test(email) || /^fatal:/i.test(email)) return null;
  return email;
}

/**
 * List the commits created during a run, terminal-independently.
 * Prefers the exact rev-range `baselineHead..HEAD`; falls back to a
 * `--since=startedAt` window when no baseline was captured OR when the
 * range query FAILS (unreachable baseline after a history-rewriting
 * fetch/reset, invalid range, exec error). Returns [] when neither
 * anchor is available.
 *
 * A range that succeeds but returns empty still means "no new commits"
 * and does NOT widen to the time window (no over-linking).
 *
 * ── Why the committer filter ──────────────────────────────────────────────
 * `baseline..HEAD` answers "what is new in this clone", NOT "what did the
 * agent write". HEAD also moves when commits merely ARRIVE — ensureProject
 * fetch/resets the clone on every chat and on every terminal attach, and the
 * runner itself pulls. Everything that lands that way sits in the range and
 * was, until this filter, linked to whatever task happened to be running:
 * observed in prod on a task whose text was literally "test task, do nothing",
 * credited with five commits its human owner had pushed from his own machine
 * the day before.
 *
 * Topology cannot tell the two apart (a pulled commit is not reachable from
 * the OLD remote tip either), but identity can: a runner clone commits as
 * `git config user.email` — agent@pulsarteam.local by default — while a human
 * pushes under their own address. So the range is asked for that committer
 * only. `--committer` is a substring match, and the value is the clone's own
 * configuration, so this stays correct when an agent runs under a distinct
 * address (claude6@pulsarteam.local and friends exist in real history).
 *
 * When the clone has no identity we do NOT filter: an unfiltered range
 * over-links, which is a visible annoyance, while filtering on an empty
 * identity would link nothing at all and silently lose every agent commit.
 */
export async function detectCommitsSinceBaseline(
  executionManager: any,
  agentId: string,
  { baselineHead, startedAt }: { baselineHead?: string | null; startedAt?: string | null } = {}
): Promise<DetectedCommit[]> {
  if (typeof executionManager?.exec !== 'function') return [];

  // Anchors first: with neither a baseline nor a start time there is nothing to
  // query, and we must not spend a runner round-trip resolving an identity we
  // would never use.
  const hasBaseline = !!baselineHead && /^[a-f0-9]{7,40}$/.test(baselineHead);
  const hasWindow = !!startedAt && !isNaN(new Date(startedAt).getTime());
  if (!hasBaseline && !hasWindow) return [];

  // Restrict every query below to the identity this clone commits as, so a
  // commit that merely arrived through a fetch/pull is not credited to the run
  // (see the note above). Empty when unknown — then nothing is filtered.
  const committer = await cloneCommitterEmail(executionManager, agentId);
  const committerFilter = committer ? ` --committer=${shellQuote(committer)}` : '';
  if (!committer) {
    console.warn(
      `⚠️  [git-reconcile] No git user.email in agent ${agentId}'s clone — linking every commit ` +
        `in the range, including any pulled from the remote`
    );
  }

  // Attempt the exact rev-range if we have a valid baseline.
  let rangeOutput: string | null = null;
  let rangeFailed = false;
  if (hasBaseline) {
    rangeOutput = await _execGit(
      executionManager,
      agentId,
      `git log --format="%H %s" ${baselineHead}..HEAD${committerFilter}`
    );
    // If the range query returned output, check if it's a real result or a fatal
    if (rangeOutput && /^fatal:/im.test(rangeOutput)) {
      rangeFailed = true;
      rangeOutput = null;
    }
  }

  // If range failed or no baseline, fall back to time window.
  if (rangeOutput === null || rangeFailed) {
    if (hasWindow) {
      rangeOutput = await _execGit(
        executionManager,
        agentId,
        `git log --format="%H %s" --since="${new Date(startedAt).toISOString()}" -30${committerFilter}`
      );
    } else {
      return [];
    }
  }

  if (!rangeOutput || /^fatal:/im.test(rangeOutput)) return [];

  const commits: DetectedCommit[] = [];
  for (const line of rangeOutput.split('\n')) {
    const m = line.match(/^([a-f0-9]{40})\s*(.*)/);
    if (m) commits.push({ hash: m[1], msg: (m[2] || '').slice(0, 200) });
  }
  if (commits.length === 0) return commits;

  // Unpushed set: commits on any local branch that no remote-tracking ref
  // contains. A successful `git push` from this clone updates the local
  // remote-tracking ref, so no network fetch is needed for an accurate answer.
  const unpushedOutput = await _execGit(
    executionManager,
    agentId,
    'git log --branches --not --remotes --format=%H -100'
  );
  // null = query failed (leave pushed undefined/unknown). Empty string = query
  // succeeded with no unpushed commits → every detected commit IS pushed. The
  // end-of-run reconcile relies on this to upgrade a mid-run "unpushed" flag to
  // pushed once the CLI runner has pushed and the unpushed set drains to empty.
  if (unpushedOutput !== null && !/^fatal:/im.test(unpushedOutput)) {
    const unpushed = new Set(
      unpushedOutput
        .split('\n')
        .map(s => s.trim())
        .filter(s => /^[a-f0-9]{40}$/.test(s))
    );
    for (const c of commits) c.pushed = !unpushed.has(c.hash);
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
