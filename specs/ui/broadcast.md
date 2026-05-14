# UI Spec — Global Broadcast panel

Trigger: the **globe icon** in the dashboard header.
Renders: `frontend/src/components/BroadcastPanel.tsx`.

---

## 1. Purpose

A slide-down panel that lets a user **send a message to every agent at once** and observe their responses concurrently. It doubles as a global authoring surface for **plugins (skills)** and **MCP servers**.

---

## 2. Sub-tabs

The panel has three internal tabs:

### 2.1 Broadcast
- Multi-line message textarea.
- **Send** button → POST `/api/agents/broadcast/all`.
- **Stop all** button → emits `req:stop` for every busy agent.
- Live response feed: one section per agent showing the streamed response (consumes `agent:stream:*` socket events). Responses are scrollable and keep scrolling history until cleared.

### 2.2 Plugins
Global plugin authoring (admin-only authoring; everyone can view).

- Search and category filter (coding / devops / writing / security / analysis / general).
- Plugin list with edit / delete buttons (admin only).
- **Create plugin** opens an editor with:
  - Name, description, category, icon
  - Instructions (markdown, injected when an agent uses the plugin)
  - User-config fields (per-agent variables, e.g. API keys)
  - MCP server bindings (multi-select)
- Two-click inline confirmation pattern for destructive actions.

### 2.3 Actions / MCP explorer
- Lists installed MCP servers with status (connected / disconnected) and tool count.
- Per-server actions: **Test**, **Reconnect**, **Edit** (admin), **Delete** (admin).
- **Create MCP server** opens an editor (admin) for URL, auth mode, scopes, environment variables.

---

## 3. Real-time updates

- Broadcast view subscribes to `broadcast:start`, `broadcast:progress`, `broadcast:complete`, `broadcast:error` socket events to populate the live response feed.
- Plugins / MCP lists are pulled on open and re-fetched after edit/delete actions.

---

## 4. Permissions

| Action | Required |
|---|---|
| Open the panel | `basic`+ |
| Send a broadcast | `advanced` or `admin` |
| Stop other users' agents | `admin` |
| Create / edit / delete a plugin | `admin` |
| Create / edit / delete an MCP server | `admin` |
| Test an MCP server | `basic`+ |
