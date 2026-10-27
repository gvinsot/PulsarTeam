# api/ — agent notes

Express 4 + Socket.IO control plane. TypeScript, ESM (`"type": "module"`,
`NodeNext`), so **relative imports must end in `.js`** even though the source
file is `.ts`. Start with the root [`AGENTS.md`](../AGENTS.md).

## Commands (run from `api/`)

```bash
npm run typecheck   # the only type gate (build does not count)
npm run lint        # eslint, --max-warnings ceiling = no-explicit-any count
npm test            # node:test, ~1100 tests, no Postgres needed
npm run format      # prettier --write (then run lint again, see root AGENTS.md)
node --import tsx --experimental-test-module-mocks --test src/services/__tests__/<file>.test.ts   # one file
npm run dev         # tsx --watch on :3001, needs Postgres + .env (docker compose up -d postgres)
```

## Where things live

| Need to change…                       | Look in                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| App wiring, router mounts             | `src/index.ts`                                                                |
| HTTP routes                           | `src/routes/<domain>.ts` (+ `src/routes/lib/`)                                |
| Request validation                    | `src/schemas/<domain>.ts` (zod) + `src/lib/validate.ts`                       |
| AuthN / AuthZ                         | `src/middleware/{auth,authz,apiKeyAuth,csrf}.ts`, `src/lib/*Access.ts`        |
| SQL / persistence                     | `src/services/database/<table>.ts`, re-exported by `src/services/database.ts` |
| Schema changes                        | `src/services/database/migrations.ts` (append only)                           |
| Agent lifecycle, chat, prompts        | `src/services/agentManager/` (`index.ts` is the class)                        |
| Kanban workflow / task transitions    | `src/services/workflow/`                                                      |
| Runner dispatch (claude-code, codex…) | `src/services/execution/`, `src/services/runners.ts`                          |
| Built-in MCP servers                  | `src/services/*Mcp.ts`; key-scoped surfaces in `src/services/mcp/`            |
| Code index / semantic search          | `src/services/codeSearch/` (has its own README)                               |
| LLM providers                         | `src/services/llmProviders.ts`, `llmCompletion.ts`, `llmVendor.ts`            |
| WebSocket events                      | `src/ws/events.ts` (mirror in `frontend/src/socketEvents.ts`)                 |
| OpenAPI document                      | `src/services/apiDocs.ts`                                                     |

## Tests

- **Only `src/services/__tests__/*.test.ts` runs.** That glob is in `package.json`.
  A test file anywhere else is silently skipped.
- Use `node:test` + `node:assert/strict`. No jest, no vitest.
- Unit tests run without a Postgres pool. Mock the DB with
  `mock.module('../database.js', …)` **before** you dynamically `import()` the
  module under test. See `helpers/taskDbFake.ts` for the pattern.
- Route / authorization tests: use `helpers/routeHarness.ts`, which mounts one
  router and calls it `as(user)`.
- Adding, removing, or re-guarding a route means updating `ROUTE_POLICY` in
  `routeInventory.test.ts`. The PUBLIC route count is pinned on purpose.

## Conventions

- Wrap async route handlers with `src/lib/asyncHandler.ts`. Caught values are
  `unknown`, so read them with the helpers in `src/lib/errors.ts`.
- Validate every body/query with a zod schema in `src/schemas/`. Never trust
  `req.body` directly.
- Outbound fetches to user-supplied URLs must go through `src/lib/ssrfGuard.ts`.
- Do not use `any` (the lint ceiling counts it), `!` or `@ts-ignore`. Type the value instead.
- Read the block comment at the top of a file before you restructure it. Design
  decisions and rejected alternatives are written there (for example `eslint.config.js`
  and `tsconfig.json`).
