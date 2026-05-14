# PulsarTeam — Functional Specifications

This folder contains the functional specifications of the PulsarTeam platform, reverse-engineered from the source code. It describes **what the product does** (behavior visible to a user or API consumer), not **how it is implemented**.

These specs are intended for:
- Product owners who need to validate scope
- New engineers who need to ramp up on the feature surface
- QA engineers who need a reference for end-to-end test coverage
- Integrators who need to consume the public HTTP API

---

## 1. Product overview

PulsarTeam is a multi-tenant platform that lets users orchestrate a **swarm of LLM-powered agents** that collaborate on tasks. Each agent runs Claude Code (or a compatible LLM runner) inside an isolated Linux user sandbox, with its own filesystem workspace, plugins, MCP servers, and conversation history.

The product is structured around four core concepts:

| Concept | Description |
|---|---|
| **Agent** | A persistent LLM worker with a role, an instruction set, a project assignment, and a queue of tasks. |
| **Task** | A unit of work assigned to an agent, living on a Kanban board column. Tasks can recur, be transferred between agents, and link to git commits. |
| **Board** | A Kanban workspace with a customizable workflow (columns + transitions). Boards can be shared with other users with read/edit/admin permissions. |
| **Project** | A logical grouping of boards (typically one project per product or one project per git repository). |

Auxiliary domains: plugins (skills), MCP servers, OAuth integrations (GitHub, Gmail, Drive, OneDrive, Outlook, Slack, Jira, WordPress, S3), LLM configurations, budgets/billing, code indexing, voice (OpenAI Realtime), and an external Swarm API for programmatic access.

---

## 2. High-level architecture

```
┌──────────────┐      WS + HTTPS      ┌─────────────────┐
│  Browser     │ ◄────────────────►   │   API service   │
│  (React/Vite)│                       │   (Node/Express)│
└──────────────┘                       └────────┬────────┘
                                                │
                          PostgreSQL ◄──────────┤
                                                │
                          MCP servers ◄─────────┤
                          (Gmail, Drive, ...)   │
                                                │
                          Runner service ◄──────┘
                          (claudecode-service:8000)
                                  │
                                  ▼
                          Linux user sandboxes
                          (one UID per agent)
```

- **Frontend**: React 18 + Vite + Tailwind. Single SPA, WebSocket-driven for live updates.
- **API**: Node.js + Express. JWT auth (cookie or Bearer). PostgreSQL for persistence. Socket.IO for push.
- **Runner service**: separate HTTP service that spawns Claude Code instances as dedicated Linux UIDs (see `runner-service/` and `docs/architecture.md`).
- **MCP**: Each integration (Gmail, GitHub, …) exposes a JSON-RPC MCP endpoint on the API and a TypeScript service. Agents reach them via the MCP manager.

---

## 3. User roles

| Role | Capabilities |
|---|---|
| **basic** | Read-only on most surfaces. Cannot create or modify agents, plugins, MCP servers, projects. Can chat with agents they have access to. |
| **advanced** | Can create/edit/delete agents, projects, agent skills, boards. Cannot manage users, LLM configs, MCP servers, plugins, or system settings. |
| **admin** | Full access. Includes user management, plugin/MCP authoring, system settings, board administration across all users, impersonation, audit-log viewing, hard-delete of tasks. |

Permission gates are enforced both in the UI (hidden controls) and at the API level (HTTP 403). Some operations (e.g. board editing) are additionally gated by **per-board share permissions** (read / edit / admin), independent of the global role.

---

## 4. Specs index

### UI tabs and major surfaces

Each top-level tab of the dashboard has its own functional spec.

- [ui/agents.md](ui/agents.md) — Agents tab and agent detail (Chat / Context / Plugins / Permissions / Action Logs / Settings)
- [ui/workflows.md](ui/workflows.md) — Workflows tab (Kanban tasks board, workflow editor, board sharing)
- [ui/projects.md](ui/projects.md) — Projects tab (project list, project detail, stats, repos, storages)
- [ui/budget.md](ui/budget.md) — Budget tab (token spend, daily budget, alerts, per-agent breakdown)
- [ui/broadcast.md](ui/broadcast.md) — Global broadcast panel (message all agents, plugin & MCP management)
- [ui/admin-panel.md](ui/admin-panel.md) — Admin panel modal (users, settings, reminders, LLM configs, boards, reset instructions)
- [ui/login-and-onboarding.md](ui/login-and-onboarding.md) — Login page, OAuth flows, terms acceptance, tutorial modal
- [ui/header-and-shared.md](ui/header-and-shared.md) — Header bar, project filter, user menu, API-key modal, toasts, voice indicator

### Backend HTTP API

Endpoints are grouped by domain. Each file lists method + path, auth model, request shape, response shape, and notable side effects.

- [api/README.md](api/README.md) — API conventions: auth, errors, pagination, rate limits, real-time channel
- [api/auth.md](api/auth.md) — `/api/auth/*` (login, OAuth, impersonation, terms)
- [api/users.md](api/users.md) — `/api/users/*` (admin only)
- [api/agents.md](api/agents.md) — `/api/agents/*` (agent CRUD, chat, history, handoff, per-agent tasks, RAG docs)
- [api/tasks.md](api/tasks.md) — `/api/tasks/*` (global task router, reorder, bulk-move, audit, purge)
- [api/boards.md](api/boards.md) — `/api/boards/*` (boards, workflow, shares, plugins, audit)
- [api/projects.md](api/projects.md) — `/api/projects/*` (projects, board linking, GitHub helpers)
- [api/plugins-and-mcp.md](api/plugins-and-mcp.md) — `/api/plugins/*`, `/api/agent-skills/*`, `/api/mcp-servers/*`
- [api/integrations.md](api/integrations.md) — `/api/{github,gmail,gdrive,onedrive,outlook,slack,jira,wordpress,s3}/*` (status, OAuth, MCP endpoints)
- [api/budget-and-llm.md](api/budget-and-llm.md) — `/api/budget/*`, `/api/llm-configs/*`
- [api/swarm-and-internal.md](api/swarm-and-internal.md) — `/api/swarm/*` (external API-key API), `/api/internal/*`
- [api/code-index.md](api/code-index.md) — `/api/code-index/*` (symbol & semantic search)
- [api/misc.md](api/misc.md) — `/api/health`, `/api/settings/*`, `/api/realtime`, `/api/leader-tools`, `/api/contact`

### Cross-cutting

- [websocket-events.md](websocket-events.md) — Socket.IO events pushed by the server and accepted from clients

---

## 5. How these specs are written

- **Source of truth** is the source code at the time of writing (commit `5ed20a1` on `main`, 2026-05-14). If the code and the spec disagree, the code wins — please open a PR to update the spec.
- The format is intentionally compact. One short paragraph per feature, bullet lists for actions and fields. Implementation details (file paths, SQL queries) are omitted unless the behavior cannot be described without them.
- "Future work" or "TODO" items are **not** in scope here. These specs describe shipped behavior only.

---

## 6. Glossary

| Term | Meaning |
|---|---|
| Swarm | The set of all agents managed by an installation. |
| Swarm Leader | An agent with the `Swarm Leaders` role — typically a coordinator that delegates to other agents. |
| Handoff | Programmatic transfer of an in-flight task from one agent to another, with carried-over context. |
| Plugin (a.k.a. Skill) | A reusable bundle of instructions + MCP server bindings that can be attached to an agent. |
| MCP server | A Model Context Protocol JSON-RPC endpoint that exposes tools to agents. |
| Sandbox | The Linux user environment in which a runner executes the agent's shell commands. |
| Workflow | The ordered set of columns and transitions defined on a board. |
| Refinement | An AI pass that rewrites a task description for clarity, delegated to a dedicated agent. |
