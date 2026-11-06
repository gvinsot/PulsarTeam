---
type: guide
title: PulsarTeam quickstart
description: Entry point to the PulsarTeam wiki, explaining what the multi-tenant agent platform does, its main components, how to run and test it, the rules that are easy to break, and which page answers which task.
tags: [quickstart, overview, navigation, agents, platform]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-b79fbbd921df689b4bbdc82f
    resource: repo://docker-compose.yml
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-f9fafda300b014057921ac73
    resource: repo://scripts/check.sh
  - id: openwiki-source-041a906960c3a2419b4580ad
    resource: repo://specs/README.md
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# PulsarTeam quickstart

PulsarTeam is a multi-tenant web platform for running teams of AI agents. Users work on Kanban boards, and agents pick up tasks, driving coding CLIs such as Claude Code and Codex or a built-in tool loop, then report back with commits and comments. It runs model output against real repositories and credentials, so containment and access checks shape much of the code.

The main parts are the API (`api/`), the React SPA (`frontend/`), and the runner service (`runner-service/`), plus browser, office and desktop tools. See [System overview](architecture/system-overview.md).

## Run it

```bash
cp .env.example .env
for v in JWT_SECRET POSTGRES_PASSWORD CODER_API_KEY ENCRYPTION_KEY ADMIN_PASSWORD; do
  sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" .env; done
docker compose up -d --build
```

Open `http://localhost` and log in as `admin` with the `ADMIN_PASSWORD` from `.env`. To work on one service, see [Deployment and operations](operations/deployment.md#docker-compose).

## Check a change

```bash
scripts/check.sh api frontend     # the same gates as CI
cd runner-service && python3 -m pytest -q tests   # Python services aren't in CI
```

Pushing to `main` triggers CI/CD. See [Gates and testing](development/gates-and-testing.md).

## Find what you need

| Task | Page |
|---|---|
| Understand components and how they talk | [System overview](architecture/system-overview.md) |
| Add or change an HTTP route | [API control plane](architecture/api-control-plane.md) |
| Handle login, API keys or tenant access | [Authentication and authorization](security/authentication-and-authorization.md) |
| Understand what contains an agent | [Agent isolation and secrets](security/agent-isolation.md) |
| Change prompts, chat turns or compaction | [Agent lifecycle and chat](agents/agent-lifecycle-and-chat.md) |
| Change board automation, or debug a stuck task | [Tasks and workflow engine](tasks/workflow-engine.md) |
| Add a CLI, or debug a terminal or runner | [Runner service](runners/runner-service.md) |
| Add a plugin, MCP tool or integration | [Plugins and MCP](integration/plugins-and-mcp.md) |
| Add a model provider, or read token usage | [LLM providers, budgets and usage](llm/providers-and-usage.md) |
| Use or change code search | [Code index](integration/code-index.md) |
| Change the schema | [Persistence and migrations](data/persistence-and-migrations.md) |
| Change the UI | [Frontend SPA](frontend/spa-architecture.md) |
| Work on browsers, office tools or the desktop app | [Browser, office and desktop services](services/browser-office-and-desktop.md) |
| Deploy, or manage secrets | [Deployment and operations](operations/deployment.md) |

Functional detail for each surface is in `specs/`, and many design decisions are written as block comments at the top of source files. Read them before changing something that looks odd.

## Rules that are easy to break

1. **Every HTTP route needs an entry in `ROUTE_POLICY`**, and a test fails otherwise.
2. **Handlers taking a board, project, task or agent ID must check access.** The inventory can't verify this, and it has been the most frequent bug here.
3. **Migrations are append-only.** Changing an applied one stops the API from booting.
4. **Only `typecheck` proves types**, and tests outside the expected folders silently don't run.
5. **WebSocket events and payload types are duplicated** in `api/` and `frontend/`. Change both.
6. **Don't add `USER` to the runner image.** Per-agent isolation depends on its absence.
7. **The command blocklist is not a security boundary.** Don't rely on it.
8. **Budgets only alert.** Nothing stops agents at a spending limit.

Report vulnerabilities privately as described in `SECURITY.md`, never in a public issue.
