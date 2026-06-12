# Agents — `/api/agents/*`

Source: `api/src/routes/agents.ts`. All routes require JWT.

The agents router exposes agent CRUD, conversation control, **per-agent task management**, RAG documents, and plugin/MCP/skill assignment. Many routes additionally enforce board-level permissions: an agent is reachable only if the caller has at least `read` (for queries) or `edit` (for mutations) on the agent's board.

---

## 1. Agent lifecycle

### GET `/api/agents`
List every agent the caller can see (their own + agents on shared boards + global agents).
- **Response 200**: `Agent[]`.

### GET `/api/agents/:id`
Fetch a single agent. API keys in plugins are masked.
- **Auth**: JWT + board read.

### POST `/api/agents`
Create a new agent.
- **Auth**: JWT, role `advanced` or `admin`.
- **Body**: `{ name, role, model?, llmConfigId?, instructions?, icon?, color?, project?, boardId?, ... }`.
- **Side effects**: `ownerId` set to caller; emits `agent:created` on WS.

### PUT `/api/agents/:id`
Update an agent. Any field is optional.
- **Auth**: JWT + board edit, not `basic`.
- **Side effects**: emits `agent:updated`.

### DELETE `/api/agents/:id`
Delete an agent.
- **Auth**: JWT + board edit, not `basic`.
- **Side effects**: destroys the sandbox, emits `agent:deleted`.

---

## 2. Status & inventory views

### GET `/api/agents/statuses`
Lightweight per-agent status. Includes project + currentTask.
- **Query**: `project?`.

### GET `/api/agents/:id/status`
Status for a single agent.

### GET `/api/agents/by-project/:project`
Agents assigned to a given project.

### GET `/api/agents/project-summary`
All projects with their agent counts and assignments.

### GET `/api/agents/swarm-status`
Aggregated swarm status (counts per status + per project).

### POST `/api/agents/reset-instructions/:role`
Reset instructions for **every** agent in a given role to that role's template default.
- **Auth**: JWT + `admin`.

---

## 3. Conversation

### POST `/api/agents/:id/chat`
Send a message to the agent.
- **Body**: `{ message, images?: [{ name, contentType, dataBase64 }] }`.
- **Response 200**: `{ ok: true }` — the actual reply streams via WebSocket (`agent:stream:*`).
- **Side effects**: queues the prompt on the runner, marks the agent `busy`.

### GET `/api/agents/:id/history`
Full conversation history of the agent.

### DELETE `/api/agents/:id/history`
Wipe history.

### DELETE `/api/agents/:id/history/after/:index`
Truncate history after `index` (exclusive). Used by the "rewind" action in chat.

### DELETE `/api/agents/:id/action-logs`
Clear the agent's structured action logs.

### POST `/api/agents/:id/stop`
Cancel any in-flight execution.

### POST `/api/agents/:id/handoff`
Transfer the agent's current task to another agent with carried context.
- **Body**: `{ targetAgentId, context, taskId? }`.

### POST `/api/agents/broadcast/all`
Broadcast a message to every agent the caller can access.
- **Body**: `{ message }`.
- **Side effects**: emits `broadcast:*` events.

### PUT `/api/agents/project/all`
Bulk-reassign every accessible agent to a given project.
- **Body**: `{ project }`.

---

## 4. Per-agent tasks

These routes manage tasks **scoped to a specific agent**. The global `/api/tasks` router (see [tasks.md](tasks.md)) covers cross-agent and cross-board operations.

### POST `/api/agents/:id/tasks`
Create a task for the agent.
- **Body**: `{ title?, text|description, status?, type?, priority?, boardId?, repoFullName?, storage?, recurrence?, isManual? }`.
- **Response 201**: the created task.

### PATCH `/api/agents/:id/tasks/:taskId`
Update fields of a task.
- **Body**: any subset of `{ status, text, title, repoFullName, storage, recurrence, type, isManual }`.
- **Side effects**: if `status` changes, may stop the agent if it was running this task.

### DELETE `/api/agents/:id/tasks`
Clear all tasks for the agent.

### DELETE `/api/agents/:id/tasks/:taskId`
Delete one task. Returns 409 if the agent is currently executing it.

### POST `/api/agents/:id/tasks/:taskId/transfer`
Transfer a task to another agent.
- **Body**: `{ targetAgentId }`.

### PATCH `/api/agents/:id/tasks/:taskId/assignee`
Set or clear the task's `assigneeAgentId`.
- **Body**: `{ assigneeAgentId | null }`.

### POST `/api/agents/:id/tasks/:taskId/commits`
Link a git commit to a task.
- **Body**: `{ hash, message? }`.

### DELETE `/api/agents/:id/tasks/:taskId/commits/:hash`
Unlink a commit.

### POST `/api/agents/:id/tasks/:taskId/refine`
Synchronous AI refinement: a dedicated agent rewrites the task description.
- **Body**: `{ refineAgentId }`.
- **Response 200**: `{ task }` with refined `description`.

---

## 5. Task analytics (under `/api/agents/tasks/...`)

### GET `/api/agents/tasks/stats`
Task statistics across the swarm (`total`, `active`, `deleted`, `completionRate`).
- **Query**: `project?`.

### GET `/api/agents/tasks/stats/timeseries`
Daily created/completed time series.
- **Query**: `days?` (default 30, max 365).

### GET `/api/agents/tasks/stats/agent-time`
Time spent per agent across the window.

### GET `/api/agents/tasks/:id/history`
Modification history of a single task.

---

## 6. RAG documents

### POST `/api/agents/:id/rag`
Add a static RAG document.
- **Body**: `{ name, content }`.

### POST `/api/agents/:id/rag/url`
Fetch a URL and store it as a RAG document.
- **Body**: `{ url, name? }`.

### POST `/api/agents/:id/rag/:docId/refresh`
Re-fetch the URL of a URL-based RAG doc.

### DELETE `/api/agents/:id/rag/:docId`
Remove the doc.

---

## 7. Plugin / skill / MCP assignment

These routes attach things to an agent.

| Endpoint | Description |
|---|---|
| `POST /api/agents/:id/plugins` | Add a plugin. Body: `{ pluginId, userConfig? }`. |
| `DELETE /api/agents/:id/plugins/:pluginId` | Remove a plugin. |
