// ─── CLI-runner activity → agent.status ──────────────────────────────────────
//
// A CLI runner (claudecode, codex, …) driven through its interactive PTY never
// goes through sendMessage, so nothing on the chat path marks it busy. Its
// busy/idle status is derived from ACTIVITY signals instead:
//
//   • console output relayed to a browser terminal (routes/terminal.ts);
//   • the runner's own `idle_seconds` — seconds since the PTY last printed,
//     tracked runner-side whether or not a viewer is attached — polled by a
//     heartbeat for as long as a terminal-driven task is being watched;
//   • token usage the runner reports from the CLI's transcripts
//     (routes/internalTokenUsage.ts): tokens consumed means the model is working.
//
// Before this, only the first signal existed and it flipped the agent back to
// idle after 5 s of silence. So an agent thinking for a while, running a silent
// command, or simply working with no terminal tab open showed as "idle" — and
// the reminder loop, which only holds off while the executor is busy, nudged it
// mid-work. The quiet threshold is now much longer, and before going idle we
// ask the runner whether the PTY is really quiet.
//
// The opposite failure — a CLI whose screen keeps moving although nothing is
// happening — kept a finished agent "busy" forever, so no next task was ever
// picked. Two guards against it: the runner's `idle_seconds` only counts
// changes of the visible screen text (not no-op redraws), and a STALL rule: a
// CLI whose model has not consumed a token for CLI_STALL_MS since its last
// prompt is not working for us any more, whatever its screen does
// (isCliStalled). Screen-derived activity is then ignored.

/** Quiet period after which a CLI agent is considered idle again. */
export const CLI_ACTIVITY_IDLE_MS = positiveInt(process.env.CLI_ACTIVITY_IDLE_MS, 30_000);
/** Poll interval of the runner-side activity heartbeat during a watched task. */
export const CLI_ACTIVITY_HEARTBEAT_MS = positiveInt(process.env.CLI_ACTIVITY_HEARTBEAT_MS, 5_000);

/**
 * No model activity (token usage reported by the runner) for this long since
 * the last prompt → the CLI is stalled: its screen activity no longer counts.
 */
export const CLI_STALL_MS = positiveInt(process.env.CLI_STALL_MS, 15 * 60_000);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface ActivityState {
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout | null;
}
const activity = new Map<string, ActivityState>();

interface Watch {
  refs: number;
  timer: NodeJS.Timeout;
  polling: boolean;
}
const watches = new Map<string, Watch>();

interface ModelActivity {
  /** Last token-usage report; null until the runner reported one. */
  lastTokenAt: number | null;
  /** Last prompt pasted into the CLI. */
  lastPromptAt: number;
  /** A stall was already logged for the current episode. */
  stallLogged: boolean;
}
const modelActivity = new Map<string, ModelActivity>();

function modelState(agentId: string): ModelActivity {
  let m = modelActivity.get(agentId);
  if (!m) {
    m = { lastTokenAt: null, lastPromptAt: 0, stallLogged: false };
    modelActivity.set(agentId, m);
  }
  return m;
}

/**
 * The CLI's model consumed tokens (the runner reports transcript growth): it is
 * working right now. Marks the agent busy like any other activity.
 */
export function noteCliModelActivity(
  agentManager: any,
  agentId: string,
  detail = 'Consuming tokens',
  at: number = Date.now()
): void {
  if (!agentId) return;
  const m = modelState(agentId);
  m.lastTokenAt = Math.max(m.lastTokenAt ?? 0, at);
  m.stallLogged = false;
  noteCliActivity(agentManager, agentId, detail, at);
}

/** A prompt was just pasted into the CLI: a new turn starts (resets the stall clock). */
export function noteCliPromptInjected(
  agentManager: any,
  agentId: string,
  detail = 'CLI task injected',
  at: number = Date.now()
): void {
  if (!agentId) return;
  const m = modelState(agentId);
  m.lastPromptAt = Math.max(m.lastPromptAt, at);
  m.stallLogged = false;
  noteCliActivity(agentManager, agentId, detail, at);
}

/**
 * True when the CLI's model has not consumed a token for CLI_STALL_MS since its
 * last prompt. Only judged once the runner has reported token usage for this
 * agent at least once — a CLI without usage reporting is never called stalled.
 */
export function isCliStalled(agentId: string, now: number = Date.now()): boolean {
  const m = modelActivity.get(agentId);
  if (!m || m.lastTokenAt === null) return false;
  const stalled = now - Math.max(m.lastTokenAt, m.lastPromptAt) >= CLI_STALL_MS;
  if (stalled && !m.stallLogged) {
    m.stallLogged = true;
    console.warn(
      `[CliActivity] ${agentId.slice(0, 8)}: no model activity for ${Math.round(
        (now - Math.max(m.lastTokenAt, m.lastPromptAt)) / 1000
      )}s — ignoring its terminal activity, treating the CLI as idle`
    );
  }
  return stalled;
}

/**
 * Record CLI activity for `agentId` (at `at`, default now): mark it busy if it
 * isn't, and (re)arm the idle timer. Safe to call at a high rate.
 */
export function noteCliActivity(
  agentManager: any,
  agentId: string,
  detail = 'Console activity',
  at: number = Date.now()
): void {
  if (!agentManager || !agentId) return;
  const agent = agentManager.agents?.get?.(agentId);
  if (!agent) return;
  // A stalled CLI's screen/console activity is not work (see isCliStalled).
  // Prompt and token signals reset the stall clock before getting here.
  if (isCliStalled(agentId)) {
    // Make sure a busy flag nobody else owns still gets released.
    if (agent.status === 'busy' && !agent.currentTask && !activity.get(agentId)?.idleTimer) {
      const stale = activity.get(agentId) || { lastActivityAt: 0, idleTimer: null };
      activity.set(agentId, stale);
      armIdleTimer(agentManager, agentId, stale);
    }
    return;
  }

  const state = activity.get(agentId) || { lastActivityAt: 0, idleTimer: null };
  state.lastActivityAt = Math.max(state.lastActivityAt, at);
  activity.set(agentId, state);

  if (agent.status !== 'busy') {
    try {
      agentManager.setStatus(agentId, 'busy', detail);
    } catch (err: any) {
      console.warn(
        `[CliActivity] setStatus(busy) failed for ${agentId.slice(0, 8)}: ${err.message}`
      );
    }
  }
  armIdleTimer(agentManager, agentId, state);
}

/** True when CLI activity was seen for `agentId` within the idle threshold. */
export function isCliRecentlyActive(agentId: string, now: number = Date.now()): boolean {
  const state = activity.get(agentId);
  return (
    !!state && now - state.lastActivityAt < CLI_ACTIVITY_IDLE_MS && !isCliStalled(agentId, now)
  );
}

function armIdleTimer(agentManager: any, agentId: string, state: ActivityState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  const wait = Math.max(0, state.lastActivityAt + CLI_ACTIVITY_IDLE_MS - Date.now());
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    settleIdle(agentManager, agentId).catch(() => {});
  }, wait);
  state.idleTimer.unref?.();
}

/** Seconds since the runner's PTY last produced output, or null if unknown. */
async function runnerIdleSeconds(agentManager: any, agentId: string): Promise<number | null> {
  try {
    const session = await agentManager.executionManager?.getTerminalSession?.(agentId);
    const idle = session?.idle_seconds;
    return typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 ? idle : null;
  } catch {
    return null;
  }
}

/**
 * The idle timer fired: flip the agent back to idle — unless it is not ours to
 * flip, or the runner says the PTY is still printing (then re-arm from there).
 */
async function settleIdle(agentManager: any, agentId: string): Promise<void> {
  const state = activity.get(agentId);
  const agent = agentManager.agents?.get?.(agentId);
  if (!state || !agent) {
    activity.delete(agentId);
    return;
  }
  // A chat turn (sendMessage) sets currentTask and owns the busy flag — it
  // releases it itself when the turn ends.
  if (agent.currentTask || agent.status !== 'busy') {
    activity.delete(agentId);
    return;
  }

  const idle = isCliStalled(agentId) ? null : await runnerIdleSeconds(agentManager, agentId);
  if (idle !== null) {
    const outputAt = Date.now() - idle * 1000;
    if (outputAt > state.lastActivityAt) state.lastActivityAt = outputAt;
  }
  // New activity while we were asking the runner (or the runner saw output we
  // never relayed): not quiet yet.
  if (Date.now() - state.lastActivityAt < CLI_ACTIVITY_IDLE_MS) {
    armIdleTimer(agentManager, agentId, state);
    return;
  }

  activity.delete(agentId);
  const current = agentManager.agents?.get?.(agentId);
  if (current && current.status === 'busy' && !current.currentTask) {
    try {
      agentManager.setStatus(agentId, 'idle', 'Console quiet');
    } catch (err: any) {
      console.warn(
        `[CliActivity] setStatus(idle) failed for ${agentId.slice(0, 8)}: ${err.message}`
      );
    }
  }
}

/**
 * Watch a CLI agent's runner-side PTY activity for the duration of a
 * terminal-driven task: marks it busy right away (a prompt was just injected)
 * and every heartbeat in which the PTY printed recently. Returns the stop
 * function; the agent then goes idle through the normal quiet timer. Nested
 * watches on the same agent are reference-counted.
 */
export function watchCliActivity(agentManager: any, agentId: string): () => void {
  if (!agentManager || !agentId) return () => {};
  noteCliActivity(agentManager, agentId, 'CLI task started');

  let watch = watches.get(agentId);
  if (watch) {
    watch.refs += 1;
  } else {
    const w: Watch = {
      refs: 1,
      polling: false,
      timer: setInterval(async () => {
        if (w.polling) return;
        w.polling = true;
        try {
          const idle = await runnerIdleSeconds(agentManager, agentId);
          if (idle !== null && idle * 1000 < CLI_ACTIVITY_IDLE_MS) {
            noteCliActivity(agentManager, agentId, 'CLI working', Date.now() - idle * 1000);
          }
        } finally {
          w.polling = false;
        }
      }, CLI_ACTIVITY_HEARTBEAT_MS),
    };
    w.timer.unref?.();
    watches.set(agentId, w);
    watch = w;
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const w = watches.get(agentId);
    if (!w) return;
    w.refs -= 1;
    if (w.refs <= 0) {
      clearInterval(w.timer);
      watches.delete(agentId);
    }
  };
}

/** Test hook: drop every timer and state. */
export function _resetCliActivity(): void {
  for (const s of activity.values()) if (s.idleTimer) clearTimeout(s.idleTimer);
  for (const w of watches.values()) clearInterval(w.timer);
  activity.clear();
  watches.clear();
  modelActivity.clear();
}
