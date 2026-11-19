/**
 * Pure helpers behind the workflow editor's per-column auto-retry panel
 * (ColumnAutoRetryEditor.tsx). The server-side semantics live in
 * api/src/services/workflow/columnAutoRetry.ts: each part is off when its number
 * is absent / 0, and the escalation needs a non-empty instruction.
 */
import type { ColumnAutoRetry } from '../../types';

/** Upper bounds mirrored from AUTO_RETRY_LIMITS on the API side. */
export const AUTO_RETRY_MAX = {
  intervalMinutes: 7 * 24 * 60,
  escalateAfterMinutes: 30 * 24 * 60,
  maxRetries: 1000,
  instructions: 4000,
} as const;

/** Parse a number input: '' or anything invalid becomes null, else a clamped int. */
export function parseMinutes(raw: string, max: number): number | null {
  if (raw.trim() === '') return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, max);
}

/** True when some part of the config is active. */
export function isAutoRetryActive(config: ColumnAutoRetry | null | undefined): boolean {
  if (!config) return false;
  return !!config.intervalMinutes || !!config.escalateAfterMinutes;
}

/**
 * Normalize before saving: an all-off config becomes null (the key is dropped),
 * and the retry cap only makes sense with an interval.
 */
export function cleanAutoRetry(config: ColumnAutoRetry | null | undefined): ColumnAutoRetry | null {
  if (!isAutoRetryActive(config) || !config) return null;
  const out: ColumnAutoRetry = {};
  if (config.intervalMinutes) {
    out.intervalMinutes = config.intervalMinutes;
    if (config.maxRetries) out.maxRetries = config.maxRetries;
  }
  if (config.escalateAfterMinutes) {
    out.escalateAfterMinutes = config.escalateAfterMinutes;
    out.escalationInstructions = (config.escalationInstructions || '').slice(
      0,
      AUTO_RETRY_MAX.instructions
    );
  }
  return out;
}

/** An escalation delay without an instruction is rejected by the API. */
export function autoRetryMissingInstructions(config: ColumnAutoRetry | null | undefined) {
  return !!config?.escalateAfterMinutes && !(config.escalationInstructions || '').trim();
}
