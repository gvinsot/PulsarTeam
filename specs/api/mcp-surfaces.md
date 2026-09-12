# Scoped MCP surfaces — `/api/mcp/*`

Sources: `api/src/middleware/apiKeyAuth.ts`, `api/src/services/apiKeyManager.ts`, `api/src/services/mcp/adminMcp.ts`, `api/src/services/mcp/managementMcp.ts`, `api/src/services/mcp/actorScope.ts`, `api/src/routes/apiKeys.ts`.

---

## 1. Why this exists

Before these surfaces, the only key-authenticated MCP endpoint was `/api/swarm/mcp`, and it was guarded by **one API key for the whole instance**:

- `api_keys` held a single row with no `user_id` and no `scope` — "only one active key exists at a time".
- `validateApiKey(key)` returned a **boolean**. Nothing was attached to `req.user`.
- Consequently `routes/swarmApi.ts` and `services/swarmApiMcp.ts` never read `req.user` — the tools ran with **no tenant at all**, so whoever held the key enumerated every board, agent and task on the instance.
- The key was admin-managed and shared, so revoking one integration's access revoked everybody's, and nothing was traceable to a person.

`/api/mcp/admin` and `/api/mcp/management` replace that with keys that **name an owner** and **name a tool set**.

---

## 2. API keys

`api_keys` now holds two kinds of row (migration `202609010001_api_keys_user_scope`).

| | `user_id` | `scope` | Accepted on | Managed from |
|---|---|---|---|---|
| **Legacy** | `NULL` | `NULL` | `/api/swarm/*` only | `GET`/`POST`/`DELETE /api/settings/api-key`, `GET`/`DELETE /api/settings/api-key/legacy` (admin) |
| **Scoped** | set | `admin` \| `management` | `/api/mcp/*` only | `GET`/`POST /api/settings/api-key/mine`, `DELETE /api/settings/api-key/mine/:id` (any user, own keys only) |

Both are stored as `HMAC-SHA256(key, server_secret)`; the plaintext is returned exactly once, at mint time.

### The two directions are deliberate

- **A legacy key is refused on `/api/mcp/*`.** It names nobody, so there is no tenant to run the tools in. Accepting it "for compatibility" would reinstate the very unscoped access these surfaces replace.
- **A scoped key is refused on `/api/swarm/*`.** That surface runs unscoped by design, so honouring a `management` key there would hand its holder the whole instance — the key would escape its own scope.

Existing integrations therefore keep working, unchanged, and gain nothing new.

### One row per `(user, scope)`

Minting a scope you already hold **rotates** it: the previous key for that pair stops working immediately. Rotating or revoking the legacy key never touches anybody's scoped keys, and vice versa — each `DELETE` is narrowed by its owner predicate.

### Scope ladder

`admin` > `management`, one way only.

| Key scope | `/api/mcp/management` | `/api/mcp/admin` |
|---|---|---|
| `management` | ✅ | ❌ `403` |
| `admin` | ✅ | ✅ |

### Claims are read live, never baked into the key

The key carries an **owner id and nothing else**. `requireApiKeyScope` re-reads that user row from the database on every request and publishes it as `req.user` (`{ userId, username, role, csrf: '' }` — the same shape `authenticateToken` publishes). A demotion or a deletion therefore restricts every key that user holds **on its very next request**, not at the next rotation.

`last_used_at` is stamped for accepted keys only, best-effort and never awaited — a write failure must not fail an authentication.

### Responses

| Situation | Status |
|---|---|
| Missing or non-`Bearer` `Authorization` | `401` |
| Unknown key | `403 { error: 'Invalid API key' }` |
| Legacy key on a scoped endpoint | `403` — "requires a scoped API key" |
| Scope below the rung the mount demands | `403` — `scope "management" does not grant "admin"` |
| Owner deleted | `403` — "API key owner no longer exists" |
| Database unreachable | `503` — never falls open |

---

## 3. `POST /api/mcp/management` — scope `management`

Streamable-HTTP MCP. Everything here is about **tasks**: a key handed to a planning bot, a chat integration or a cron can file, move, delegate and close work without also being able to reshape the instance that runs it.

| Tool | Notes |
|---|---|
| `list_boards` | Own + shared boards, with columns and repos in use. |
| `list_agents` | Agents visible to the owner, `project` / `status` filters. |
| `list_tasks` | Tasks on reachable boards; optional `board_id`, `status`, `limit`. |
| `get_task` | One task plus its history. Read-level. |
| `create_task` | `board_id` mandatory; requires **edit** on it. Created unassigned. Supports title, description, priority, due_date, task_type and is_manual. |
| `delegate_task` | Assign to an agent. **Both** the task and the agent must be reachable at edit level. |
| `update_task` | Metadata (title, description, priority, due_date, task_type, is_manual), status / repo / storage and/or completion (`comment`, `commits`, `done`). |
| `delete_task` | Soft delete. Refuses a task a busy agent is executing, exactly as `DELETE /api/tasks/:id` does. |
| `restore_task` | Requires the **admin role** on the key owner, mirroring `POST /api/tasks/:id/restore`. |
| `search_tasks` | Bound to the owner's boards in SQL; naming another tenant's board answers "not found". |

Additional execution and recurrence tools:

| Tool | Contract |
|---|---|
| `start_task`, `resume_task` | `task_id`, optional `agent_id`, optional `status` (column label or id). Executor defaults to assignee then owner. Both task and executor require edit access. Returns `accepted: true`; inspect `get_task` for progress. |
| `stop_task` | Stops one task, persists its stopped state and interrupts its live CLI/native executor. Does not invoke the leader's global stop. A stale assignment cannot interrupt an agent reserved for another task. |
| `set_task_recurrence` | `task_id` + `recurrence`. Creates a rule from a task or updates its existing rule. The task remains its first run. `enabled:false` removes the rule, preserving runs. |
| `list_task_templates` | Optional `board_id`; lists accessible rules with their schedule and next run. |
| `get_task_template` | Reads one rule, schedule, occurrence counter and unfinished-run count. |
| `update_task_template` | Partial title / description / recurrence update; omitted schedule fields and the schedule clock are preserved. |
| `delete_task_template` | Deletes the rule only; existing executions and history remain. |
| `run_task_template` | Spawns an extra execution and triggers its board workflow, without postponing the next automatic run. This explicit request may overlap existing runs. |
| `list_task_template_runs` | Lists accessible executions of a rule; `limit` defaults to 50, maximum 200. |

Execution is asynchronous. An explicit start/resume dispatches the task directly to the selected agent, without also firing the column's on-entry chain. The column must be active: explicit `status`, otherwise current/pre-error column, otherwise the first active column. Completed tasks, disabled agents and reserved agents/tasks are refused. Start from an unassigned task requires `agent_id` or a prior `delegate_task`. A stopped task stays stopped until resumed.

Task results include deadlines, execution status, errors, executor id, commits and recurrence linkage. `due_date` accepts an ISO date or a timestamp with timezone; `null` clears it. Priorities are `low`, `medium`, `high`, `urgent`, or `null`. Task metadata edits preserve omitted fields. `project` on creation is a legacy consistency check against the board's project, never a separate stored task tag.

A recurrence object exposes `enabled`, `period`, `intervalMinutes` (1–525600), `originalStatus`, `historyRetentionDays` (0–3650 or null), `keepLastOccurrences` (0–1000 or null), and `onOverlap` (`skip` or `spawn`). The interval determines cadence. Retention 0/null means unlimited. `originalStatus` must name an existing board column. Use the dedicated rule tools to inspect or edit schedules; ordinary task lists exclude rules.

No agent, board, project or workflow mutation is exposed here.

---

## 4. `POST /api/mcp/admin` — scope `admin`

### `admin` names a TOOL SET, not a ROLE

This is the property to keep in mind. An `admin`-scoped key lets its owner reach the tools that shape the instance, but **every one of them is still bounded by what that owner could already administer through the UI**. Minting an admin key never widens anybody's reach; it only changes the door they come in through.

The genuinely instance-wide tools check `role === 'admin'` on the owner — re-read live — and refuse otherwise. Today that is `list_users`.

| Group | Tools |
|---|---|
| Agents | `get_agent`, `create_agent`, `update_agent`, `delete_agent`, `attach_tools_to_agent` |
| Catalogues | `list_plugins`, `list_mcp_servers`, `list_agent_skills` |
| Projects | `list_projects`, `create_project`, `update_project`, `delete_project` |
| Boards | `get_board`, `list_boards`, `create_board`, `update_board`, `delete_board`, `set_board_workflow` |
| Shares | `list_board_shares`, `share_board` |
| Users | `list_users` — **admin role required** |

`get_agent` returns stored editable configuration including instructions, permissions, runner, LLM configuration reference, limits, tool hooks, documents and voice settings. `effectiveLlm` shows resolved model/provider/limits and capabilities. Secrets remain write-only: `configuredSecrets` reports their presence/names, while API keys, credential values, OAuth configuration and runner session data are excluded. Omit secret fields on update to preserve them.

`get_board` and admin board responses include the full `workflow` (columns, transition actions and conditions, version), plugins and filters, excluding credentials. Read it before editing. `set_board_workflow` takes a full column list; omitting `transitions` preserves the existing rules, while `[]` explicitly removes them. Column renames migrate existing task statuses through the same helper as REST.

MCP `tools/list` exposes the REST agent create/update schemas directly, plus explicit column, action, condition and recurrence schemas. Actions are discriminated by `type`: `run_agent`, `assign_agent`, `assign_agent_individual`, `change_status`. Unknown action types, invalid modes, malformed deadlines and invalid recurrence intervals fail before execution.

Role gates carried over verbatim from the REST routes:

- `basic` cannot create, modify or delete agents (`POST`/`PUT`/`DELETE /api/agents`).
- `create_project` / `update_project` / `delete_project` require `advanced` or `admin` (`requireRole('admin','advanced')`).
- `create_agent` sets `ownerId` to the **key owner**; an admin key cannot mint an agent for somebody else.
- `update_agent` only honours an `ownerId` change for a real admin, and moving an agent to another board requires **edit on the destination** too.

---

## 5. How authorization is decided

Neither surface implements an access rule. `services/mcp/actorScope.ts` calls the same helpers the REST routes call:

| Resource | Helper | Same one used by |
|---|---|---|
| Board | `checkBoardAccess` | `middleware/authz.ts`, `routes/boards.ts` |
| Project | `checkProjectAccess` | `middleware/authz.ts`, `routes/projects.ts` |
| Agent | `checkAgentAccess` | `lib/agentAccess.ts`, `routes/agents.ts` |
| Task | board-then-owner, mirroring `requireTaskAccess` | `routes/tasks.ts` |

Mutations go through the same application functions too — `createAgentSchema`, `updateAgentSchema`, `agentManager.create/update/delete`, `normalizeWorkflowColumnIds`, `applyTaskUpdate`, `agentManager.addTask/deleteTask/restoreTask`. Execution, stop and column-rename operations reuse the application services. MCP-specific projections and schemas are tested over the actual MCP protocol, including write/read round trips.

### "Not found", never "forbidden"

A `403` on a resource you may not touch **confirms it exists**. On a machine-driven surface reached with a key, that is an enumeration oracle: guess ids, keep the ones that answer "denied". Every out-of-scope answer on these surfaces is therefore collapsed into the same `"<Resource> not found"` a nonexistent id gets.

### Listings are the owner's own scope, even for an admin

`list_boards` on both surfaces is `getBoardsByUser(ownerId)` — exactly what `GET /api/boards` returns, and deliberately **not** widened when the owner is an admin. The instance-wide listing is a separate, explicitly admin-only REST route; an API key must not quietly turn one into the other.

---

## 6. Client configuration

```json
{
  "mcpServers": {
    "pulsar-management": {
      "url": "https://<your-host>/api/mcp/management",
      "headers": { "Authorization": "Bearer <your-management-key>" }
    },
    "pulsar-admin": {
      "url": "https://<your-host>/api/mcp/admin",
      "headers": { "Authorization": "Bearer <your-admin-key>" }
    }
  }
}
```

Keys are minted from the UI's **MCP API Keys** modal, which also warns — with a banner — whenever a legacy instance-wide key is still outstanding, and offers to retire it.

---

## 7. Tests

| File | Covers |
|---|---|
| `api/src/services/__tests__/apiKeyManager.test.ts` | HMAC storage, timing-safe validation, the legacy/scoped split, rotation, cross-user revoke |
| `api/src/services/__tests__/apiKeyScopeMiddleware.test.ts` | The scope ladder, legacy refusal, live demotion/deletion, 401 vs 403 vs 503, guard naming |
| `api/src/services/__tests__/scopedMcpSurfaces.test.ts` | Cross-tenant read / write / delegate / search on both surfaces, "not found" wording, role-gated tools, the exact tool list of each surface |
| `api/src/services/__tests__/routeInventory.test.ts` | That both mounts carry `requireApiKeyScope(<scope>)` and cannot be silently downgraded |
| `api/src/services/__tests__/mcpOperations.test.ts` | MCP discovery/schema validation, complete configuration without secrets, workflow round trips and task migration, metadata persistence, explicit execution/stop/resume, recurrence lifecycle and cross-tenant denials. |
