/**
 * Run claims — the durable half of "one live run per agent" (invariant: an
 * agent never works two tasks at once).
 *
 * Every execution path (workflow run_agent action, task-loop resume, explicit
 * start) goes through the same lifecycle:
 *
 *   reserveAgentForTask   in-process, synchronous (agentSelector.ts)
 *   claimRun              DB: action_running + action_running_agent_id, guarded
 *                         by `action_running IS NOT TRUE` and the unique index
 *                         uniq_tasks_running_agent (database/tasks.ts)
 *   heartbeat             every RUN_HEARTBEAT_MS while the run lives
 *   releaseRun            conditional on the claim still being this agent's
 *
 * The claim is what makes the run visible to every other process sharing the
 * database (the sibling stack, the previous replica of a rolling update, the
 * stale-claim healer) and to the UI (spinner, Stop, undraggable card).
 */
import {
  claimTaskRun,
  heartbeatTaskRun,
  releaseTaskRun,
  getRunningAgentIds,
} from '../database.js';
import { setClaimedAgents } from './agentSelector.js';
import { errorMessage } from '../../lib/errors.js';
import type { Task, TaskRunClaimFailure } from '../database/tasks.js';

/** Heartbeat period of a live claim (stale after RUN_CLAIM_STALE_SECONDS). */
export const RUN_HEARTBEAT_MS = 20_000;

/** Reload the set of agents holding a DB claim, right before selecting one. */
export async function refreshClaimedAgents(): Promise<void> {
  setClaimedAgents(await getRunningAgentIds());
}

export type ClaimResult =
  | { ok: true; task: Task; stopHeartbeat: () => void }
  | { ok: false; reason: TaskRunClaimFailure };

/**
 * Claim `taskId` for `agentId` and start heartbeating it. On failure nothing was
 * written. `stopHeartbeat` must be called once the run ends (before release).
 *
 * `expectStatus` refuses the claim ('moved') once the task left that column.
 *
 * A heartbeat that finds the claim gone means someone else ended this run — a
 * Stop or a heal served by ANOTHER process (the sibling stack, the next replica
 * of a rolling update), whose 'stopped' signal never reaches this one. `onLost`
 * then tells the run to stop like a local Stop would: it no longer holds the
 * agent, and carrying on would let a second run be pasted into the same CLI.
 */
export async function claimRun(
  taskId: string,
  agentId: string,
  mode: string,
  {
    expectStatus = null,
    onLost,
  }: { expectStatus?: string | null; onLost?: () => void } = {}
): Promise<ClaimResult> {
  const claim = await claimTaskRun(taskId, agentId, mode, expectStatus);
  if (!claim.ok) {
    console.log(
      `[RunClaims] claim refused: task="${taskId}" agent="${agentId}" mode=${mode} (${claim.reason})`
    );
    return claim;
  }
  let beating = true;
  const timer = setInterval(() => {
    heartbeatTaskRun(taskId, agentId)
      .then(alive => {
        // false = the claim is gone; null = the DB could not be reached (a
        // transient error must not end a healthy run).
        if (alive === false && beating) {
          beating = false;
          console.warn(
            `[RunClaims] heartbeat found no claim: task="${taskId}" agent="${agentId}" (stopped or healed elsewhere) — stopping the run`
          );
          onLost?.();
        }
      })
      .catch(() => {});
  }, RUN_HEARTBEAT_MS);
  timer.unref?.();
  return {
    ok: true,
    task: claim.task,
    stopHeartbeat: () => {
      beating = false;
      clearInterval(timer);
    },
  };
}

/**
 * Release a claim, retrying transient DB errors: a claim left behind would make
 * the agent look busy everywhere until the healer gives up on its heartbeat.
 * Returns the fresh row (null if it could not be read).
 */
export async function releaseRun(
  taskId: string,
  agentId: string,
  opts: { clearAssignee?: boolean; keepStartedAt?: boolean } = {}
): Promise<Task | null> {
  const delays = [0, 500, 2_000, 5_000];
  let lastErr: unknown = null;
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      return await releaseTaskRun(taskId, agentId, opts);
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(
    `[RunClaims] could not release claim task="${taskId}" agent="${agentId}": ${errorMessage(lastErr)} — the stale-claim healer will clear it once its heartbeat is old`
  );
  return null;
}
