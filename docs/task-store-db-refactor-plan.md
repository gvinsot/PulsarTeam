# Refactor: DB as source of truth for tasks (remove the in-memory `_tasks` store)

## Why

`agentManager._tasks: Map<agentId, Task[]>` (api/src/services/agentManager/index.ts) is an
**agent-keyed in-RAM cache** of tasks, loaded at startup via `getTasksByAgent(agent.id)` per
agent. It's a legacy of the old per-agent `agent.todoList`.

A task with **no owner** (`agent_id = NULL` — created unassigned via MCP `add_task`, external
API, contact form) has no agent key → it is in **no** bucket → **every** code path that
resolves a task via `_getAgentTasks(task.agentId)` silently no-ops for it. This single fact is
the root cause of a recurring bug class:
- task never shows "busy" (`_markActionRunning` skipped),
- assignee never set/visible,
- `@update_task` / tool handlers return "Task not found".

Each has been patched locally (board-level branches, `applyTaskUpdate` delegation, the
`_ensureTaskInMemory` rehydration hack). That's whack-a-mole. The fix of record is to make the
**DB authoritative** and treat owned and board-level tasks uniformly.

Mitigation already shipped (reduces but doesn't eliminate the problem): MCP `add_task` now owns
the task to the calling agent (`callerAgentId`), so NEW agent-created tasks are owned. Remaining
exposure: legacy `agent_id=NULL` rows + external-API tasks.

## Target architecture

- The DB row is the single source of truth. Reads go through `getTaskById` (+ a prefix variant)
  and board/assignee/status queries; writes go through `updateTaskFields` (targeted) or a single
  canonical upsert.
- No agent-keyed cache as truth. (An optional short-TTL read cache can come later, behind the
  same accessors — not in scope for correctness.)
- Owned vs board-level stop being different code paths: the "board-level" path
  (`applyBoardLevelUpdate` / `updateTaskFields` + emit) becomes THE path for all tasks.

## What currently depends on `_tasks` (inventory)

Helpers (index.ts): `_getAgentTasks`, `_findTaskAcross`, `_findTaskByIdOrPrefix`, `_getAllTasks`,
`_addTaskToStore`, `_removeTaskFromStore`, `_clearAgentTasks`, `_ensureTaskInMemory`.

Mutators (mutate-in-memory-then-save): `addTask`, `setTaskStatus`, `toggleTask`, `transferTask`,
`setTaskAssignee`, and the workflow path (`executeRunAgent`, `_markActionRunning` + finally,
`_autoAssignByColumn`, `executeAssignAgent`).

Resolvers in tool handlers/routes: `@update_task`, `@move_task_to_board`, status/assignee routes.

Iteration: `recheckPendingTransitions` iterates `agents` → `_getAgentTasks(agentId)` every ~5s.
Load-balancer (`findAgentByRole`/`findAgentForAssignment`) counts tasks via in-memory scan.

Transient state living on the in-memory task object: `completedActionIdx` (also a column),
`_pendingOnEnter` (also `pending_on_enter`), `_decideNoDecisionCount` (NOT persisted — must move).

## Phased plan (each phase independently shippable + testable)

### Phase 1 — DB-backed resolution (LOW risk, HIGH value, fixes the bug class)
Replace `_getAgentTasks(...).find(id)` / `_findTaskByIdOrPrefix` lookups in tool handlers + routes
with a DB-backed resolver (`getTaskById` + a `getTaskByIdPrefix`). Tasks become addressable
regardless of owner. The `@update_task` hotfix (delegate to `applyTaskUpdate` when not in memory)
is the first slice of this phase.
- Add `getTaskByIdPrefix(prefix)` (DB) for the short-id case.
- Route `@move_task_to_board` and any other `_findTaskByIdOrPrefix` callers through it.
- Done when no tool handler/route returns "not found" for a DB-present task.

### Phase 2 — DB-backed mutation
Make `setTaskStatus` / `setTaskAssignee` / completion / actionRunning operate on the DB row
(read-modify-write or `updateTaskFields`) for ALL tasks, then read back + emit. Collapse the
owned vs board-level duplication into one path.
- Relocate `_decideNoDecisionCount` off the task object (persist a column OR a per-taskId
  in-memory Map keyed by id, replica-local — it's a retry counter, fine to lose on restart).
- Preserve the deferred-emit/timestamp contract the frontend relies on (emit carries a fresh
  `updatedAt`; persist-then-emit ordering).

### Phase 3 — DB-backed workflow iteration (HIGHEST risk — do last)
Replace `recheckPendingTransitions`'s in-memory iteration with a DB query: active, non-stopped
tasks on workflow-bearing boards for this environment. Index `(environment, deleted_at, board_id,
status)`. Replace load-balancer in-memory counts with a DB aggregate (count by assignee/owner).
- **Cross-replica coordination (KEY RISK):** the in-memory model implicitly scoped processing
  per replica (each replica only iterated its own buckets + the `environment` filter). A shared
  DB iteration means N replicas race to process the same task. Add a DB advisory lock per task
  (`pg_try_advisory_lock(hashtext(task_id))`) or single-leader election for the workflow tick.
  QA is 1 replica today (latent), but prod may scale — must be designed in before Phase 3 ships.

### Phase 4 — Remove the store
Delete `_tasks` + helpers + `_ensureTaskInMemory` + the startup `getTasksByAgent` load + the
mutate-in-memory patterns. Grep for `_getAgentTasks`/`_tasks` to confirm zero remaining readers.

## Risk register
1. **Cross-replica double-processing** (Phase 3) — needs advisory locks / leader. Biggest.
2. **Perf**: 5s workflow tick now hits DB — needs indexes (above) and possibly a short read cache.
3. **Transient state** not persisted (`_decideNoDecisionCount`) — relocate before deleting store.
4. **Object-identity assumptions**: code mutating the same task object across chain steps must
   switch to re-fetch or explicit row passing.
5. **Frontend stale-merge** (TasksBoard timestamp logic) — revalidate emits + no flicker/revert.
6. **Volume of call sites** — keep each phase behind the centralized resolver/mutator so it's
   shippable and reversible.

## Sequencing recommendation
Ship Phase 1 first (kills the user-visible "not found"/board-level bugs at low risk). Then Phase 2.
Treat Phase 3 as its own milestone gated on the cross-replica design. Phase 4 is cleanup.

## Progress

### Phase 1 — DONE (DB-backed resolution)
- `getTaskByIdPrefix(idOrPrefix)` added (`database/tasks.ts`): exact-PK first, then an
  ambiguity-safe prefix scan (`LEFT(id::text, length($1)) = $1`, capped, >1 → null). Re-exported.
- `AgentManager._resolveTaskRef(idOrPrefix)` (`agentManager/index.ts`): centralized resolver —
  prefers the in-memory copy for owned/cached tasks (keeps `_tasks` consistent during migration),
  falls back to DB for board-level/uncached, rehydrates owned tasks by FULL id.
- Tool handlers `@move_task_to_board` + `@delete_task` route through `_resolveTaskRef` and
  preserve `agent_id = NULL` (no silent ownership claim).
- MCP `update_task` (`swarmApiMcp.locateTask`) now prefix-capable + rehydrates by full id
  (fixes the latent "owned task treated as board-level on prefix" bug).
- `npx tsc --noEmit` clean; 286/286 tests pass.

### Phase 2 — DONE (DB-backed mutation, surgical scope)
Decision: `setTaskStatus`/`setTaskAssignee` stay SYNC (≈30 safety-net tests assert on their sync
return; making them self-resolve board-level tasks would force async + churn the net). Board-level
mutation is handled AT THE CALL SITES where the task object is already in hand:
- `_decideNoDecisionCount` relocated off the task object → `AgentManager._decideNoDecisionCounts:
  Map<taskId,count>` (replica-local, transient). Now accumulates for board-level tasks too (they had
  no in-memory object to hang it on, so the fail-fast guard never tripped). Cleared on
  decided/max/status-change (`setTaskStatus` + `applyBoardLevelUpdate`)/delete; NOT purged against
  in-memory ids (would wrongly wipe board-level counters).
- `executeAssignAgent` + `executeAssignAgentIndividual`: board-level branch persists the assignee via
  a targeted `updateTaskFields` + deferred emit (`persistBoardLevelFields`, mirrors
  `_markActionRunningBoardLevel`). Fixes "assignee non persisté" for board-level tasks.
- `executeChangeStatus`: now async; board-level branch routes through `applyTaskUpdate` (the canonical
  board-level path: DB mutate + emit + column-entry hook), also robust against owned-but-uncached drift.
- `npx tsc --noEmit` clean; 286/286 tests pass.

Deferred to Phase 3/4 (entangle with the in-memory→DB engine swap or churn the test net): full
async unification of `setTaskStatus`/`setTaskAssignee` onto a single DB-backed mutator, and the
decide before/after detection's DB re-fetch for board-level tasks (today it compares in-memory
copies, so a board-level decision reads as "no decision").

### Phase 3 — PENDING (gated). Cross-replica design DECIDED: **per-task `pg_try_advisory_lock(hashtext(task_id))`**.
### Phase 4 — PENDING (remove the store; depends on 1–3).

## Related
- [[board-level-tasks-not-in-memory]] (memory) — the gotcha + the local patches already in place.
