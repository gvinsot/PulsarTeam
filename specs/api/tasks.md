# Tasks — `/api/tasks/*`

Source: `api/src/routes/tasks.ts`. All routes require JWT. Per-agent task management lives under `/api/agents/:id/tasks` (see [agents.md](agents.md)); this file covers the **global** task router used by the Kanban board for cross-agent, cross-board operations.

---

## 1. Querying

### GET `/api/tasks`
List tasks the caller can see. Scoped to boards the user owns or has been shared.
- **Query**: any of `board_id`, `agent_id`, `status`, `project`, `repo_full_name`.
- **Response 200**: `Task[]` with joined `agentName` and `assigneeName`.
- **Never returns recurring rules** (`is_template`) — see §4.

### GET `/api/tasks/:id/history`
Modification history of a task (each entry shows previous → next values, author, timestamp).
- **Auth**: JWT + access to the task's board.

### GET `/api/tasks/:id/commits/:hash/diff`
Fetch the diff of a commit linked to the task, via the board's GitHub plugin OAuth.
- **Response 200**: `{ commit, files: [{ filename, additions, deletions, patch }] }`.
- **Errors**: 404 if the board has no GitHub plugin or the repo is unknown.

### GET `/api/tasks/project-stats`
Per-project task stats aggregated across the user's boards.
- **Query**: `days?` (default 30).
- **Response 200**: `[{ project, total, done, active, waiting, bugs, features, dailyCreated, dailyCompleted }]`.

### GET `/api/tasks/stats`
Compact task stats: total, active, deleted, 30-day deletion rate.

---

## 2. Mutation

### PUT `/api/tasks/reorder`
Bulk-reorder tasks in a column.
- **Auth**: JWT + board edit.
- **Body**: `{ boardId, status, tasks: [{ id, position }] }`.
- **Side effects**: updates positions in DB and in-memory state.

### PUT `/api/tasks/:id`
Update any subset of: `title, description, column, agentId, type, priority, dueDate, boardId, position, isManual, recurrence`.
- **Auth**: JWT + task access (board-scoped).
- **Side effects**: writes a row to the task audit log; triggers any workflow transition action attached to the new column.
- `recurrence` is **not** stored on the task: `{ enabled: true, … }` creates (or edits) the recurring rule this card belongs to and links the card as its run #1; `{ enabled: false }` deletes the rule and keeps the runs. See §4.

### POST `/api/tasks/bulk-move`
Move many tasks at once between boards/columns.
- **Body**: `{ taskIds: string[], boardId, column }`.
- **Side effects**: audit-logged; may trigger auto-refine on each task.

### POST `/api/tasks/:id/stop`
Task-level stop. Clears the `actionRunning*` fields even if the executor agent has been recycled or no longer exists. Used as a fallback when the agent-level stop button does nothing (see commit `cf9d3a2`).

### PATCH `/api/tasks/:id/clear-stopped`
Clear the `executionStatus = stopped` flag and reset the circuit breaker so the task is eligible for execution again. If the task was in `error`, it is set back to `active`.

### DELETE `/api/tasks/:id`
Soft-delete a task. Returns 409 if the agent is currently executing it.
- **Side effects**: sets `deleted_at`, `deleted_by`. Audit-logged.

---

## 3. Recurring rules

A recurring task is **two** things: a *rule* (a `tasks` row with `is_template`, carrying the schedule in `recurrence`) and the *runs* it spawns (ordinary tasks with `template_id` + `occurrence_seq`). The rule never appears on a board, is never executed, and is filtered out of every other task query; each due date spawns a fresh run with an empty history, and finished runs are deleted by the rule's own retention settings.

This replaced resetting one row in place, which grew that row's history, commits and audit trail without bound and could yank back a run still in flight.

Schedule fields (`recurrence`): `period`, `intervalMinutes`, `originalStatus` (the column runs start in), `onOverlap` (`skip` — the default — or `spawn`), `historyRetentionDays` (delete finished runs older than N days), `keepLastOccurrences` (keep only the N most recent finished runs). `lastResetAt`, `occurrenceCount` and `lastOccurrenceId` are maintained server-side.

### GET `/api/tasks/templates`
List recurring rules.
- **Query**: `board_id?` — without it, every rule on a board the caller can see.
- **Response 200**: rules with `nextRunAt`, `unfinishedRuns` and the 5 most `recentRuns`.

### GET `/api/tasks/templates/:id/runs`
The runs a rule has spawned, newest first.
- **Query**: `limit?` (default 50, max 200).

### PUT `/api/tasks/templates/:id`
Edit a rule: `{ title?, description?, recurrence? }`. Omitted schedule fields keep their current value, so a partial edit cannot rewind the clock or reset the retention. `recurrence: { enabled: false }` deletes the rule and answers `{ ok: true, deleted: true }`.

### POST `/api/tasks/templates/:id/run`
Start one extra run now, **without** moving the schedule.
- **Response 200**: the created task.

### DELETE `/api/tasks/templates/:id`
Stop the rule. The runs it already spawned are kept.

---

## 4. Admin operations

### GET `/api/tasks/deleted`
List soft-deleted tasks.
- **Auth**: JWT + `admin`.

### POST `/api/tasks/:id/restore`
Restore a soft-deleted task.
- **Auth**: JWT + `admin`.

### DELETE `/api/tasks/:id/permanent`
Hard-delete (irreversible).
- **Auth**: JWT + `admin`.

### GET `/api/tasks/audit`
Paginated task audit log.
- **Auth**: JWT + `admin`.
- **Query**: `limit?` (1–200), `offset?`.

### POST `/api/tasks/purge`
Hard-delete tasks soft-deleted more than N days ago.
- **Auth**: JWT + `admin`.
- **Body**: `{ days?: number }` (default 90).
- **Side effects**: audit-logged.
