---
type: architecture
title: Persistence and migrations
description: How the API stores data in PostgreSQL, covering the mix of JSONB documents and relational task rows, connection pool limits, append-only checksummed migrations, advisory locks across deployments, and encrypted credentials.
tags: [database, postgresql, migrations, locks, encryption]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-495027946e1c49be2cfee967
    resource: repo://api/src/lib/crypto.ts
  - id: openwiki-source-a8785a1330872f53ffb5584a
    resource: repo://api/src/services/database/connection.ts
  - id: openwiki-source-2ee05863b46c994aec8379c4
    resource: repo://api/src/services/database/llmConfigs.ts
  - id: openwiki-source-cf4c06279388804eef9e8485
    resource: repo://api/src/services/database/locks.ts
  - id: openwiki-source-2e88c4ea98a6612d97d792c8
    resource: repo://api/src/services/database/mcpServers.ts
  - id: openwiki-source-df8ab561ea30897209b3bdaf
    resource: repo://api/src/services/database/migrations.ts
  - id: openwiki-source-b29ac002c1ad50c600c28b66
    resource: repo://api/src/services/database/oauthTokens.ts
  - id: openwiki-source-6eb58389e7892b0c7c0fa7ad
    resource: repo://api/src/services/database/schema.ts
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Persistence and migrations

All persistence goes through `api/src/services/database/`, one module per table family, re-exported by `api/src/services/database.ts`. Only the API touches the database. Runners read what they need through `/api/internal/*`.

**Prod and QA share one database in practice.** Each runs one `team-api`, so several behaviours here exist to keep two deployments from interfering with each other.

## Data shapes

There are two storage styles:

| Style | Tables | Notes |
|---|---|---|
| JSONB document | `agents`, `skills`, `mcp_servers`, `agent_skills`, `llm_configs` | An `id`, a `data` column and timestamps. Most use `createJsonDocStore`; `agents` also has real `owner_id` and `board_id` columns |
| Relational | `users`, `projects`, `boards`, `tasks`, `task_attachments`, `board_shares`, `oauth_tokens`, `token_usage_log`, `api_keys` and audit logs | Normal columns |

**Tasks are the system's most important table.** `database/tasks.ts` is about 2000 lines, and writes are limited to a mapped allow-list (`TASK_COLUMN_BY_FIELD`). Tasks are soft-deleted through `deleted_at`, and normal reads filter on it. Each carries an `environment`, defaulting to `prod`.

The database is the single source of truth for tasks. An earlier in-memory, agent-keyed cache produced a recurring class of bugs, because tasks without an owner were in no bucket. `docs/task-store-db-refactor-plan.md` records the reasoning.

## Startup and connections

`initDatabase` in `schema.ts` retries 5 times, 3 seconds apart. **If every attempt fails, it logs the failure and returns `false`, and the process keeps running without persistence.** Modules check for a missing pool with `if (!pool) return ...`, so during such an outage many reads return empty results rather than errors. Don't read an empty list as proof that no data exists.

The schema bootstrap uses a dedicated connection with `statement_timeout = 0`, since a large `CREATE INDEX` can exceed the normal limit. That connection is destroyed afterwards rather than returned to the pool, or it would serve HTTP queries with no timeout.

Pool options in `connection.ts` are set deliberately:

| Setting | Value | Reason |
|---|---|---|
| `POOL_MAX` | 20 | Two deployments mean up to 40 backends. Must comfortably exceed the task lock cap |
| `connectionTimeoutMillis` | 10 s | The default of 0 meant an exhausted pool made requests hang forever |
| `idleTimeoutMillis` | 30 s | The workflow tick would otherwise churn connections |
| `statement_timeout` | 30 s | Stops a runaway query pinning a connection |
| `keepAlive` | On | Lock connections sit idle for minutes over the Swarm overlay |

An idle-client error handler is required: without it, a dropped idle connection would crash the Node process.

## Migrations

Bootstrap has three steps: `ensureBaseSchema`, `runSchemaMigrations`, `ensureSchemaIndexes`.

**Migrations are append-only.** `migrations.ts` stores a SHA-256 of each applied migration's fingerprint in `schema_migrations`. **If an applied migration changes, the API refuses to boot**, with `Migration <id> checksum changed after it was applied`. To change the schema, add a new entry at the end of `MIGRATIONS`.

- **Concurrency:** a session-level advisory lock makes concurrent starts safe, which matters because prod and QA share the database. A migration therefore runs against **both** environments as soon as either deploys, so a new schema must keep working with the other deployment's older code.
- **Transactions:** each runs in a transaction unless it sets `transaction: false`, for statements such as `CREATE INDEX CONCURRENTLY`.
- **Ordering trap:** `api_keys` is created by `ensureApiKeysTable()` at the end of boot, after migrations, so a migration altering it must create the table first.
- **Style:** use `IF NOT EXISTS` forms, since the base schema may already have the column.

## Cross-deployment task locks

`locks.ts` coordinates workflow processing between deployments with `pg_try_advisory_lock(hashtext(task_id))`. In-process maps guard against re-entrancy inside one process, while these locks cover other processes.

- **Connection cost:** session locks need a dedicated connection, held for the whole `run_agent` chain, which can last minutes.
- **Cap:** `MAX_CONCURRENT_TASK_LOCKS` is 6. Past the cap, a task is skipped until the next tick. The slot is reserved synchronously before the first `await`, as a past bug let a busy board pass the check many times in a single tick.
- **Failure:** PostgreSQL drops session locks on disconnect, so a crash releases them.

**Raise `POOL_MAX` and the lock cap together**, and check the server's `max_connections` first. With the current values, 14 connections remain for HTTP traffic when all locks are held.

## Credentials at rest

`lib/crypto.ts` provides AES-256-GCM encryption, with an `enc:v1:` prefix so that already-encrypted values can be detected. The key comes from the `ENCRYPTION_KEY` secret. **Losing or changing that key makes stored credentials unreadable.**

| Data | Protection |
|---|---|
| LLM config and MCP server `apiKey` | `secretFields` on the document store |
| OAuth tokens | `encryptString` |
| API keys | Only a hash is stored (`key_hash`) |

### OAuth tokens

`oauthTokens.ts` is the unified store for Gmail, Drive, OneDrive, Outlook, Slack, GitHub, Jira, S3, Azure, WordPress, Claude Code and Codex. Tokens are keyed by `(provider, scope_type, scope_id)`, with a scope of `agent`, `board` or `user`.

**There is deliberately no `environment` column**, so prod and QA share credentials. Tasks are environment-scoped, but credentials follow the user, board or agent. A consequence is that QA code can use production OAuth tokens in a shared-database setup.

An in-memory cache is kept in sync across deployments by PostgreSQL `LISTEN/NOTIFY` on `oauth_token_change`. Hot paths read through to the database on a cache miss, in case a notification is missed.

## Files outside the database

The code index stores its data in `.data/code-index/<repoId>/` on the API's disk, not in PostgreSQL. See [Code index](../integration/code-index.md).

## Testing

Unit tests run without PostgreSQL. Mock the database with `mock.module('../database.js', ...)` **before** dynamically importing the module under test, following `helpers/taskDbFake.ts`. See [Gates and testing](../development/gates-and-testing.md).
