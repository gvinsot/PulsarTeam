# Boards — `/api/boards/*`

Source: `api/src/routes/boards.ts`. All routes require JWT. Many enforce a per-board share permission (`read`, `edit`, `admin`) in addition to the caller's global role.

---

## 1. Browsing

### GET `/api/boards`
List boards the caller owns or has been shared.
- **Response 200**: `Board[]` with `permission` (`read|edit|admin`) and `isOwner` flag.

### GET `/api/boards/:id`
Single board detail with `permission` and `isOwner`.

### GET `/api/boards/all`
List **every** board across all users.
- **Auth**: JWT + `admin`.

### GET `/api/boards/users`
List all users — used to populate the share autocomplete.

### GET `/api/boards/tasks/by-assignee/:agentId`
Tasks assigned to a given agent across all the agent's boards.

---

## 2. CRUD

### POST `/api/boards`
Create a board.
- **Body**: `{ name, workflow?, filters?, projectId? }`. If `workflow` is omitted, a default workflow is generated.
- **Side effects**: caller becomes owner with `admin` permission; audit-logged.

### PUT `/api/boards/:id`
Update top-level board fields (name, filters, project link).
- **Auth**: board edit. The default board is read-only.

### PUT `/api/boards/:id/workflow`
Replace the workflow (columns + transitions). Increments `workflowVersion`.
- **Auth**: board edit. Default board read-only.

### DELETE `/api/boards/:id`
Delete a board. Owner or admin only. Default board cannot be deleted.

---

## 3. Plugin & MCP auth

### GET `/api/boards/:id/plugins`
Get the plugins linked to the board, plus the MCP authentication configuration.

### PUT `/api/boards/:id/plugins`
Replace the plugin list.
- **Body**: `{ pluginIds: string[] }`.

### POST `/api/boards/:id/plugins/assign`
Add one plugin. Body: `{ pluginId }`.

### POST `/api/boards/:id/plugins/remove`
Remove one plugin. Body: `{ pluginId }`.

### PUT `/api/boards/:id/mcp-auth`
Update the MCP auth config (per-plugin OAuth tokens are scoped to the board).

---

## 4. Sharing

### GET `/api/boards/:id/shares`
List current shares.
- **Auth**: board admin.

### POST `/api/boards/:id/shares`
Share with another user.
- **Auth**: board admin.
- **Body**: `{ userId?, username?, permission: 'read'|'edit'|'admin' }`.
- **Errors**: 400 if trying to share with self or with the owner.

### PUT `/api/boards/:id/shares/:userId`
Change a share's permission level.

### DELETE `/api/boards/:id/shares/:userId`
Revoke a share. The shared user can also call this on themselves to leave the board.

---

## 5. Audit

### GET `/api/boards/:id/audit`
Returns the board's audit log: workflow edits, shares, plugin changes, etc.
- **Auth**: board admin.
