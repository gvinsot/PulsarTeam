# Misc — health, settings, realtime, leader-tools, contact

Sources: inline routes in `api/src/index.ts`, plus `routes/settings.ts`, `routes/apiKeys.ts`, `routes/realtime.ts`, `routes/leaderTools.ts`, `routes/contact.ts`, `routes/templates.ts`.

---

## 1. Health

### GET `/api/health`
Public liveness probe.
- **Response 200**: `{ status: 'ok', database: 'connected'|'unavailable' }`.

### GET `/api/health/details`
Detailed status. Counts of agents per status, uptime, projects breakdown.
- **Auth**: JWT.

---

## 2. Settings — `/api/settings/general/*`

### GET `/api/settings/general`
Current general settings (currency, defaults).
- **Auth**: JWT.

### PUT `/api/settings/general`
Update general settings.
- **Auth**: JWT + `admin`.

### GET `/api/settings/general/reminders`
Reminder configuration: `intervalMinutes`, `maxReminders`, `cooldownMinutes`.

### PUT `/api/settings/general/reminders`
Update reminder configuration.
- **Auth**: JWT + `admin`.

---

## 3. API keys — `/api/settings/api-key/*`

User-scoped API key for the external Swarm API.

### GET `/api/settings/api-key`
Returns `{ prefix, createdAt }` only (the full key is never re-emitted).
- **Auth**: JWT.

### POST `/api/settings/api-key`
Generate or rotate the user's API key.
- **Response 200**: `{ apiKey, prefix }` — the full `apiKey` is returned once and never again.

### DELETE `/api/settings/api-key`
Revoke the current API key.

---

## 4. Templates — `/api/templates/*`

Read-only agent templates seeded at startup.

### GET `/api/templates`
List all templates.

### GET `/api/templates/:id`
Single template (role, default instructions, recommended plugins, icon, color).

---

## 5. Realtime — `/api/realtime/*`

### POST `/api/realtime/token`
Issue an OpenAI Realtime API ephemeral token for a voice-enabled agent.
- **Body**: `{ agentId }`.
- **Response 200**: `{ token, expiresAt, session, voice, model, transcriptionModel }`.
- **Auth**: JWT.

---

## 6. Leader tools — `/api/leader-tools/*`

Helper endpoints exposed to Swarm Leader agents (and the MCP that wraps them).

| Endpoint | Description |
|---|---|
| `GET /last-messages` | Last N messages of an agent. Query: `agentId|agentName`, `limit` (1–50). |
| `GET /agent-status` | Status by `agentId` or `agentName`. |
| `GET /all-statuses` | Statuses of all accessible agents. Query: `project?`. |
| `GET /swarm-status` | Swarm-wide rollup. |
| `GET /by-project/:project` | Agents on a project. |
| `GET /project-summary` | Project counts. |

---

## 7. Contact — `/api/contact`

### POST `/api/contact`
Public contact form. Rate-limited 5 / hour / IP. Submission becomes a task on the configured Support board.
- **Body**: `{ name, email, phone?, message, type? }`.
- **Response 200**: `{ success: true, message }`.
