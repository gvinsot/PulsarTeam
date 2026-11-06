---
type: runbook
title: Deployment and operations
description: How to run PulsarTeam with Docker Compose or deploy it to Swarm through PulsarCD, covering required secrets, how they reach services, the post-deploy security step, placement, restart and update behaviour, and stateless runner storage.
tags: [operations, deployment, docker, swarm, secrets, pulsarcd]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-d5b5bc78fec2b9f7169d8cf0
    resource: repo://api/src/secrets.ts
  - id: openwiki-source-ca6cb4b1a14fd7969dfae3ec
    resource: repo://CHANGELOG.md
  - id: openwiki-source-5677f4b2b6de3fcc87e7fe21
    resource: repo://devops/docker-compose.post.sh
  - id: openwiki-source-c4946ce70fb4d8531fa934a5
    resource: repo://devops/docker-compose.swarm.yml
  - id: openwiki-source-b79fbbd921df689b4bbdc82f
    resource: repo://docker-compose.yml
  - id: openwiki-source-3a44815832a872f4778f822b
    resource: repo://SECURITY.md
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Deployment and operations

There are two supported shapes. `docker-compose.yml` is for self-hosting, and `devops/docker-compose.swarm.yml` is the maintainer's cluster stack. The differences are listed in [System overview](../architecture/system-overview.md#two-deployment-shapes).

## Docker Compose

```bash
cp .env.example .env
for v in JWT_SECRET POSTGRES_PASSWORD CODER_API_KEY ENCRYPTION_KEY ADMIN_PASSWORD; do
  sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" .env; done
docker compose up -d --build
```

Open `http://localhost` and log in as `admin` with the `ADMIN_PASSWORD` from `.env`.

There are no default credentials: **Compose refuses to start without the mandatory secrets**, through `${VAR:?...}`. In production, `validateProductionSecrets` also refuses to start if a secret matches a known placeholder such as `changeme`.

To iterate on one service, run it natively against the Compose database:

```bash
docker compose up -d postgres
cd api && npm ci && npm run dev        # port 3001
cd frontend && npm ci && npm run dev   # port 5173
```

`docs/GETTING_STARTED.md` has more detail. Some of it assumes an external PostgreSQL, which Compose no longer requires.

## Secrets

Secrets are read from `/run/secrets/<NAME>` by `readSecret` in `api/src/secrets.ts` and `runner-service/src/secrets.py`, keeping them out of `docker inspect` and `/proc/<pid>/environ`. Environment variables are a development fallback.

PulsarCD mounts every variable matching `*_SECRET`, `*_KEY`, `*_TOKEN` or `*_PASSWORD` as a secret file. Keep to these suffixes when naming new ones, or they stay plain environment variables.

| Secret | Consequence |
|---|---|
| `JWT_SECRET` | Rotating it signs out **everyone**, and is the only way to invalidate live sessions |
| `ENCRYPTION_KEY` | **Losing or changing it makes stored OAuth tokens and API keys for LLMs and MCP unreadable**. Back it up |
| `CODER_API_KEY` | Shared by the API and all runners |
| `POSTGRES_PASSWORD`, `ADMIN_PASSWORD` | Database and initial admin |
| `AUTH_BROWSER_KEY`, `HOME_FORM_KEY` | Authenticated browser service and home form |

The `api` image runs as UID 10001, so `/run/secrets/*` must be readable by it.

## Swarm

Deployment goes through PulsarCD, which also creates per-deploy `v1.0.<n>` tags. These are markers, not releases: the changelog records notable changes, and only current `main` is supported. Pushing to `main` triggers the pipeline.

### Prerequisites

| Requirement | Reason |
|---|---|
| Networks `proxy`, `postgresqlcluster_internal`, `llm-net` | Declared external |
| PostgreSQL on `postgresqlcluster_internal` | No bundled database in this stack |
| Node `server-b` | `team-api`, `sandbox-service`, `mcp-auth-browser` are pinned there |
| Nodes labelled `gpu=none` | Most other services |
| Traefik from the PrivateNetwork stack | Routing, TLS, WAF |

### Hooks

`docker-compose.pre.sh` sources `devops/.env`, which must exist. It currently does nothing else.

`docker-compose.post.sh` has a security role, so **it must succeed**. `docker stack deploy` ignores `security_opt` on this Docker CLI, so it runs `configure-auth-browser.py` to apply the seccomp profile and `no-new-privileges` to `mcp-auth-browser` directly on the service.

It targets `DEPLOY_STACK_NAME`, as PulsarCD doesn't export `STACK_NAME` to hooks. Falling back to the default once reconfigured production during every QA deployment and left QA's Chromium unable to sandbox. The URL it prints at the end, `swarm.methodinfo.fr`, is out of date.

### Service behaviour

| Service | Notes |
|---|---|
| `team-api` | One replica on `server-b`. `restart_policy: any`, since a graceful SIGTERM exits with 0, and `on-failure` would leave the API at 0/1. Updates are `start-first` with rollback |
| `frontend` | Port 8080 |
| Runners | One service per CLI, same image. `aider-service` and `hermes-service` have `replicas: 0`. `init: true` is required because the CLIs daemonize, and without an init process zombies accumulate |
| `io-limiter` | `mode: global` on x86_64 only, since the image is amd64 and an arm64 node would hold a pending task forever |
| `test` | `replicas: 0`, exists only to build the test image |

**Start-first and the API's single-node design.** During an API update, the old and new containers overlap briefly while sharing the database. Task locks and environment locking limit the effect, but in-memory state such as streams doesn't transfer.

### Runner storage

**Runners are stateless on purpose.** `/app/data`, with agent homes, tokens, CLI sessions and clones, is not persisted. On restart, tokens are fetched again from `team-api`, MCP and settings are rewritten, and projects are cloned again. Only per-node toolchain volumes persist: `rust-toolchain`, `android-toolchain` and `azure-cli`.

Consequently **uncommitted work in an agent's clone is lost when a runner restarts**.

### Configuration notes

- `RUNNER_CLI_CACHE_BUST` forces a rebuild of the CLI layer to pick up newer versions. See `docs/cli-updates.md`.
- `RUNNER_IO_WRITE_BPS` caps runner disk writes, through `io-limiter`, because Swarm ignores `blkio_config`.
- `GIT_CLONE_ALLOWED_HOSTS` adds hosts a repo may be cloned from. `github.com` over HTTPS is implicit.
- Only the local-model runners join `llm-net`.

## Edge rules in Swarm

Labels on `team-api` define the routes for `pulsarteam.io` and `www.pulsarteam.io`, with OAuth callback paths and security headers. High-priority routers deny `/api/internal/*`, matching case-insensitively, as Express routing would otherwise accept `/api/INTERNAL/...`.

The headers include a `Permissions-Policy` that has blocked the microphone in the past, and a `same-origin-allow-popups` opener policy needed by the OAuth popups.

The edge's WAF has exceptions for this app's prompt inputs in the PrivateNetwork repository. **Adding a route that accepts code or prompts may need a matching exception there**, or requests will get a 403.

## Verifying a deployment

```bash
curl https://<host>/api/health       # ok, degraded, or 503 after repeated DB failures
docker service ps pulsarteam_team-api
docker service logs -f pulsarteam_team-api
```

`/api/health` returns a `build` field when `BUILD_SHA` is set, showing which commit is running. `/api/health/details` needs authentication.

A database outage at startup doesn't stop the API. It [runs without persistence](../data/persistence-and-migrations.md#startup-and-connections), so check the `database` field.
