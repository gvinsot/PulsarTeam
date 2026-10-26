# Refactoring survey — 2026-07-02

Fresh code-quality analysis performed after the previous 121-item survey (`refactor-survey.json`) was fully applied on 2026-06-14. Five parallel review passes covered: api routes/middleware, api services, frontend, runner-service, and cross-cutting/infra. Every finding was verified against the current code (exact file:line evidence) and checked for overlap with the already-applied survey.

**35 backlog tasks were created on the Pulsar board** (board `bf28a9f5-3efd-454a-83e2-7e562c10cbbe`), each self-contained with Files / Problem / Proposal / Impact / Effort. Index below (prefix = area).

## High impact
| Task | Effort |
|---|---|
| [api] Finish the CLI-runner single-source-of-truth migration (3 drifted local copies in chat.ts, llmProviders.ts, terminal.ts — latent behavior bugs) | S |
| [api] Migrate the six remaining hand-rolled execution-state resets to clearExecutionOnMove | S/M |
| [api] Extract one shared task-move core for PUT /tasks/:id and POST /tasks/bulk-move | M |
| [api] Extract a task-poll verdict helper and decompose the 243-line _waitForExecutionComplete | M |
| [api] Add asyncHandler + central error middleware (~85 identical catch blocks) | M |
| [api] Move the login/OAuth router out of middleware/auth.ts, table-drive the 3 login providers | M |
| [frontend] Extract useBoards/useBoardTasks hooks out of TasksBoard; share boards state with Dashboard | L |
| [frontend] Split TaskDetailModal into section subcomponents + shared Pill badge | M |
| [runner] Extract one shared team-api HTTP client used by 9 modules | M |
| [runner] Fold ClaudeCodeBackend's duplicated infrastructure into the shared CLI base | M |
| [infra] Collapse the 8 copy-pasted runner-service blocks in compose files with YAML anchors | M |

## Medium impact
| Task | Effort |
|---|---|
| [api] Use authorizeProjectAccess/authorizeBoardAccess in projects.ts (11 hand-rolled preambles, dead security export) | S |
| [api] One shared "resolve the agent's active task" priority chain (4 re-implementations) | M |
| [api] Merge the twin voice relay handlers in socketHandler | S |
| [api] Extract shared repo/storage field normalization + delete getMemTask shim | S |
| [api] Collapse the six plugin permission preambles in plugins.ts into guard middleware | S |
| [api] Deduplicate the four history-scoping blocks in _assembleMessages | S |
| [api] Fold MistralProvider into an OpenAI-compatible base in llmProviders.ts | M |
| [api] Merge the duplicated selection phases of findAgentByRole/findAgentForAssignment | S |
| [frontend] Move plugin-manager and bulk-actions tabs out of BroadcastPanel; reuse AvailablePluginRow | M |
| [frontend] Delete dead WebSocketContext + extract useSocketEvent hook (fixes latent event-loss bug) | S |
| [frontend] Config-drive LoginPage OAuth providers + contact-form fields; drop dead prop | M |
| [frontend] One shared Markdown preset (3 duplicated component maps) + one timeAgo | S |
| [frontend] Extract RepoExplorer from GitHubActivityModal | S |
| [runner] Turn the 525-line _drive_pty_blocking closure into a driver class; share ANSI/hint primitives | L |
| [runner] Apply claude_oauth's owner/agent flow factoring to codex_oauth | S |
| [runner] Router-level FastAPI dependency for the 20 hand-rolled API-key preambles | S |
| [runner] Unify the ownership/chown helpers (two divergent walkers + 10x idiom) | M |
| [mcp-browser] Deduplicate crawl config, markdown picker, recovery wrappers in server.py | S |
| [infra] Delete dead flaresolverr container + phantom env vars; wire missing OLLAMA vars | S |
| [cross] One shared source of truth for WebSocket event names (3 copies + spec, already drifted) | M |
| [tests] Replace workflow-pipeline.test.ts's 120-line hand-listed database.js mock | S |
| [tooling] Root workspace tooling + frontend typecheck (vite build never runs tsc) | S-M |

## Low-medium impact
| Task | Effort |
|---|---|
| [api] Extract shared MCP response-envelope helpers (jsonOk/jsonError duplicate + ~98 text envelopes) | S |
| [frontend] Factor App.tsx's four copy-pasted guarded lazy loaders | S |

## Suggested sequencing
1. Drift-bug closers first (cheap, fix real behavior): CLI-runner single-source, clearExecutionOnMove, WebSocketContext/useSocketEvent, flaresolverr removal.
2. Hot-path correctness: task-move core, _waitForExecutionComplete, active-task resolution chain.
3. Wide mechanical sweeps: asyncHandler/error middleware, FastAPI auth dependency, compose YAML anchors.
4. Structural splits last (largest diffs): TasksBoard hooks, TaskDetailModal, auth.ts login router, _TuiDriver.
