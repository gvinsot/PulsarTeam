// ── The authorization ratchet ────────────────────────────────────────────────
//
// PulsarTeam is multi-tenant and publicly routed: devops/docker-compose.swarm.yml
// sends `Host(pulsarteam.io) && PathPrefix(/api)` straight at this service, which
// holds its users' Google/Microsoft/GitHub/Slack OAuth tokens and bridges
// /api/local-folder/mcp to their physical machines. Every authorization defect
// found in this codebase so far has been the same one: a route that reached
// production without anyone stating, in one place, what was supposed to be
// guarding it.
//
// This test is that one place. It boots the real app from src/index.ts, walks
// the routing stack Express will actually use, and compares every mounted route
// against ROUTE_POLICY below.
//
//   • A route with no entry in ROUTE_POLICY fails the test. You cannot add a
//     route without declaring its protection.
//   • A route whose guards no longer match its entry fails the test. You cannot
//     remove a guard — or downgrade 'edit' to 'read' — without saying so here.
//   • An entry for a route that no longer exists fails the test, so the table
//     cannot rot into a list of dead promises.
//   • The number of routes declared PUBLIC is pinned. Widening the
//     unauthenticated surface is a deliberate, reviewable act.
//
// WHAT THE TABLE CAN AND CANNOT SEE. It reads the middleware chain Express
// stores, so it sees guards mounted as middleware and nothing else. Several
// routes below carry `['authenticateToken']` and are nonetheless properly
// scoped, because their check is written inline in the handler (tasks.ts calls
// checkBoardAccess, boards.ts's DELETE /:id/shares/:userId calls it after
// allowing self-removal, agents.ts's list endpoints filter through
// getAllForUser). Conversely, routers whose guard is an anonymous closure —
// plugins.ts's `requirePlugin`, and validateBody/validateQuery everywhere —
// are invisible here: naming those is the obvious next turn of this ratchet.
// So a `['authenticateToken']` entry means "no guard MIDDLEWARE beyond
// authentication", not "no authorization".

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMountedRoutes, type MountedRoute } from './helpers/expressRouteInventory.js';

/**
 * A route reachable with no authentication at all.
 *
 * On a multi-tenant deployment this is the dangerous category, so it is spelled
 * as a sentinel rather than an empty array: it greps, it reads, and every one
 * of the entries using it carries a comment saying why the exception exists.
 */
const PUBLIC = 'PUBLIC' as const;

/** Guards a route must carry, in order — or PUBLIC for a declared exception. */
type RoutePolicy = typeof PUBLIC | readonly string[];

/**
 * The middleware names this table understands as authorization.
 *
 * Express keeps only function references in its stack, so a guard is
 * recognizable only if it has a name. The four factories that used to return
 * anonymous functions now name what they return, permission level included:
 *   requireRole(admin) / requireRole(admin|advanced)  — middleware/auth.ts
 *   authorizeBoardAccess(read|edit|admin)             — middleware/authz.ts
 *   authorizeProjectAccess(read|edit|admin)           — middleware/authz.ts
 *   agentAccess(read|edit)                            — lib/agentAccess.ts
 * Anything else in the chain (cors, csrf, the JSON body parser, asyncHandler's
 * `handler` wrapper, the terminal route handlers) is not policy and is ignored.
 */
const GUARD_PREFIXES = [
  'authenticateToken', // session JWT / HttpOnly cookie — middleware/auth.ts
  'authenticateApiKey', // per-user API key (external Swarm API) — middleware/apiKeyAuth.ts
  'authenticateCoderApiKey', // shared runner key (/api/internal/*) — middleware/coderApiKeyAuth.ts
  'requireRole(',
  'authorizeBoardAccess(',
  'authorizeProjectAccess(',
  'agentAccess(',
];

/** The recognized guards on a route, de-duplicated, in execution order. */
function guardsOf(route: MountedRoute): string[] {
  const guards = route.chain.filter(name => GUARD_PREFIXES.some(prefix => name.startsWith(prefix)));
  return [...new Set(guards)];
}

function keyOf(route: MountedRoute): string {
  return `${route.method} ${route.path}`;
}

function describe(policy: RoutePolicy): string {
  return policy === PUBLIC ? 'PUBLIC (no authentication)' : policy.join(', ') || '(none)';
}

/**
 * Every route mounted by src/index.ts, and the protection it must carry.
 *
 * Keys are `METHOD /full/path` exactly as the router reports them; 'ALL' is a
 * route registered with `app.all()`.
 */
const ROUTE_POLICY: Readonly<Record<string, RoutePolicy>> = {
  // ── /api/auth ─────────────────────────────────────────────────────
  // Sign-in surface. Reached before a session exists, by definition. /verify
  // and /logout validate for themselves the token they are handed.
  'POST /api/auth/login': PUBLIC,
  'GET /api/auth/verify': PUBLIC,
  'POST /api/auth/logout': PUBLIC,
  'POST /api/auth/impersonate/:userId': ['authenticateToken'],
  'POST /api/auth/stop-impersonation': ['authenticateToken'],
  // OAuth sign-in, one triplet per provider. /status only reports whether the
  // provider is configured; /url mints a consent URL; /callback exchanges the
  // code for the session these routes exist to create. All three run before
  // the caller has any identity to check.
  'GET /api/auth/google/status': PUBLIC,
  'GET /api/auth/google/url': PUBLIC,
  'POST /api/auth/google/callback': PUBLIC,
  'GET /api/auth/microsoft/status': PUBLIC,
  'GET /api/auth/microsoft/url': PUBLIC,
  'POST /api/auth/microsoft/callback': PUBLIC,
  'GET /api/auth/github/status': PUBLIC,
  'GET /api/auth/github/url': PUBLIC,
  'POST /api/auth/github/callback': PUBLIC,
  'POST /api/auth/accept-terms': ['authenticateToken'],
  'POST /api/auth/complete-tutorial': ['authenticateToken'],

  // ── /api/users ────────────────────────────────────────────────────
  'GET /api/users': ['authenticateToken', 'requireRole(admin)'],
  'GET /api/users/:id': ['authenticateToken', 'requireRole(admin)'],
  'POST /api/users': ['authenticateToken', 'requireRole(admin)'],
  'PUT /api/users/:id': ['authenticateToken', 'requireRole(admin)'],
  'DELETE /api/users/:id': ['authenticateToken', 'requireRole(admin)'],

  // ── /api/contact ──────────────────────────────────────────────────
  // Public contact form (index.ts). Anonymous by product decision; the global
  // /api rate limiter is its only shield.
  'POST /api/contact': PUBLIC,

  // ── /api/google ───────────────────────────────────────────────────
  // Provider redirect targets. The identity provider's browser redirect lands
  // here carrying `state` + `code`; a cross-site navigation cannot be relied on
  // to send the SameSite session cookie, so these authenticate on `state`.
  'GET /api/google/oauth-redirect': PUBLIC,

  // ── /api/github ───────────────────────────────────────────────────
  'GET /api/github/oauth-redirect': PUBLIC,

  // ── /api/slack ────────────────────────────────────────────────────
  'GET /api/slack/oauth-redirect': PUBLIC,

  // ── /api/microsoft ────────────────────────────────────────────────
  'GET /api/microsoft/oauth-redirect': PUBLIC,

  // ── /api/agents ───────────────────────────────────────────────────
  'GET /api/agents': ['authenticateToken'],
  'GET /api/agents/statuses': ['authenticateToken'],
  'GET /api/agents/by-project/:project': ['authenticateToken'],
  'GET /api/agents/project-summary': ['authenticateToken'],
  'GET /api/agents/swarm-status': ['authenticateToken'],
  // Admin console for agents nobody can reach any more (no board and no live
  // owner). Both carry requireRole('admin') as MIDDLEWARE, so the guard is
  // visible here rather than hidden in the handler.
  'GET /api/agents/orphans': ['authenticateToken', 'requireRole(admin)'],
  'PUT /api/agents/:id/owner': ['authenticateToken', 'requireRole(admin)'],
  'POST /api/agents/reset-instructions/:role': ['authenticateToken'],
  'GET /api/agents/:id/status': ['authenticateToken', 'agentAccess(read)'],
  'GET /api/agents/:id': ['authenticateToken', 'agentAccess(read)'],
  'POST /api/agents': ['authenticateToken'],
  'PUT /api/agents/:id': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/batch': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/chat': ['authenticateToken', 'agentAccess(edit)'],
  'GET /api/agents/:id/history': ['authenticateToken', 'agentAccess(read)'],
  'POST /api/agents/:id/history/reload': ['authenticateToken', 'agentAccess(read)'],
  'POST /api/agents/:id/stop': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/history': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/reload-context': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/restart': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/history/after/:index': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/action-logs': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/handoff': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/broadcast/all': ['authenticateToken'],
  'PUT /api/agents/project/all': ['authenticateToken'],
  'POST /api/agents/:id/tasks': ['authenticateToken', 'agentAccess(edit)'],
  'PATCH /api/agents/:id/tasks/:taskId': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/tasks': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/tasks/:taskId': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/tasks/:taskId/transfer': ['authenticateToken', 'agentAccess(edit)'],
  'PATCH /api/agents/:id/tasks/:taskId/assignee': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/tasks/:taskId/commits': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/tasks/:taskId/commits/:hash': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/tasks/:taskId/refine': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/rag': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/rag/url': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/rag/:docId/refresh': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/rag/:docId': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/plugins': ['authenticateToken', 'agentAccess(edit)'],
  'DELETE /api/agents/:id/plugins/:pluginId': ['authenticateToken', 'agentAccess(edit)'],
  'POST /api/agents/:id/skills': ['authenticateToken', 'agentAccess(edit)'],
  'GET /api/agents/tasks/stats': ['authenticateToken'],
  'GET /api/agents/tasks/stats/timeseries': ['authenticateToken'],
  'GET /api/agents/tasks/stats/agent-time': ['authenticateToken'],
  'GET /api/agents/tasks/:id/history': ['authenticateToken'],
  'DELETE /api/agents/:id/skills/:skillId': ['authenticateToken', 'agentAccess(edit)'],

  // ── /api/templates ────────────────────────────────────────────────
  'GET /api/templates': ['authenticateToken'],
  'GET /api/templates/:id': ['authenticateToken'],

  // ── /api/projects ─────────────────────────────────────────────────
  'GET /api/projects': ['authenticateToken'],
  'GET /api/projects/:id': ['authenticateToken', 'authorizeProjectAccess(read)'],
  'POST /api/projects': ['authenticateToken', 'requireRole(admin|advanced)'],
  'PUT /api/projects/:id': [
    'authenticateToken',
    'requireRole(admin|advanced)',
    'authorizeProjectAccess(edit)',
  ],
  'DELETE /api/projects/:id': [
    'authenticateToken',
    'requireRole(admin|advanced)',
    'authorizeProjectAccess(admin)',
  ],
  'GET /api/projects/:id/boards': ['authenticateToken', 'authorizeProjectAccess(read)'],
  'POST /api/projects/:id/boards/:boardId': [
    'authenticateToken',
    'authorizeProjectAccess(edit)',
    'authorizeBoardAccess(admin)',
  ],
  'DELETE /api/projects/:id/boards/:boardId': [
    'authenticateToken',
    'authorizeProjectAccess(edit)',
    'authorizeBoardAccess(admin)',
  ],
  'GET /api/projects/boards/:boardId/repos': ['authenticateToken', 'authorizeBoardAccess(read)'],
  'GET /api/projects/boards/:boardId/storages': ['authenticateToken', 'authorizeBoardAccess(read)'],
  'GET /api/projects/available-repos': ['authenticateToken'],
  'GET /api/projects/boards/:boardId/available-repos': [
    'authenticateToken',
    'authorizeBoardAccess(read)',
  ],
  'GET /api/projects/boards/:boardId/available-storages': [
    'authenticateToken',
    'authorizeBoardAccess(read)',
  ],
  'GET /api/projects/github-activity/:owner/:repo': [
    'authenticateToken',
    'authorizeBoardAccess(read)',
  ],
  'GET /api/projects/github-branches/:owner/:repo': [
    'authenticateToken',
    'authorizeBoardAccess(read)',
  ],
  'GET /api/projects/github-tree/:owner/:repo/:ref': [
    'authenticateToken',
    'authorizeBoardAccess(read)',
  ],
  'GET /api/projects/github-file/:owner/:repo/:ref/*': [
    'authenticateToken',
    'authorizeBoardAccess(read)',
  ],
  'POST /api/projects/code-graph/:owner/:repo': ['authenticateToken', 'authorizeBoardAccess(read)'],

  // ── /api/code-index ───────────────────────────────────────────────
  'POST /api/code-index/index-folder': ['authenticateToken', 'requireRole(admin)'],
  'GET /api/code-index/repos': ['authenticateToken'],
  'GET /api/code-index/repos/:repoId': ['authenticateToken'],
  'GET /api/code-index/repos/:repoId/file-tree': ['authenticateToken'],
  'GET /api/code-index/repos/:repoId/file-outline': ['authenticateToken'],
  'GET /api/code-index/repos/:repoId/symbol': ['authenticateToken'],
  'GET /api/code-index/repos/:repoId/search-symbols': ['authenticateToken'],
  'GET /api/code-index/repos/:repoId/search-semantic': ['authenticateToken'],
  'GET /api/code-index/repos/:repoId/search-text': ['authenticateToken'],
  'POST /api/code-index/index-project': ['authenticateToken'],
  'POST /api/code-index/repos/:repoId/update-files': ['authenticateToken', 'requireRole(admin)'],
  'DELETE /api/code-index/repos/:repoId': ['authenticateToken', 'requireRole(admin)'],

  // ── /api/plugins ──────────────────────────────────────────────────
  'GET /api/plugins': ['authenticateToken'],
  'GET /api/plugins/:id': ['authenticateToken'],
  'POST /api/plugins': ['authenticateToken'],
  'PUT /api/plugins/:id': ['authenticateToken'],
  'PATCH /api/plugins/:id/share': ['authenticateToken'],
  'DELETE /api/plugins/:id': ['authenticateToken'],
  'POST /api/plugins/:id/mcps/:mcpId': ['authenticateToken'],
  'DELETE /api/plugins/:id/mcps/:mcpId': ['authenticateToken'],

  // ── /api/agent-skills ─────────────────────────────────────────────
  'GET /api/agent-skills': ['authenticateToken'],
  'GET /api/agent-skills/search': ['authenticateToken'],
  'GET /api/agent-skills/:id': ['authenticateToken'],
  'POST /api/agent-skills': ['authenticateToken', 'requireRole(admin|advanced)'],
  'PUT /api/agent-skills/:id': ['authenticateToken', 'requireRole(admin|advanced)'],
  'DELETE /api/agent-skills/:id': ['authenticateToken', 'requireRole(admin|advanced)'],

  // ── /api/mcp-servers ──────────────────────────────────────────────
  'GET /api/mcp-servers': ['authenticateToken'],
  'GET /api/mcp-servers/:id': ['authenticateToken'],
  'POST /api/mcp-servers': ['authenticateToken', 'requireRole(admin)'],
  'PUT /api/mcp-servers/:id': ['authenticateToken', 'requireRole(admin)'],
  'DELETE /api/mcp-servers/:id': ['authenticateToken', 'requireRole(admin)'],
  'POST /api/mcp-servers/:id/connect': ['authenticateToken', 'requireRole(admin)'],
  'POST /api/mcp-servers/:id/test': ['authenticateToken'],

  // ── /api/onedrive ─────────────────────────────────────────────────
  'GET /api/onedrive/status': ['authenticateToken'],
  'GET /api/onedrive/auth-url': ['authenticateToken'],
  'POST /api/onedrive/disconnect': ['authenticateToken'],

  // ── /api/outlook ──────────────────────────────────────────────────
  'GET /api/outlook/status': ['authenticateToken'],
  'GET /api/outlook/auth-url': ['authenticateToken'],
  'POST /api/outlook/disconnect': ['authenticateToken'],

  // ── /api/gmail ────────────────────────────────────────────────────
  'GET /api/gmail/status': ['authenticateToken'],
  'GET /api/gmail/auth-url': ['authenticateToken'],
  'POST /api/gmail/disconnect': ['authenticateToken'],

  // ── /api/gdrive ───────────────────────────────────────────────────
  'GET /api/gdrive/status': ['authenticateToken'],
  'GET /api/gdrive/auth-url': ['authenticateToken'],
  'POST /api/gdrive/disconnect': ['authenticateToken'],

  // ── /api/slack ────────────────────────────────────────────────────
  'GET /api/slack/status': ['authenticateToken'],
  'GET /api/slack/auth-url': ['authenticateToken'],
  'POST /api/slack/disconnect': ['authenticateToken'],

  // ── /api/realtime ─────────────────────────────────────────────────
  'POST /api/realtime/token': ['authenticateToken'],

  // ── /api/external-voice ───────────────────────────────────────────
  'GET /api/external-voice/config/:agentId': ['authenticateToken'],
  'GET /api/external-voice/services': ['authenticateToken'],
  // Admin-only: it probes a caller-named URL, and used to pair it with the
  // stored STT/TTS key — see the comment on the route.
  'POST /api/external-voice/test/:service': ['authenticateToken', 'requireRole(admin)'],

  // ── /api/leader-tools ─────────────────────────────────────────────
  'GET /api/leader-tools/last-messages': ['authenticateToken'],
  'GET /api/leader-tools/agent-status': ['authenticateToken'],
  'GET /api/leader-tools/all-statuses': ['authenticateToken'],
  'GET /api/leader-tools/swarm-status': ['authenticateToken'],
  'GET /api/leader-tools/by-project/:project': ['authenticateToken'],
  'GET /api/leader-tools/project-summary': ['authenticateToken'],

  // ── /api/budget ───────────────────────────────────────────────────
  'GET /api/budget/summary': ['authenticateToken'],
  'GET /api/budget/by-agent': ['authenticateToken'],
  'GET /api/budget/timeline': ['authenticateToken'],
  'GET /api/budget/daily': ['authenticateToken'],
  'GET /api/budget/config': ['authenticateToken'],
  'PUT /api/budget/config': ['authenticateToken', 'requireRole(admin)'],
  'GET /api/budget/alerts': ['authenticateToken'],

  // ── /api/settings ─────────────────────────────────────────────────
  'GET /api/settings/api-key': ['authenticateToken', 'requireRole(admin)'],
  'POST /api/settings/api-key': ['authenticateToken', 'requireRole(admin)'],
  'DELETE /api/settings/api-key': ['authenticateToken', 'requireRole(admin)'],

  // ── /api/llm-configs ──────────────────────────────────────────────
  'GET /api/llm-configs': ['authenticateToken'],
  'GET /api/llm-configs/:id': ['authenticateToken'],
  'POST /api/llm-configs': ['authenticateToken', 'requireRole(admin)'],
  'PUT /api/llm-configs/:id': ['authenticateToken', 'requireRole(admin)'],
  'DELETE /api/llm-configs/:id': ['authenticateToken', 'requireRole(admin)'],

  // ── /api/settings ─────────────────────────────────────────────────
  'GET /api/settings/general': ['authenticateToken'],
  'PUT /api/settings/general': ['authenticateToken', 'requireRole(admin)'],
  'GET /api/settings/general/reminders': ['authenticateToken'],
  'PUT /api/settings/general/reminders': ['authenticateToken', 'requireRole(admin)'],

  // ── /api/jira ─────────────────────────────────────────────────────
  'GET /api/jira/status': ['authenticateToken'],
  'POST /api/jira/connect': ['authenticateToken'],
  'POST /api/jira/disconnect': ['authenticateToken'],

  // ── /api/wordpress ────────────────────────────────────────────────
  'GET /api/wordpress/status': ['authenticateToken'],
  'POST /api/wordpress/connect': ['authenticateToken'],
  'POST /api/wordpress/disconnect': ['authenticateToken'],

  // ── /api/s3 ───────────────────────────────────────────────────────
  'GET /api/s3/status': ['authenticateToken'],
  'POST /api/s3/connect': ['authenticateToken'],
  'POST /api/s3/disconnect': ['authenticateToken'],

  // ── /api/local-folder ─────────────────────────────────────────────
  'GET /api/local-folder/status': ['authenticateToken'],

  // ── /api/github ───────────────────────────────────────────────────
  'GET /api/github/status': ['authenticateToken'],
  'GET /api/github/auth-url': ['authenticateToken'],
  'POST /api/github/disconnect': ['authenticateToken'],

  // ── /api/boards ───────────────────────────────────────────────────
  'GET /api/boards': ['authenticateToken'],
  'GET /api/boards/tasks/by-assignee/:agentId': ['authenticateToken'],
  'GET /api/boards/users': ['authenticateToken'],
  'GET /api/boards/all': ['authenticateToken'],
  'GET /api/boards/:id': ['authenticateToken', 'authorizeBoardAccess(read)'],
  'POST /api/boards': ['authenticateToken'],
  'PUT /api/boards/:id': ['authenticateToken', 'authorizeBoardAccess(edit)'],
  'PUT /api/boards/:id/workflow': ['authenticateToken', 'authorizeBoardAccess(edit)'],
  'GET /api/boards/:id/plugins': ['authenticateToken', 'authorizeBoardAccess(read)'],
  'PUT /api/boards/:id/plugins': ['authenticateToken', 'authorizeBoardAccess(edit)'],
  'POST /api/boards/:id/plugins/assign': ['authenticateToken', 'authorizeBoardAccess(edit)'],
  'POST /api/boards/:id/plugins/remove': ['authenticateToken', 'authorizeBoardAccess(edit)'],
  'PUT /api/boards/:id/mcp-auth': ['authenticateToken', 'authorizeBoardAccess(edit)'],
  'DELETE /api/boards/:id': ['authenticateToken', 'authorizeBoardAccess(admin)'],
  'GET /api/boards/:id/shares': ['authenticateToken', 'authorizeBoardAccess(admin)'],
  'POST /api/boards/:id/shares': ['authenticateToken', 'authorizeBoardAccess(admin)'],
  'PUT /api/boards/:id/shares/:userId': ['authenticateToken', 'authorizeBoardAccess(admin)'],
  'DELETE /api/boards/:id/shares/:userId': ['authenticateToken'],
  'GET /api/boards/:id/audit': ['authenticateToken', 'authorizeBoardAccess(admin)'],

  // ── /api/tasks ────────────────────────────────────────────────────
  'GET /api/tasks': ['authenticateToken'],
  'PUT /api/tasks/reorder': ['authenticateToken'],
  'PUT /api/tasks/:id': ['authenticateToken'],
  'POST /api/tasks/bulk-move': ['authenticateToken'],
  'POST /api/tasks/:id/stop': ['authenticateToken'],
  'PATCH /api/tasks/:id/clear-stopped': ['authenticateToken'],
  'DELETE /api/tasks/:id': ['authenticateToken'],
  'GET /api/tasks/deleted': ['authenticateToken', 'requireRole(admin)'],
  'POST /api/tasks/:id/restore': ['authenticateToken', 'requireRole(admin)'],
  'DELETE /api/tasks/:id/permanent': ['authenticateToken', 'requireRole(admin)'],
  'GET /api/tasks/:id/history': ['authenticateToken'],
  'GET /api/tasks/project-stats': ['authenticateToken'],
  'GET /api/tasks/stats': ['authenticateToken'],
  'GET /api/tasks/audit': ['authenticateToken', 'requireRole(admin)'],
  'POST /api/tasks/purge': ['authenticateToken', 'requireRole(admin)'],
  'GET /api/tasks/:id/commits/:hash/diff': ['authenticateToken'],

  // ── /api/internal ─────────────────────────────────────────────────
  'GET /api/internal/claude-tokens/:ownerId': ['authenticateCoderApiKey'],
  'POST /api/internal/claude-tokens/:ownerId': ['authenticateCoderApiKey'],
  'DELETE /api/internal/claude-tokens/:ownerId': ['authenticateCoderApiKey'],
  'GET /api/internal/codex-tokens/:ownerId': ['authenticateCoderApiKey'],
  'POST /api/internal/codex-tokens/:ownerId': ['authenticateCoderApiKey'],
  'DELETE /api/internal/codex-tokens/:ownerId': ['authenticateCoderApiKey'],
  'GET /api/internal/runner-llm/local-models': ['authenticateCoderApiKey'],
  'GET /api/internal/runner-llm/agents/:agentId': ['authenticateCoderApiKey'],
  'GET /api/internal/runner-llm/claude-fallback': ['authenticateCoderApiKey'],
  'GET /api/internal/runner-config/:runner/agents/:agentId': ['authenticateCoderApiKey'],
  'PUT /api/internal/runner-config/:runner/agents/:agentId': ['authenticateCoderApiKey'],
  'DELETE /api/internal/runner-config/:runner/agents/:agentId': ['authenticateCoderApiKey'],
  'GET /api/internal/runner-mcp/agents/:agentId': ['authenticateCoderApiKey'],
  'GET /api/internal/runner-instructions/agents/:agentId': ['authenticateCoderApiKey'],
  'POST /api/internal/token-usage/agents/:agentId': ['authenticateCoderApiKey'],

  // ── /api/codex-auth ───────────────────────────────────────────────
  'GET /api/codex-auth/:ownerId/status': ['authenticateToken'],
  'POST /api/codex-auth/:ownerId': ['authenticateToken'],
  'DELETE /api/codex-auth/:ownerId': ['authenticateToken'],

  // ── /api/onedrive ─────────────────────────────────────────────────
  'ALL /api/onedrive/mcp': ['authenticateToken'],

  // ── /api/gmail ────────────────────────────────────────────────────
  'ALL /api/gmail/mcp': ['authenticateToken'],

  // ── /api/outlook ──────────────────────────────────────────────────
  'ALL /api/outlook/mcp': ['authenticateToken'],

  // ── /api/gdrive ───────────────────────────────────────────────────
  'ALL /api/gdrive/mcp': ['authenticateToken'],

  // ── /api/slack ────────────────────────────────────────────────────
  'ALL /api/slack/mcp': ['authenticateToken'],

  // ── /api/jira ─────────────────────────────────────────────────────
  'ALL /api/jira/mcp': ['authenticateToken'],

  // ── /api/wordpress ────────────────────────────────────────────────
  'ALL /api/wordpress/mcp': ['authenticateToken'],

  // ── /api/github ───────────────────────────────────────────────────
  'ALL /api/github/mcp': ['authenticateToken'],

  // ── /api/s3 ───────────────────────────────────────────────────────
  'ALL /api/s3/mcp': ['authenticateToken'],

  // ── /api/local-folder ─────────────────────────────────────────────
  'ALL /api/local-folder/mcp': ['authenticateToken'],

  // ── /api/code-index ───────────────────────────────────────────────
  'ALL /api/code-index/mcp': ['authenticateToken'],

  // ── /api/gandi-dns ────────────────────────────────────────────────
  'ALL /api/gandi-dns/mcp': ['authenticateToken'],

  // ── /api/auto-learn ───────────────────────────────────────────────
  'ALL /api/auto-learn/mcp': ['authenticateToken'],

  // ── /api/browser ──────────────────────────────────────────────────
  'ALL /api/browser/mcp': ['authenticateToken'],

  // ── /api/swarm-api ────────────────────────────────────────────────
  'ALL /api/swarm-api/mcp': ['authenticateToken'],

  // ── /api/pulsar-gateway ───────────────────────────────────────────
  'ALL /api/pulsar-gateway/mcp': ['authenticateToken'],

  // ── /api/swarm ────────────────────────────────────────────────────
  'ALL /api/swarm/mcp': ['authenticateApiKey'],
  'GET /api/swarm/agents': ['authenticateApiKey'],
  'GET /api/swarm/agents/:id': ['authenticateApiKey'],
  'GET /api/swarm/boards': ['authenticateApiKey'],
  'POST /api/swarm/agents/:id/tasks': ['authenticateApiKey'],

  // ── /api/health ───────────────────────────────────────────────────
  // Liveness/readiness probe. Polled by Docker, Swarm and Traefik, none of which
  // can present a session. Answers a fixed shape and no tenant data.
  'GET /api/health': PUBLIC,
  'GET /api/health/details': ['authenticateToken'],
};

/**
 * How many routes may be reached without authentication.
 *
 * Pinned so that making a route public is never a side effect of an edit. If
 * you change this number, the reviewer's question is "which route, and why".
 */
const EXPECTED_PUBLIC_ROUTES = 18;

test('every mounted route declares a policy in ROUTE_POLICY', async () => {
  const routes = await loadMountedRoutes();
  const undeclared = routes.filter(route => !(keyOf(route) in ROUTE_POLICY));
  if (undeclared.length > 0) {
    const suggestions = undeclared
      .map(
        route =>
          `    '${keyOf(route)}': [${guardsOf(route)
            .map(g => `'${g}'`)
            .join(', ')}],`
      )
      .join('\n');
    assert.fail(
      `${undeclared.length} route(s) are mounted in src/index.ts but absent from ROUTE_POLICY ` +
        `in ${'src/services/__tests__/routeInventory.test.ts'}.\n\n` +
        'Declare each one. The guards they currently carry are:\n\n' +
        `${suggestions}\n\n` +
        'If a route is meant to be reachable with no authentication at all, declare it as ' +
        'PUBLIC, bump EXPECTED_PUBLIC_ROUTES, and write the reason in a comment beside it — ' +
        'this API is multi-tenant and publicly routed.'
    );
  }
});

test('every route still carries the guards its policy declares', async () => {
  const routes = await loadMountedRoutes();
  const problems: string[] = [];
  for (const route of routes) {
    const key = keyOf(route);
    const policy = ROUTE_POLICY[key];
    if (policy === undefined) continue; // reported by the test above
    const actual = guardsOf(route);
    const expected = policy === PUBLIC ? [] : [...policy];
    const matches = actual.length === expected.length && actual.every((g, i) => g === expected[i]);
    if (!matches) {
      problems.push(
        `  ${key}\n` +
          `    policy declares: ${describe(policy)}\n` +
          `    route now has:   ${actual.join(', ') || '(none — UNAUTHENTICATED)'}`
      );
    }
  }
  if (problems.length > 0) {
    assert.fail(
      `${problems.length} route(s) no longer match their declared protection:\n\n` +
        `${problems.join('\n\n')}\n\n` +
        'A guard that DISAPPEARED is an authorization regression: restore it. A guard that ' +
        'was ADDED is fine — the table simply has to say so. Either way, update ROUTE_POLICY ' +
        'in the same commit, so the guard and its declaration are reviewed together.'
    );
  }
});

test('ROUTE_POLICY has no entry for a route that no longer exists', async () => {
  const routes = await loadMountedRoutes();
  const mounted = new Set(routes.map(keyOf));
  const stale = Object.keys(ROUTE_POLICY).filter(key => !mounted.has(key));
  if (stale.length > 0) {
    assert.fail(
      `${stale.length} ROUTE_POLICY entr(ies) describe routes that are no longer mounted:\n\n` +
        `${stale.map(key => `  ${key}`).join('\n')}\n\n` +
        'Remove them. A table full of dead entries stops being read, and then stops ' +
        'protecting anything.'
    );
  }
});

test('the unauthenticated surface has not grown', async () => {
  const routes = await loadMountedRoutes();
  const publicRoutes = routes.filter(route => ROUTE_POLICY[keyOf(route)] === PUBLIC);
  assert.equal(
    publicRoutes.length,
    EXPECTED_PUBLIC_ROUTES,
    `Expected exactly ${EXPECTED_PUBLIC_ROUTES} route(s) reachable without authentication, ` +
      `found ${publicRoutes.length}:\n${publicRoutes.map(r => `  ${keyOf(r)}`).join('\n')}\n` +
      'Each public route on a multi-tenant, internet-facing API needs a stated reason. ' +
      'If you added one deliberately, update EXPECTED_PUBLIC_ROUTES and say why in the table.'
  );

  // And nothing may be public without saying so: a route whose policy declares
  // guards must actually have them (the previous test), and a route with no
  // guards at all must be declared PUBLIC.
  const silentlyOpen = routes.filter(
    route => guardsOf(route).length === 0 && ROUTE_POLICY[keyOf(route)] !== PUBLIC
  );
  assert.deepEqual(
    silentlyOpen.map(keyOf),
    [],
    'These routes carry no authentication middleware but are not declared PUBLIC.'
  );
});

test('authorization guards are still identifiable by name', async () => {
  const routes = await loadMountedRoutes();
  const vocabulary = new Set(routes.flatMap(guardsOf));
  // If a guard factory goes back to returning an anonymous function, its name
  // vanishes from the stack and this table quietly stops seeing it. These are
  // the four factories that name what they return.
  for (const guard of [
    'requireRole(admin)',
    'authorizeBoardAccess(admin)',
    'authorizeProjectAccess(read)',
    'agentAccess(edit)',
  ]) {
    assert.ok(
      vocabulary.has(guard),
      `No route in the routing stack carries '${guard}'. Either every use of it was removed, ` +
        'or its factory stopped naming the middleware it returns (see GUARD_PREFIXES above) — ' +
        'in which case this whole table is now blind to that guard.'
    );
  }
});
