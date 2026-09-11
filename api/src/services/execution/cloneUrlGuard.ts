// ── Clone-URL allowlist ──────────────────────────────────────────────────────
//
// Defense in depth around the one place where a GitHub token leaves the API:
// `ensureAgentWorkspace` hands `(gitUrl, gitCredentials)` to the runner's
// `/projects/ensure`, and the runner splices the token INTO that URL
// (`agent_user.py::_authenticated_https_url`) before writing it to
// `~/.git-credentials`. Whatever host the URL names therefore receives the
// agent's token — and keeps receiving it for every later push from that
// workspace.
//
// Today the URL is server-derived (`tasks.ts` builds `https://github.com/<full
// name>` from `repo_full_name`, `buildRepoCloneUrl` does the same), so no
// caller can point it elsewhere. But `repoHtmlUrl` IS a task field exposed by
// the API/MCP surfaces; the day it becomes writable — a new column, a wider
// update payload, an importer that trusts a webhook — a task carrying
// `http://…`, `file://…`, `ssh://…` or simply another host would exfiltrate the
// token with no other check in the way. This module is that check: an explicit
// allowlist applied to the FINAL url, before any credential-bearing call.
//
// The allowlist is github.com plus whatever GitHub Enterprise Server hosts the
// operator configured — nothing is inferred from the URL itself.

/** github.com and the www alias it redirects from. */
const DEFAULT_ALLOWED_HOSTS = ['github.com', 'www.github.com'];

/**
 * Operator-configured GitHub Enterprise Server hosts, read at call time (same
 * convention as `runnerRegistry`, and it keeps the guard testable).
 *
 * `GIT_CLONE_ALLOWED_HOSTS` is a comma-separated list; `GITHUB_ENTERPRISE_HOST`
 * is accepted as a single-host alias. Entries may be written as a bare host, a
 * `host:port`, or a full URL — only the authority is kept.
 */
function configuredHosts(): string[] {
  const raw = [process.env.GIT_CLONE_ALLOWED_HOSTS, process.env.GITHUB_ENTERPRISE_HOST]
    .filter(Boolean)
    .join(',');
  return raw
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
    .map(
      entry =>
        entry
          .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // strip an accidental scheme
          .replace(/\/.*$/, '') // strip an accidental path
          .replace(/^\[?([^\]]*)\]?$/, '$1') // unbracket an IPv6 literal
    )
    .filter(Boolean);
}

/** The hosts a clone URL may name, lowercased, `host` or `host:port`. */
export function allowedCloneHosts(): string[] {
  return [...DEFAULT_ALLOWED_HOSTS, ...configuredHosts()];
}

/**
 * True when `url` is an https URL on an allowlisted host and carries no
 * embedded credentials. Anything unparseable is false — fail closed.
 */
export function isAllowedCloneUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // https only: http:// downgrades the token to cleartext, and git://, ssh://,
  // file:// or ext:: hand it (or the filesystem) to something that is not a
  // GitHub API at all.
  if (parsed.protocol !== 'https:') return false;
  // A userinfo section would silently override the credentials the runner is
  // about to install, and is never present in a URL we build ourselves.
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host) return false;
  const authority = parsed.port ? `${host}:${parsed.port}` : host;
  // Exact match only — no suffix test, or `github.com.evil.tld` would pass.
  return allowedCloneHosts().some(allowed => allowed === host || allowed === authority);
}

/**
 * Throw unless `url` may receive the agent's git credentials. The message names
 * the host so an operator who legitimately runs GHES knows what to allowlist,
 * but never echoes the URL's userinfo.
 */
export function assertAllowedCloneUrl(url: string | null | undefined, repo?: string | null): void {
  if (isAllowedCloneUrl(url)) return;
  let where = 'an unparseable URL';
  try {
    const parsed = new URL(String(url));
    where = `${parsed.protocol}//${parsed.host || '(no host)'}`;
  } catch {
    /* keep the generic label — never echo an unparsed, attacker-shaped string */
  }
  throw new Error(
    `Refusing to send git credentials to ${where}` +
      (repo ? ` for repo "${repo}"` : '') +
      `: clone URLs must be https on an allowed host (${allowedCloneHosts().join(', ')}). ` +
      `Set GIT_CLONE_ALLOWED_HOSTS to add a GitHub Enterprise Server host.`
  );
}
