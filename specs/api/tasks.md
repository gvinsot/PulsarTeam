# Tasks — `/api/tasks/*`

Source: `api/src/routes/tasks.ts`. All routes require JWT. Per-agent task management lives under `/api/agents/:id/tasks` (see [agents.md](agents.md)); this file covers the **global** task router used by the Kanban board for cross-agent, cross-board operations.

---

## 1. Querying

### GET `/api/tasks`
List tasks the caller can see. Scoped to boards the user owns or has been shared.
- **Query**: any of `board_id`, `agent_id`, `status`, `project`, `repo_full_name`.
- **Response 200**: `Task[]` with joined `agentName` and `assigneeName`.

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
Update any subset of: `title, description, column, agentId, type, priority, dueDate, boardId, position, isManual`.
- **Auth**: JWT + task access (board-scoped).
- **Side effects**: writes a row to the task audit log; triggers any workflow transition action attached to the new column.

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

## 3. Admin operations

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
