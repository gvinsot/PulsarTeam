# Projects — `/api/projects/*`

Source: `api/src/routes/projects.ts`. All routes require JWT.

A **project** is a logical grouping of one or more boards. Projects are the level at which the UI filters every other tab.

---

## 1. CRUD

### GET `/api/projects`
List projects. Each row is enriched with board count, repo count, storage count.

### GET `/api/projects/:id`
Single project with its boards, repos, and storages.
- **Auth**: project read.

### POST `/api/projects`
Create. Body: `{ name, description?, rules? }`.
- **Auth**: `advanced` or `admin`.

### PUT `/api/projects/:id`
Update. Owner or admin only.

### DELETE `/api/projects/:id`
Delete. Project admin only (typically owner).

---

## 2. Project ↔ board linking

### GET `/api/projects/:id/boards`
Boards attached to the project.

### POST `/api/projects/:id/boards/:boardId`
Link a board.
- **Auth**: project edit + board admin.

### DELETE `/api/projects/:id/boards/:boardId`
Unlink a board.

---

## 3. Repos & storages per board

### GET `/api/projects/boards/:boardId/repos`
Repositories already referenced by tasks on the board.

### GET `/api/projects/boards/:boardId/storages`
Storage roots referenced by tasks.

### GET `/api/projects/available-repos`
Union of repos available to the user across every accessible board.

### GET `/api/projects/boards/:boardId/available-repos`
Repos reachable via the board's GitHub plugin OAuth.

### GET `/api/projects/boards/:boardId/available-storages`
Storage roots reachable via the board's OneDrive plugin OAuth.

---

## 4. GitHub helpers (board-scoped)

These routes proxy GitHub queries using the board's GitHub plugin token, with server-side caching.

| Endpoint | Cache | Description |
|---|---|---|
| `GET /api/projects/github-activity/:owner/:repo` | 1 min | Commits & tags within the last 30 days. |
| `GET /api/projects/github-branches/:owner/:repo` | 15 min | List of branches. |
| `GET /api/projects/github-tree/:owner/:repo/:ref` | 5 min | Recursive file tree of a ref. |
| `GET /api/projects/github-file/:owner/:repo/:ref/*` | 5 min | File content; binary files are flagged. |
