# UI Spec — Agents tab

Route: `#agents` (default if no hash).
Renders: `frontend/src/components/Dashboard.tsx` (left pane) + `AgentDetail.tsx` (right pane).

---

## 1. Purpose

The Agents tab is the primary interface to **inspect and operate the swarm**. Each agent is a long-lived LLM worker with its own identity, plugins, permissions, and conversation history.

The view is a **split layout**: a list/grid of agent cards on the left, and (when an agent is selected) a detail panel on the right with six sub-tabs.

---

## 2. Header & toolbar

| Element | Behavior |
|---|---|
| Agent count badge | Shows `(filteredCount / totalCount)` when a board filter is active, otherwise total only. |
| Board filter dropdown | Visible only if the user has ≥ 2 boards. Filters the agent list to agents whose `boardId` matches. Selection persists in `localStorage`. |
| View mode toggle | Grid / List. Persists in component state. |
| Add Agent button | Opens `AddAgentModal`. Hidden for `basic` role. |

The header also exposes a **project filter** (in `Dashboard.tsx`) that applies to every tab. When set, only agents whose board belongs to the selected project are shown.

---

## 3. Agent card

Each card displays:
- Agent icon and color (configurable in Settings sub-tab)
- Name, role, project assignment
- Status badge: `idle`, `busy`, `error` (color-coded)
- Live thinking indicator (animated dot) when the agent is reasoning or streaming
- Metric snapshot: total tokens in / out, tasks completed
- Inline **Stop** button when the agent is busy (emits `req:stop` over WS)

Clicking a card selects/deselects the agent and opens the detail panel.

Sort order: agents with role `Swarm Leaders` are pinned to the top of the list.

---

## 4. Agent detail panel — sub-tabs

The detail panel has six tabs. The Settings and Permissions tabs are **hidden** for the `basic` role.

### 4.1 Chat

Direct conversation with the agent.

- Renders the agent's `conversationHistory` plus the live streaming buffer.
- Tool-call syntax (e.g. `@read_file(...)`) is rendered with dedicated chrome via `cleanToolSyntax` and the `ToolResultMessage` / `DelegationResultMessage` components.
- Input area supports text and image attachments (image types accepted, ~10 MB max per file).
- Controls:
  - **Send** — POST to `/api/agents/:id/chat`
  - **Stop** — emits `req:stop` over WebSocket (visible only while busy)
  - **Clear history** — DELETE `/api/agents/:id/history`
  - **Truncate after this message** — DELETE `/api/agents/:id/history/after/:index`
  - **Auto-scroll** toggle — local, pauses auto-scroll when the user scrolls up
- Voice agents: a dedicated `VoiceChatTab` replaces the chat tab for agents that have voice enabled.

### 4.2 Context

Editable system context for the agent.

- **Instructions** — large textarea with a Save button. Maps to `agent.instructions`. On save, calls `updateAgent` and refreshes.
- **RAG documents** — list of attached documents.
  - Add file (paste/upload content) → POST `/api/agents/:id/rag`
  - Add URL → POST `/api/agents/:id/rag/url` (content fetched server-side)
  - Refresh a URL doc → POST `/api/agents/:id/rag/:docId/refresh`
  - Delete → DELETE `/api/agents/:id/rag/:docId`
- **Handoff** — pick a target agent + free-form context, then trigger POST `/api/agents/:id/handoff`. Used to delegate the current in-flight task to a peer agent without losing context.

### 4.3 Plugins

Manages the plugins and MCP integrations attached to the agent.

- Lists the agent's currently assigned plugins, with category icons and a remove button.
- "Available plugins" picker with category filter (coding, devops, writing, security, analysis, general).
- Each plugin can declare per-agent **user config** (e.g. an API key field) — those are editable here and persisted with the agent.
- For OAuth-backed plugins (GitHub, Gmail, Drive, OneDrive, Outlook, Slack), this tab shows a **Connect** button that triggers the OAuth flow in a popup. Once connected, it displays the connected account identifier and a Disconnect button.
- Hardware MCPs (Jira, WordPress, S3) prompt for credentials inline; connection is tested before being stored.

### 4.4 Permissions

Sandbox security gates for what the agent is allowed to do at runtime.

- **Linux user** — read-only display of the Linux UID assigned to the agent; toggle for `runAsRoot` (admin-only on most installs).
- **Network** — toggle for internet access; allow-list of domains.
- **Filesystem** — toggle read/write to the workspace; list of restricted paths.
- **Execution** — toggle shell access; toggle "skip dangerous prompts" (allows the agent to bypass user confirmation prompts in its inner Claude Code shell).

All changes are persisted via `updateAgent`. Some toggles are disabled (read-only) for non-admin users.

### 4.5 Action Logs

A chronological, read-only feed of actions the agent has taken (task started, task completed, command run, file edited, handoff, error report). Includes a **Clear logs** button (DELETE `/api/agents/:id/action-logs`).

### 4.6 Settings

The agent's metadata and identity.

| Field | Notes |
|---|---|
| Name | Free text. |
| Role | Free text or template-derived. |
| Description | Free text. |
| Icon | Lucide icon picker. |
| Color | Color swatch picker. |
| LLM config | Dropdown of LLM configs visible to the user. |
| Project assignment | One project (== one git repo full name) per agent. |
| Board assignment | Which board the agent appears under. |
| Enabled | Toggle. Disabled agents stop receiving tasks. |
| Voice | Toggle. Enables the realtime voice tab. |
| Cost overrides | Optional per-agent token cost overrides (USD per Mtok in/out). |
| **Save** | Calls `updateAgent` and triggers a refresh. |
| **Delete** | Inline two-click confirmation; calls `deleteAgent`. Hidden for `basic`. |

---

## 5. Add Agent modal

Opened by the "Add Agent" button in the toolbar (or the empty state).

- **Step 1 — Choose template**: a searchable grid of templates (`getTemplates`). Each template has a role, default instructions, icon, color, and recommended plugins. Selecting a template pre-fills the form. Users can also choose "Start from scratch".
- **Step 2 — Customize**: editable fields identical to the Settings sub-tab plus an optional **Swarm Leader** toggle.
- **Create** → POST `/api/agents`. On success: closes the modal and selects the newly created agent in the list.

---

## 6. Real-time updates

The Agents tab consumes these WebSocket events (see `socketEvents.ts`):

| Event | Effect |
|---|---|
| `agents:list` | Replace the full agents array. |
| `agent:created` / `agent:updated` / `agent:deleted` | Mutate the agents array. |
| `agent:status` | Update status only (idle/busy/error). |
| `agent:thinking` | Show/clear the thinking indicator. |
| `agent:stream:start` / `agent:stream:chunk` / `agent:stream:end` | Stream the assistant's response into the chat tab. |
| `agent:stream:error` | Display a toast. Long-form errors (context-window, OOM, model errors) are sticky toasts (duration 0). |
| `agent:error:report` | Render the error report as a toast (12 s). |
| `agent:handoff` | Logged client-side; the receiver shows the carried context in its chat. |

---

## 7. Permissions

| Action | Required role |
|---|---|
| View agents | `basic`+ |
| Chat with an agent | Board edit permission on the agent's board |
| Create an agent | `advanced` or `admin` |
| Edit an agent | Board edit permission |
| Delete an agent | Board edit permission, not `basic` |
| Edit permissions | Same as edit; some sub-toggles `admin` only |
| Settings tab visible | Not `basic` |
| Permissions tab visible | Not `basic` |
