# UI Spec — Projects tab

Route: `#projects`.
Renders: `frontend/src/components/ProjectsView.tsx`, `ProjectDetailModal.tsx`, `ProjectDetailView.tsx`.

---

## 1. Purpose

The Projects tab groups boards under a higher-level entity called a **project** — typically one project per product or one project per git repository. It is also the place to view aggregate **statistics, repos, and storages** linked to the project's tasks.

---

## 2. Project list

A grid (or list, depending on width) of project cards. Each card displays:
- Project name and description
- Number of boards linked
- Number of agents working on this project
- Task counts: total, active, done, waiting
- Bug / feature breakdown (from task types)
- A miniature activity sparkline (daily created/completed over the last 30 days)

A search box filters projects by name client-side.

The **Create project** button (visible to advanced and admin users) opens an inline form with fields:
- Name (required)
- Description
- Rules (free-form instructions injected into every agent assigned to the project)

The project filter in the global header (`Dashboard.tsx`) reads from the same project list. Selecting a project there filters every other tab.

---

## 3. Project detail

Clicking a project card opens `ProjectDetailModal`, which has four sub-views (`ProjectDetailView`):

### 3.1 Overview
- Name, description, rules (read-only display).
- Edit / Delete buttons (admin or project owner only).
- List of **linked boards**: each row shows board name and number of tasks. From here the user can attach/detach a board to/from the project (board admin permission required).

### 3.2 Statistics
Three charts (data fetched via `getProjectTaskStats`, `getProjectTimeSeries`, `getProjectAgentTime`):
- **Task timeline** — 30-day series of tasks created versus completed.
- **Agent time** — pie chart showing time spent per agent on this project's tasks.
- **Daily activity** — bar chart with task creation / completion per day.

A range selector (7 / 30 / 90 / 365 days) controls the lookback window.

### 3.3 Repos
List of GitHub repos referenced by tasks in this project (via `getBoardRepos`).
Each row: `owner/repo`, count of tasks using it, link to the repo on GitHub.

### 3.4 Storages
List of cloud-storage roots referenced by tasks in this project (OneDrive paths or Drive folder ids, via `getBoardStorages`).

---

## 4. Auto-indexing

The project detail view includes an **Index project** action that triggers a background `code-index` pass on the project's source folder (POST `/api/code-index/index-project`). When complete, the code-index MCP can serve symbol and semantic search to agents working on that project.

---

## 5. Real-time updates

This tab is **polling-based**, not socket-driven. Stats refresh:
- When the user switches to the tab.
- When the user changes the date range in the stats view.
- When `onRefresh` is called by the parent (board/agent edits elsewhere).

---

## 6. Permissions

| Action | Required |
|---|---|
| View project list | `basic`+ |
| View project detail | Project read permission (owner or member) |
| Create project | `advanced` or `admin` |
| Edit project | Project owner or `admin` |
| Delete project | Project admin permission (typically owner) |
| Link/unlink board | Project edit + board admin |
| Index project | `basic`+ (validated via REPOS_BASE_DIR allow-list) |
