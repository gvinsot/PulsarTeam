# Contributing to PulsarTeam

PulsarTeam is AGPL-3.0. By contributing you agree your work ships under that
licence — including the network-use clause, which means a modified hosted
version has to offer its source to its users.

## Repository layout

| Path              | What it is                                                             |
| ----------------- | ---------------------------------------------------------------------- |
| `api/`            | Express + Socket.IO control plane (TypeScript, Node 24)                |
| `frontend/`       | React 18 + Vite SPA                                                    |
| `runner-service/` | Generic agent runtime (Python); one image, `RUNNER_TYPE` picks the CLI |
| `mcp-browser/`    | crawl4ai/Playwright web tools behind FastAPI                           |
| `office-engine/`  | DOCX/XLSX/PPTX/PDF MCP tools (library)                                 |
| `office-service/` | Server-side deployment of `office-engine`                              |
| `desktop/`        | Local companion app (local-folder bridge, Office sidecar)              |
| `devops/`         | Docker Swarm stack + deploy hooks                                      |

## Getting set up

```bash
cp .env.example .env
docker compose up -d --build      # everything
```

For iterating on one service, run it natively against the compose Postgres:

```bash
cd api      && npm ci && npm run dev     # tsx --watch, port 3001
cd frontend && npm ci && npm run dev     # vite, port 5173, proxies /api
```

## The gates

Run these before pushing. They are the whole gate — there is no CI yet, so the
discipline is manual.

```bash
cd api
npm run typecheck     # tsc --noEmit
npm run lint          # eslint, with a pinned warning ceiling (see below)
npm test              # node:test, 361 tests

cd ../frontend
npm run typecheck
npm run lint
npm test
```

`vite build` does **not** type-check. `npm run typecheck` is the only thing that
does — a green `npm run build` proves nothing about types.

## The strictness ratchet

Both `tsconfig.json` files run with `strict: false`, and both list every strict
flag with its measured cost in a comment block. That block is the contract:

- Flags already `true` are clean. **A change that reintroduces an error under one
  of them does not land.**
- Flags listed as "not yet" carry their current error count. To turn one on:
  flip it, fix its errors, move its line into the enabled group, update the
  counts of the flags below it. One flag per pull request — a flag flip mixed
  into a feature is unreviewable.
- Never move a line back down. If a flag has to be disabled, that is a revert,
  not a ratchet step.

The same contract covers `any`. `@typescript-eslint/no-explicit-any` is a
_warning_, and `npm run lint` runs `--max-warnings <N>` with `N` pinned in
`package.json` to the count at the time it was set (api: 1485, frontend: 137).
So:

- adding an `any` pushes the count over the ceiling and fails the lint run;
- removing `any`s lets you lower `N` in `package.json` — please do, in the same
  commit that removes them.

Read `api/eslint.config.js` before adding or re-enabling a rule. Rules that were
evaluated and rejected are listed there with the reason they were rejected, so
you do not have to rediscover it.

## Formatting

Prettier owns formatting (`.prettierrc.json`: 100 columns, single quotes, es5
trailing commas, LF). The codebase has been formatted repo-wide, so
`npm run format:check` should pass before you push and `npm run format` fixes it
if it does not.

That pass is recorded in `.git-blame-ignore-revs`. Turn it on once per clone so
`git blame` skips it and points at the commit that actually wrote each line:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

If another bulk-formatting commit ever becomes necessary, give it its own commit
touching nothing else and add its SHA to that file.

**One trap worth knowing.** Reformatting can move an
`// eslint-disable-next-line` off the line it was suppressing — prettier splits
`useCallback(fn, deps)` across lines, and a directive that sat above the closing
`}, [deps]);` ends up above the bare `},` instead. The suppression silently
stops working. ESLint 10 reports unused directives by default, which is the only
reason this is visible rather than a rule quietly switching itself back on; if
`npm run lint` grows an "Unused eslint-disable directive" after you format,
that is what happened, and the fix is to move the directive down onto the line
the rule actually reports.

## Commits and pull requests

Commit subjects follow what is already in the log: a component prefix, a colon,
and an imperative summary.

```
api: fold MistralProvider into VLLMProvider & share OpenAI message mapper
runner: stop phantom re-auth loop in run_sync
fix: gitReconcile error recovery and range fallback for commit detection
```

Keep a pull request to one concern. If you had to fix something unrelated to get
there, say so in the description rather than leaving the reviewer to find it.

State in the description which gates you ran and what you did _not_ verify.
"Docker was not available, so the image builds are unbuilt" is useful. Silence
is not.

## Touching Dockerfiles

Four of the five images drop to an unprivileged UID. `runner-service` does not,
and must not — its isolation is per-agent UIDs, which needs
`CAP_CHOWN`/`CAP_SETUID`/`CAP_SETGID` in the parent process. The Dockerfile has
a block explaining this; read it before "fixing" the missing `USER`.

Two image changes have deploy-side consequences, both flagged in the Dockerfiles
themselves:

- `api` runs as uid 10001, so `/run/secrets/*` must be readable by it.
- `frontend` listens on **8080**, not 80. `docker-compose.yml` maps `80:8080` and
  the Traefik label in `devops/docker-compose.swarm.yml` targets 8080. Change
  the port in `frontend/nginx.conf`, the compose mapping, and the Traefik label
  together or not at all.

## Dependencies

`npm audit --omit=dev` must report zero vulnerabilities in `api` and `frontend`
before a dependency change lands. `desktop` has known unfixable advisories —
see SECURITY.md.

## Reporting security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).
