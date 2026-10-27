# AGENTS.md — working on PulsarTeam as an AI agent

This repository is developed by AI agents. This file is the entry point. Read it
before your first edit. `CLAUDE.md` files import it, and each sub-project has
its own `AGENTS.md` with local rules:

- [`api/AGENTS.md`](api/AGENTS.md): Express + Socket.IO control plane (TypeScript)
- [`frontend/AGENTS.md`](frontend/AGENTS.md): React 18 + Vite SPA (TypeScript)
- [`runner-service/AGENTS.md`](runner-service/AGENTS.md): agent runtime (Python/FastAPI)

Human-oriented docs: `README.md` (features), `CONTRIBUTING.md` (gates, ratchets,
commit style), `specs/` (functional behaviour, per domain), `docs/` (design
notes and post-mortems).

## Workflow (every task)

1. `git pull --rebase` before you start. Other agents push to `main` all the time.
2. Find the code. Use the tables below and `specs/` before you grep the whole tree.
3. Make the change, plus a test in the project's test folder (see the sub-project file).
4. Run the gates for every project you touched: `scripts/check.sh api frontend`.
5. Commit with the repo's subject style (`api: …`, `frontend: …`, `runner: …`,
   `fix(scope): …`, `feat(scope): …`), then `git pull --rebase && git push` to `main`.
   A push to `main` triggers CI/CD, so never push red gates.

## The gates (CI runs exactly these, see `.github/workflows/ci.yml`)

```bash
scripts/check.sh                  # all node projects: api frontend desktop
scripts/check.sh api              # one project
scripts/check.sh --fix frontend   # run prettier --write + eslint --fix first
```

For each project the script runs `npm ci` (only when `node_modules` is missing),
`typecheck`, `lint`, `test`, `build`, `format:check`. Run it before you push.

- `vite build` / `tsc` build do **not** prove types are right. Only `typecheck` does.
- `lint` fails if `no-explicit-any` warnings go **above** the ceiling pinned in
  `package.json` (`--max-warnings N`). Never raise `N` (CI's `any-ratchet` job
  rejects that). If you removed `any`s, lower `N` in the same commit.
- `strict: true` is on in every tsconfig. Do not fix type errors with `!`
  non-null assertions, `as any`, or `@ts-ignore`. Narrow the type instead.
- After `prettier --write`, run lint again. Prettier can move an
  `// eslint-disable-next-line` away from the line it suppresses, which shows up
  as an "Unused eslint-disable directive" warning plus a new error. Put the
  directive back directly above the reported line.

`desktop` needs `cmake` and a C++ toolchain for `npm ci` (native webview
dependency). Without them, the script reports `desktop:npm ci` and skips that
project. That is an environment gap, not a regression.

Python services (`runner-service`, `mcp-browser`, `mcp-auth-browser`,
`office-engine`, `io-limiter`) are not in CI. Run their tests with
`python3 -m pytest -q tests` from the service folder (`io-limiter`: `pytest -q`).
Some runner tests need the runner image's Linux users, so a few `KeyError:
'username'` / subprocess failures outside that image are expected. Check that
you did not add new failures.

## Repository map

| Path                | What                                                                             | Language     |
| ------------------- | -------------------------------------------------------------------------------- | ------------ |
| `api/`              | REST + WebSocket control plane, MCP surfaces, DB access                          | TS, Node 24  |
| `frontend/`         | SPA (served by nginx on 8080 in prod)                                            | TS, React 18 |
| `runner-service/`   | One image, `RUNNER_TYPE` picks the CLI (claude-code, codex, opencode, vibe, …)   | Python       |
| `desktop/`          | Local companion app (local-folder bridge, Office sidecar)                        | TS           |
| `mcp-browser/`      | crawl4ai/Playwright web tools behind FastAPI                                     | Python       |
| `mcp-auth-browser/` | Authenticated browser sessions MCP                                               | Python       |
| `office-engine/`    | DOCX/XLSX/PPTX/PDF MCP tools (library)                                           | Python       |
| `office-service/`   | Dockerfile that deploys `office-engine`                                          | Docker       |
| `io-limiter/`       | Disk-IO throttling sidecar for runners                                           | Python       |
| `devops/`           | Docker Swarm stack + pre/post deploy hooks                                       | YAML/sh      |
| `specs/`            | Functional specs: `specs/api/*.md`, `specs/ui/*.md`, `specs/websocket-events.md` | Markdown     |

The projects are independent npm/pip roots. The frontend talks to the API only
over HTTP/WebSocket and never imports from it. Shared contracts are duplicated
on purpose and must be changed on both sides together:

| Contract           | API side                                             | Frontend side                                    |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------ |
| WebSocket events   | `api/src/ws/events.ts`                               | `frontend/src/socketEvents.ts`                   |
| REST payload types | `api/src/schemas/*.ts` (zod)                         | `frontend/src/types/*.ts`, `frontend/src/api.ts` |
| Spec               | `specs/api/<domain>.md`, `specs/websocket-events.md` | `specs/ui/<area>.md`                             |

## Invariants that are easy to break

- **Every new HTTP route needs an entry in `ROUTE_POLICY`** in
  `api/src/services/__tests__/routeInventory.test.ts`. That entry states which
  guards protect the route. The test boots the real app and fails on any
  undeclared, changed, or stale route. Use the guards in `api/src/middleware/`
  (`authenticateToken`, `requireRole`, `authz.ts` board/project checks). Never
  leave a route without a guard.
- **Multi-tenant**: any handler that takes a board/project/task/agent id must
  check access through `api/src/middleware/authz.ts` or `api/src/lib/*Access.ts`.
  Leaving this out is the bug this repo has had most often.
- **DB migrations are append-only.** `api/src/services/database/migrations.ts`
  keeps a checksum for each applied migration and refuses to boot if one
  changes. Add a new migration at the end of the list. Never edit an old one.
- **Secrets**: never log tokens. Keep secret filtering in place
  (`api/src/services/secretFilter.ts`, `runner-service/src/secret_filter.py`,
  `log_redaction.py`). Never commit `.env`.
- **OpenAPI docs are generated** from zod schemas and live MCP servers
  (`api/src/services/apiDocs.ts`). When you add a public surface, update its
  prose there. `apiDocs.test.ts` pins that prose to the route inventory.
- **Dockerfiles**: `runner-service` runs as root on purpose (it needs per-agent
  UIDs). Do not add `USER`. The frontend listens on 8080. Read `CONTRIBUTING.md`
  § "Touching Dockerfiles" before you edit any image.

## Token-saving tips

- Large files: read only the line ranges you need. `api/src/services/agentManager/`,
  `frontend/src/api.ts` and `frontend/src/components/tasks/` are big.
- Do not read `package-lock.json`, `docs/*.png`, `dist/`, or `docs/archive/`.
  They are listed in `.claudeignore`.
- Many decisions (rejected lint rules, strictness history, why a guard exists)
  are written as block comments at the top of the relevant file. Read those
  before you "fix" something that looks odd.
