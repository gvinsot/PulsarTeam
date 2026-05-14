# UI Spec — Workflows tab

Route: `#tasks` (the default tab).
Renders: `frontend/src/components/TasksBoard.tsx` and components under `frontend/src/components/tasks/`.

---

## 1. Purpose

The Workflows tab is the **Kanban interface** for managing tasks across all the user's boards. Each board has its own customizable workflow (columns + transitions), its own permissions (share model), and its own set of OAuth-connected plugins.

A task is the unit of work an agent executes; tasks move between columns either by user drag-and-drop or by workflow transitions (some transitions trigger an agent automatically).

---

## 2. Layout

The tab is split into:

1. **Board tabs** (top) — one tab per board the user owns or has been shared. The default board is pinned and undeletable. A `+` button creates a new board.
2. **Board toolbar** — search, filters (repo, agent), sort, create-task, deleted-tasks, workflow editor, share button.
3. **Kanban columns** — one column per workflow state. Cards are draggable within and across columns.

---

## 3. Board tabs and creation

- Each tab shows the board name, optionally an indicator of the user's share permission level (read / edit / admin) when the board is shared from another user.
- Plus button opens a board creation form: name, optional starting workflow (defaults to a stock 4-column flow: Backlog / In Progress / Review / Done).
- Board context menu (`...`):
  - **Share** — opens `ShareBoardModal` (admin permission only).
  - **Workflow editor** — opens `WorkflowEditor` (edit permission).
  - **Plugins** — opens the `BoardPluginsTab` (edit permission).
  - **Delete** — confirms then DELETE. Hidden for the default board and for non-owners.

Switching tabs persists the active board id in `localStorage`.

---

## 4. Toolbar

| Control | Behavior |
|---|---|
| Search box | Filters task cards by case-insensitive substring on title and description. |
| Repo filter | Shows tasks whose `repoFullName` matches. Repos come from `getAvailableRepos` (union of board GitHub plugin + tasks). |
| Agent filter | Shows tasks whose `agentId` or `assigneeAgentId` matches. |
| Sort dropdown | `manual` (default — respects `position` field), `alphabetical`, `created`, `updated`, `status`. |
| Create task button | Opens `CreateTaskModal`. |
| Deleted tasks button | Opens `DeletedTasksPanel`. Admin sees all deleted tasks; users see their soft-deleted ones. |
| Workflow editor button | Opens `WorkflowEditor`. |
| Plugins (board) button | Opens `BoardPluginsTab`. |
| Share button | Opens `ShareBoardModal`. |

---

## 5. Kanban columns

Each column corresponds to a `workflow.column` entry on the board. The column header shows:
- Column name
- Count of cards
- Optional transition badges (e.g. "auto-run agent on entry")
- `+` shortcut to create a task pre-set to that column

Cards are sorted by `position` ascending within a column. Drag-and-drop:
- Within a column → updates `position` for the affected cards (PUT `/api/tasks/reorder`).
- Across columns → updates `status` (PUT `/api/tasks/:id`) and may trigger the workflow transition's action (e.g. assign an agent, run a command).
- Bulk-move (multi-select) → POST `/api/tasks/bulk-move`.

---

## 6. Task card

A card displays:
- Task type icon (feature / bug / chore / question)
- Title
- Truncated description preview
- Priority chip (if set)
- Assignee agent avatar + name (clickable → opens agent detail in Agents tab)
- Repository badge (`owner/repo`) and/or storage badge (`/Drive/path`)
- Recurrence icon if set
- Commit count badge (links to commit modal)
- Status indicator (running / stopped / error)

Clicking a card opens `TaskDetailModal`.

---

## 7. Task detail modal

Modal with two main areas:

### 7.1 Header
- Editable title (saved on blur)
- Status dropdown (with available transitions according to workflow)
- Assignee dropdown (agents visible on the board)
- Delete button (soft-delete; restorable from deleted panel for 90 days by default)
- Stop button (cancels a running execution; PUT `/api/agents/:agentId/tasks/:taskId` or POST `/api/tasks/:id/stop` as fallback)
- Resume / Clear-stopped action when the task is in `error` or `stopped` state
- Refine button (sends the task to a dedicated refining agent and rewrites the description)

### 7.2 Body
- **Description / instructions** — editable markdown.
- **Type** — feature / bug / chore / question.
- **Priority** — low / medium / high / urgent.
- **Due date** — optional date picker.
- **Repository** — picker of repos accessible via the board's GitHub plugin (`getBoardAvailableRepos`).
- **Storage** — picker of OneDrive/Drive roots accessible via the board's OneDrive plugin (`getBoardAvailableStorages`).
- **Recurrence** — cron expression and recurrence rules.
- **Manual flag** — when set, the workflow will not auto-route this task.
- **Transfer to another agent** — POST `/api/agents/:id/tasks/:taskId/transfer`.
- **Commits panel** — list of linked commit hashes. Each commit row opens `AllCommitsDiffModal` to display the diff fetched via `GET /api/tasks/:id/commits/:hash/diff`.
- **History panel** — modification history (`GET /api/tasks/:id/history` and `ExecutionLogEntry` items rendered inline).
- **GitHub activity** — opens `GitHubActivityModal` to show repo commits and tags in the 30-day window.

---

## 8. Workflow editor

A modal that lets a user with edit permission rebuild the board's workflow.

- Add / rename / delete columns.
- Drag to reorder.
- Per-column configuration:
  - **On-entry action** — pick an agent (by name or role) and supply instructions; on transition, a task is automatically queued on that agent.
  - **Display options** — color, icon.
- Save → PUT `/api/boards/:id/workflow` (increments the workflow version).

The default board's workflow is read-only.

---

## 9. Board plugins tab

OAuth and credential management scoped to the active board. Plugins set up here are available to **every agent on the board** without per-agent OAuth.

For each supported integration (GitHub, OneDrive, Gmail, Outlook, Drive, Slack, Jira, WordPress, S3):
- Status indicator: connected / not connected, plus the connected identity (username, email, …).
- Connect / Disconnect actions.
- Test connection action.

---

## 10. Share board modal

Visible only with **admin** permission on the board (typically the owner).

- Lists current shares: user + permission level + revoke button.
- Add a share: pick a user by username, choose permission level (read / edit / admin).
- Self-share and owner-share are blocked.
- All actions are recorded in the board's audit log.

---

## 11. Deleted tasks panel

A side panel listing soft-deleted tasks. Each row shows the title, when it was deleted, who deleted it, and offers:
- **Restore** (admin-only on most installs) → POST `/api/tasks/:id/restore`.
- **Permanently delete** (admin) → DELETE `/api/tasks/:id/permanent`.

An admin **Purge** action removes all tasks older than N days (default 90). Audit-logged.

---

## 12. Real-time updates

The board listens for these WebSocket events:

| Event | Effect |
|---|---|
| `task:created` / `task:updated` / `task:deleted` | Mutate the task list and re-render Kanban. |
| `task:moved` | Re-place the card without reload. |
| `agent:updated` | Used to update assignee avatars and the running indicator on cards. |
| `board:updated` | Apply workflow or sharing changes to the active board. |

Long-running agent executions also surface live status on the card (e.g. running spinner) via `agent:status` events.

---

## 13. Permissions

| Action | Required |
|---|---|
| View board | Owner or any share level |
| View tasks | Same |
| Create a task | Edit or admin share |
| Edit / move / delete a task | Edit or admin share |
| Edit workflow | Edit or admin share |
| Configure board plugins | Edit or admin share |
| Share board / change shares | Admin share |
| Delete board | Owner (with admin) |
| Restore / permanently delete a task | Admin role (system) |
| Purge tasks | Admin role (system) |
