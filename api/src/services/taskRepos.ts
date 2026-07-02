// ─── Task repo / storage binding normalization (shared domain helpers) ───────
// Canonical home for validating + normalizing the repo/storage inputs a task
// carries. These were copy-pasted across agentManager/tasks.ts, routes/tasks.ts,
// routes/agents.ts and swarmApiMcp.ts (each with its own `owner/repo` regex and
// its own normalizeSecondaryRepos), which let subtle divergences creep in.
// Unit-tested in __tests__/taskRepos.test.ts.

/** "owner/repo" shape — word chars, dots and dashes on each side of a single slash. */
export const REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

/** Cap on secondary repos cloned alongside the primary, so clone time stays bounded. */
export const MAX_SECONDARY_REPOS = 10;

/** Length cap for a storage path coming from a remote caller. */
export const STORAGE_PATH_MAX = 500;

/** True iff `value` is a well-formed "owner/repo" string. */
export function isValidRepoFullName(value: any): value is string {
  return typeof value === 'string' && REPO_FULL_NAME_RE.test(value);
}

/**
 * Validate + normalize a repo full-name ("owner/repo"): trims, and returns the
 * trimmed value when well-formed, else null (empty / non-string / bad shape).
 */
export function normalizeRepoFullName(value: any): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return REPO_FULL_NAME_RE.test(trimmed) ? trimmed : null;
}

/** Trim + length-cap a storage path from a remote caller, or null when empty/non-string. */
export function normalizeStoragePath(value: any): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, STORAGE_PATH_MAX);
}

/**
 * Coerce an arbitrary secondaryRepos input into a clean [{provider, fullName}]:
 * accept either bare "owner/repo" strings or {provider, fullName} objects, keep
 * only well-formed entries, default provider to 'github', drop the primary repo,
 * dedupe by fullName, and cap the count so clone time stays bounded. Always
 * returns an array (never null).
 */
export function normalizeSecondaryRepos(input: any, primaryFullName?: string | null): Array<{ provider: string; fullName: string }> {
  if (!Array.isArray(input)) return [];
  const primary = primaryFullName || null;
  const seen = new Set<string>();
  const out: Array<{ provider: string; fullName: string }> = [];
  for (const raw of input) {
    const fullName = typeof raw === 'string'
      ? raw
      : (raw && typeof raw.fullName === 'string' ? raw.fullName : null);
    if (!fullName || !REPO_FULL_NAME_RE.test(fullName)) continue;
    if (primary && fullName === primary) continue;
    if (seen.has(fullName)) continue;
    seen.add(fullName);
    const provider = (raw && typeof raw === 'object' && typeof raw.provider === 'string' && raw.provider)
      ? raw.provider
      : 'github';
    out.push({ provider, fullName });
    if (out.length >= MAX_SECONDARY_REPOS) break;
  }
  return out;
}
