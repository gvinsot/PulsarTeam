// ── Answers to LLM API requests, delivered by a tool call ───────────────────
//
// A CLI agent answering an LLM API request in its shared terminal
// (llmCompletion.runTerminalCompletion) writes its answer to a file of its
// workspace and calls the Pulsar Gateway's `submit_answer` tool with the
// request id and that file. The call is the "I am done" signal — no guessing
// from a quiet terminal — and the gateway reads the file through the runner,
// under the agent's UID, so the answer never goes through the model twice. A
// path the gateway cannot read is reported to the agent there and then.
//
// In memory: the gateway is served by the same team-api process that waits
// (one replica). A request id unknown here is answered as such to the agent.

import crypto from 'node:crypto';
import { shQuote, type RunnerExecBridge } from './mcpAttachments.js';

/**
 * Where the agent is told to write the answer to request `id`: its HOME, out
 * of the repository (nothing to commit by mistake). submit_answer deletes it
 * once read — that file only, never another path the agent passes.
 */
export function llmAnswerFile(id: string): string {
  return `~/pulsar-llm-api/${id}.out`;
}

/** A path for the runner's shell: `~/…` expands to the agent's HOME. */
function shPath(path: string): string {
  return path.startsWith('~/') ? `"$HOME"/${shQuote(path.slice(2))}` : shQuote(path);
}

/**
 * Largest answer file: the runner's /exec-shell output ceiling (32 MiB,
 * routes_api.py), so one raw `cat` carries the whole answer.
 */
export const LLM_MAX_ANSWER_BYTES = 32 * 1024 * 1024;

/**
 * Read an answer file from the agent's runner, under the agent's UID — what
 * the agent can read, nothing more. One raw `cat` (answers are text), the
 * size probed first so an oversized file is refused rather than cut. Errors
 * are worded for the agent, which sees them as the tool result.
 */
export async function readAnswerFile(
  bridge: RunnerExecBridge,
  agentId: string,
  path: string
): Promise<string> {
  const p = shPath(path);
  const probe = await bridge.exec(
    agentId,
    `if [ ! -e ${p} ]; then echo MISSING; elif [ ! -f ${p} ]; then echo NOT_A_FILE; elif [ ! -r ${p} ]; then echo UNREADABLE; else stat -c %s ${p}; fi`,
    { timeout: 10_000 }
  );
  const out = (probe.stdout || '').trim();
  if (out === 'MISSING') throw new Error(`${path} does not exist`);
  if (out === 'NOT_A_FILE') throw new Error(`${path} is not a regular file`);
  if (out === 'UNREADABLE') throw new Error(`${path} is not readable`);
  const size = Number.parseInt(out, 10);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`Cannot stat ${path}: ${probe.stderr || out || 'unknown error'}`);
  }

  if (size > LLM_MAX_ANSWER_BYTES) {
    throw new Error(
      `${path} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${LLM_MAX_ANSWER_BYTES / 1024 / 1024} MB answer limit`
    );
  }
  const res = await bridge.exec(agentId, `cat ${p}`, {
    timeout: 120_000,
    maxOutput: LLM_MAX_ANSWER_BYTES,
  });
  return res.stdout || '';
}

/** Delete the answer file of request `id` — the suggested path only. */
export function removeAnswerFile(bridge: RunnerExecBridge, agentId: string, id: string): void {
  bridge.exec(agentId, `rm -f ${shPath(llmAnswerFile(id))}`, { timeout: 10_000 }).catch(() => {});
}

interface PendingAnswer {
  agentId: string;
  answer: string | null;
}

const pending = new Map<string, PendingAnswer>();

/** Open a request `agentId` must answer; returns its id. */
export function openLlmAnswer(agentId: string): string {
  const id = crypto.randomUUID();
  pending.set(id, { agentId, answer: null });
  return id;
}

export type SubmitOutcome = 'accepted' | 'unknown' | 'not_yours';

/**
 * Record `answer` for request `id`, from agent `agentId`. Only the agent the
 * request was handed to may answer it; a second submission replaces the
 * first while the request is still waiting.
 */
export function submitLlmAnswer(id: string, agentId: string, answer: string): SubmitOutcome {
  const entry = pending.get(id);
  if (!entry) return 'unknown';
  if (entry.agentId !== agentId) return 'not_yours';
  entry.answer = answer;
  return 'accepted';
}

/** The answer submitted for request `id`, or null while none is. */
export function takeLlmAnswer(id: string): string | null {
  return pending.get(id)?.answer ?? null;
}

/** Forget request `id` (answered, abandoned or timed out). */
export function closeLlmAnswer(id: string): void {
  pending.delete(id);
}
