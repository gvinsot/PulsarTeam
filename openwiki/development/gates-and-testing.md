---
type: testing
title: Gates and testing
description: The checks a PulsarTeam change must pass, including scripts/check.sh, the CI matrix, the no-explicit-any ceiling, where each project's tests must live to actually run, what runs outside CI, and conventions that are easy to break.
tags: [testing, ci, lint, typecheck, ratchet, conventions]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-c777a648e0a3aea55b56355e
    resource: repo://api/package.json
  - id: openwiki-source-b19be77d485a037be731d95a
    resource: repo://api/tests/handoff.test.ts
  - id: openwiki-source-3782c6410701a148b407aa6f
    resource: repo://api/tsconfig.json
  - id: openwiki-source-f317ee207e1653d2033c81a4
    resource: repo://CONTRIBUTING.md
  - id: openwiki-source-7ddab67f79a211f2707884bf
    resource: repo://desktop/tsconfig.json
  - id: openwiki-source-1047363cf615000e4c9bb694
    resource: repo://frontend/package.json
  - id: openwiki-source-fe2e041fde20c03cce72a256
    resource: repo://frontend/tsconfig.json
  - id: openwiki-source-f9fafda300b014057921ac73
    resource: repo://scripts/check.sh
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Gates and testing

A push to `main` triggers CI/CD, and agents push to `main` routinely, so the gates are the main protection for production. Run them locally before pushing.

```bash
scripts/check.sh                  # api, frontend, desktop
scripts/check.sh api              # one project
scripts/check.sh --fix frontend   # prettier --write and eslint --fix first
```

For each project the script runs `npm ci` only if `node_modules` is missing, then the same steps as CI. Every project runs even if another fails, and the exit code is non-zero if any gate failed.

## What CI runs

`.github/workflows/ci.yml` runs on pushes to `main` and all pull requests, using the Node version in `.nvmrc`.

| Step | `api` | `frontend` | `desktop` |
|---|---|---|---|
| `typecheck` (`tsc --noEmit`) | Yes | Yes | Yes |
| `lint` | Yes | Yes | No ESLint config |
| `test` | Yes | Yes | Yes |
| `build` | Yes | Yes | Yes |
| `format:check` | Yes | Yes | No |

**Only `typecheck` proves types.** A green `vite build` or `tsc` build proves nothing about them. All three tsconfig files have `strict: true`.

`desktop` needs `cmake` and a C++ toolchain for `npm ci`. Without them, the script reports `desktop:npm ci` and skips the project, which is an environment gap rather than a regression.

### Not in CI

**The Python services are not in CI.** A change to `runner-service`, `mcp-browser`, `mcp-auth-browser`, `office-engine` or `io-limiter` passes CI without running any of its tests. Run them yourself:

```bash
cd runner-service && python3 -m pytest -q tests   # about 75 s
cd io-limiter && pytest -q
```

Some runner tests expect the image's per-agent Linux users and real CLIs, so a handful of `KeyError: 'username'` or subprocess failures outside the image are expected. Compare against `main` before and after your change.

## The `any` ratchet

`no-explicit-any` is a warning, and `npm run lint` passes `--max-warnings N`, where N is pinned in `package.json`: 1385 for `api`, and 60 for `frontend` when this page was written. Adding an `any` above the ceiling fails lint. If you remove some, lower N in the same commit.

The `any-ratchet` job refuses a raised ceiling, but **it only runs on pull requests**. A direct push to `main` raising N would not be caught by it, so don't raise it.

Don't work around strictness with `!`, `as any` or `@ts-ignore`. Narrow the type.

## Where tests must live

Test globs are narrow, and **a test file elsewhere is silently skipped**.

| Project | Runner | Location |
|---|---|---|
| `api` | `node:test` | `src/services/__tests__/*.test.ts` only |
| `frontend` | `node:test` | `src/**/__tests__/*.test.ts` only: `.ts`, not `.tsx` |
| `desktop` | `node:test` | `test/*.test.ts` |
| `runner-service` | `pytest` | `tests/` |

- **No jest or vitest.** `api/tests/handoff.test.ts` and `realtime.test.ts` use jest and `require`, match no test glob, and never run, so don't use them as examples.
- **API tests need no PostgreSQL.** Mock the database with `mock.module('../database.js', ...)` **before** dynamically importing the module under test. See `helpers/taskDbFake.ts`.
- **Route and authorization tests** use `helpers/routeHarness.ts`, which mounts one router and calls it `as(user)`.
- **Frontend tests have no DOM.** Put logic in a plain `.ts` module and test that.
- **`runner-service/tests/_cli_matrix.py`** pins each interactive CLI's launch command. Add new CLIs there.

Run one API test file:

```bash
cd api
node --import tsx --experimental-test-module-mocks --test src/services/__tests__/<file>.test.ts
```

## Invariants that are easy to break

| Rule | Enforced by |
|---|---|
| Every HTTP route is declared in `ROUTE_POLICY` | `routeInventory.test.ts`; see [API control plane](../architecture/api-control-plane.md#route-guard-inventory) |
| Handlers taking a board, project, task or agent ID check access | **Nothing automatic.** The repo describes this as its most frequent bug; see [Authentication and authorization](../security/authentication-and-authorization.md) |
| Migrations are append-only | Boot-time checksum; see [Persistence and migrations](../data/persistence-and-migrations.md#migrations) |
| Public surfaces are documented | `apiDocs.test.ts` |
| WebSocket events and payload types match across projects | **Nothing automatic**; duplicated by hand |
| New UI strings exist in both `en` and `fr` | Convention, in `frontend/src/i18n/translations.ts` |
| Tokens are never logged | Secret filters and convention |
| `runner-service` has no `USER` in its Dockerfile | Convention, with an explanatory block in the Dockerfile |

## Formatting

Prettier owns formatting: 100 columns, single quotes, ES5 trailing commas, LF. After `prettier --write`, **run lint again**: reformatting can move an `// eslint-disable-next-line` off the line it suppresses, which shows up as an "Unused eslint-disable directive" warning plus a new error. Move the directive back directly above the reported line.

Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once per clone so `git blame` skips the bulk formatting commit.

## Commits and dependencies

Subjects use a component prefix, as in `api: ...`, `runner: ...`, `fix(scope): ...` or `feat(scope): ...`.

`npm audit --omit=dev` must report zero vulnerabilities in `api` and `frontend` before a dependency change lands. `desktop` has known unfixable advisories, listed in `SECURITY.md`.

## Docs to distrust here

`CONTRIBUTING.md` says both tsconfig files run with `strict: false`, with a flag-by-flag ratchet. That section predates the current state: the files have `strict: true`.

Read `api/eslint.config.js` before adding a lint rule, as it lists rejected rules and why they were rejected.
