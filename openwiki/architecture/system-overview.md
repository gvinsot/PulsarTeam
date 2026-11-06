---
type: architecture
title: System overview
description: The processes that make up PulsarTeam, how the browser, API, runners, MCP tools and database communicate, the contracts duplicated between projects, the two deployment shapes, and how a task flows from a board to a commit.
tags: [architecture, overview, services, deployment, contracts]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-f246b9390811248963d78e56
    resource: repo://api/src/index.ts
  - id: openwiki-source-c4946ce70fb4d8531fa934a5
    resource: repo://devops/docker-compose.swarm.yml
  - id: openwiki-source-b79fbbd921df689b4bbdc82f
    resource: repo://docker-compose.yml
  - id: openwiki-source-1047363cf615000e4c9bb694
    resource: repo://frontend/package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# System overview

PulsarTeam is a multi-tenant web platform for running teams of AI agents. Users organize work on Kanban boards, and agents pick up tasks, run coding CLIs or a built-in tool loop, and report results. It runs model output against real credentials and repositories, so much of the design is about containing it.

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Heuristic: an unescaped angle bracket inside a label breaks rendering; rephrase the label. -->
```text
flowchart TB
  B["Browser SPA<br/>frontend/"] -- "REST, Socket.IO, terminal WS" --> API["API control plane<br/>api/ :3001"]
  API --> DB[(PostgreSQL)]
  API -- "HTTP + CODER_API_KEY" --> R["Runner services<br/>runner-service/ image<br/>one per RUNNER_TYPE"]
  R -- "/api/internal/*" --> API
  R --> U["CLI subprocess<br/>per-agent UID"]
  API --> M["MCP surfaces<br/>Gmail, GitHub, Code Index..."]
  API --> LLM["LLM providers"]
  API --> BR["mcp-browser, mcp-auth-browser, office-service"]
  D["Desktop app"] -- "Socket.IO bridge" --> API
  X["External clients<br/>personal API keys"] --> API
```

## Components

| Path | What it is | Language |
|---|---|---|
| `api/` | REST, WebSocket, MCP surfaces, all DB access | TypeScript, Node 24 |
| `frontend/` | SPA, served by nginx on 8080 in production | TypeScript, React |
| `runner-service/` | One image; `RUNNER_TYPE` selects the CLI | Python, FastAPI |
| `mcp-browser/` | Web tools with crawl4ai and Playwright, using FlareSolverr | Python |
| `mcp-auth-browser/` | Authenticated browser sessions | Python |
| `office-engine/`, `office-service/` | DOCX, XLSX, PPTX and PDF tools, and the image deploying them | Python |
| `io-limiter/` | Disk IO throttling across runners | Python |
| `desktop/` | Local companion: folder bridge and Office sidecar | TypeScript |
| `devops/` | Swarm stack and deploy hooks | YAML, shell |
| `specs/` | Functional specs reverse-engineered from code | Markdown |

These are independent npm and pip roots.

**Core concepts** come from `specs/README.md`: an **agent** is a persistent LLM worker, a **task** is a unit of work in a board column, a **board** is a shareable Kanban workspace with a custom workflow, and a **project** groups boards. Users are `basic`, `advanced` or `admin`.

## How parts talk

| From, to | Transport | Authentication |
|---|---|---|
| Browser, API | HTTP, Socket.IO, WebSocket | Session cookie plus CSRF token |
| External client, API | HTTP, MCP | Personal scoped API key |
| API, runner | HTTP on the `backend` network | `CODER_API_KEY` |
| Runner, API | `/api/internal/*` | `CODER_API_KEY` |
| Desktop, API | Socket.IO | JWT, with a `desktop-bridge` role |

**`/api/internal/*` must never be public.** In Swarm, dedicated Traefik routers deny it at the edge for the public hostnames, as a second layer on top of the shared key.

### Duplicated contracts

The frontend talks to the API only over the network and imports nothing from it. These contracts are duplicated on purpose, so **change both sides together**:

| Contract | API | Frontend |
|---|---|---|
| WebSocket events | `api/src/ws/events.ts` | `frontend/src/socketEvents.ts` |
| Payload types | `api/src/schemas/*.ts` | `frontend/src/types/*.ts`, `frontend/src/api.ts` |
| Behaviour | `specs/api/<domain>.md`, `specs/websocket-events.md` | `specs/ui/<area>.md` |

## End-to-end: a task on a board

1. A task is created by the UI, an agent, or an external API key, and lands on a board column.
2. The API's task loop, which runs in-process, finds work. The workflow engine applies the column's rules and selects an agent.
3. The API binds the agent to a runner, ensures its project is cloned, and sends the prompt.
4. In the runner, a CLI runs under the agent's own UID in a PTY, with a sanitized environment. It fetches instructions, MCP and LLM configuration from `/api/internal/*`.
5. Output and usage flow back to the API, and on to the browser over Socket.IO.
6. The agent's commits are linked to the task, the task changes column, and the next step begins.

See [Tasks and workflow engine](../tasks/workflow-engine.md), [Runner service](../runners/runner-service.md) and [Agent lifecycle and chat](../agents/agent-lifecycle-and-chat.md).

## Two deployment shapes

| | `docker-compose.yml` | `devops/docker-compose.swarm.yml` |
|---|---|---|
| Purpose | Self-hosting, local | The maintainer's cluster |
| Database | Bundled `postgres:16-alpine` | External, on `postgresqlcluster_internal` |
| Service names | `api` | `team-api` |
| Edge | Local access | Traefik on `proxy`, `pulsarteam.io` |
| Secrets | `.env`, with required variables enforced | Docker secrets, through PulsarCD |
| Also present | `mock-service` | `mcp-auth-browser`, `test` |

In Swarm, `aider-service` and `hermes-service` are defined with `replicas: 0`, so they do not run by default. `team-api`, `sandbox-service` and `mcp-auth-browser` are pinned to `server-b`, and most others to `gpu == none`. Only local-model runners join `llm-net`, the network that reaches the AIFabric stack.

See [Deployment and operations](../operations/deployment.md).

## Documentation trust

Sources disagree in places, so use this order:

1. **Code and tests** decide what happens.
2. **`SECURITY.md`, `CONTRIBUTING.md` and the sub-project `AGENTS.md` files** are actively maintained.
3. **`specs/`** is detailed and useful, but derived from code at a point in time.
4. **`README.md`** contains stale items. It still describes the `@delegate` syntax, an architecture diagram with a separate sandbox and coder service, and React 19, while `specs/` and `frontend/AGENTS.md` say React 18.
5. **`docs/archive/`** is historical, and `docs/*-YYYY-MM-DD.md` files are dated notes on specific decisions.

Many design decisions are written as block comments at the top of the relevant source file. Read those before changing something that looks odd.
