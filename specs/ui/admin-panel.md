# UI Spec — Admin Panel modal

Trigger: User menu → **Admin Settings** (visible only to `admin`).
Renders: `frontend/src/components/AdminPanel.tsx`.

---

## 1. Purpose

A modal that exposes all **system-wide administrative actions**. It is admin-gated both in the UI (the trigger button is hidden) and at the API (HTTP 403 for non-admins).

---

## 2. Tabs

### 2.1 Users
- Table of all users: username, display name, role (Admin / Advanced / Basic), last login, online indicator.
- Actions per row:
  - **Edit** — change display name, role, password.
  - **Impersonate** — POST `/api/auth/impersonate/:userId` returns a JWT for the target user. The dashboard then shows an amber banner with a "Stop Impersonation" button.
  - **Delete** — soft-confirms; self-deletion is blocked.
- **Create user** form: username, password, role, display name. On submit, the user is created and their workspace is provisioned (Linux UID allocation, default board, default agent).

### 2.2 Settings
- General system settings: currency for budget display, system-wide defaults, etc.
- Save button → PUT `/api/settings/general`.

### 2.3 Reminders
Configuration for the agent reminder system (the system that nudges idle/forgotten tasks).
- Reminder interval (minutes)
- Maximum reminders per task
- Cooldown between reminders (minutes)
- Save → PUT `/api/settings/general/reminders`.

### 2.4 Reset Instructions
- Dropdown: pick a role (e.g. `Developer`, `Swarm Leaders`).
- Confirm button (inline two-click) → POST `/api/agents/reset-instructions/:role`.
- Effect: every agent with that role has its `instructions` field reset to the template's default.

### 2.5 LLM Configs
- Table of configured LLM providers (Anthropic, OpenAI, Ollama, …).
- Per row: name, provider, model, status indicator, **Edit / Delete / Test** buttons.
- Create form: name, provider, base URL, model, API key, cost per Mtok (in/out), optional headers.
- API keys are stored encrypted and masked in the response for non-admin viewers.

### 2.6 Boards (admin-wide)
- Lists **all boards across all users** (GET `/api/boards/all`).
- Per board: owner, name, agent count, task count, share count.
- Actions: edit, delete (subject to default-board protection).

---

## 3. Common patterns

- **Inline confirmation**: destructive actions ask "Are you sure?" inline with a second click.
- **Audit logging**: all admin actions are recorded server-side (board audit, task audit, user provisioning logs).
- **Optimistic UI**: changes are applied locally, then a refresh is triggered.

---

## 4. Permissions

Every action in this panel requires `admin` role. The panel itself is unreachable for other roles — the trigger is conditional on `user.role === 'admin'`.
