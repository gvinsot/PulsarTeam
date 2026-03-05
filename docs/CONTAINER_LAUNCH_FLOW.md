# Container Launch Flow for Agent Action Execution

## Orchestration Path

1. Agent emits tool calls in model output (e.g. `@read_file`, `@run_command`).
2. `AgentManager._processToolCalls(...)` parses tool calls and, for project-bound agents, ensures sandbox readiness before execution.
3. `AgentManager` resolves the project git URL and calls:
   - `sandboxManager.ensureSandbox(agentId, agent.project, gitUrl)`
4. Tool execution is then routed through `executeTool(...)` and into sandbox-backed methods.

Primary code paths:
- `server/src/services/agentManager.js` (`_processToolCalls`)
- `server/src/services/agentTools.js` (`executeTool`)
- `server/src/services/sandboxManager.js` (container lifecycle + exec)

## Environment Setup During Launch

`SandboxManager.ensureSandbox(...)` creates one Docker container per agent.

### Container identity
- Deterministic name from agent ID:
  - `sandbox-${agentId.replace(/-/g, '').slice(0, 12)}`

### Docker run configuration
- Detached container: `docker run -d`
- Network: `--network bridge`
- Resource limits: `--memory 2g --cpus 2`
- Image:
  - `process.env.SANDBOX_IMAGE` or default `agentswarm-sandbox:latest`
- Mounts:
  - SSH keys (read-only): `${SSH_KEYS_HOST_PATH || '/home/gildas/.ssh'}:/root/.ssh:ro`
  - Docker socket: `/var/run/docker.sock:/var/run/docker.sock`
- Environment variables injected:
  - `GIT_USER_NAME`
  - `GIT_USER_EMAIL`

### Post-launch bootstrap
After container start:
1. Configure git identity inside container (`git config --global ...`) when provided.
2. Clone project repository into:
   - `/workspace/<project>`
3. Register sandbox in in-memory map:
   - `Map<agentId, { containerName, project }>`

## Runtime Execution Model

All action tools execute inside the sandbox container via `docker exec`:

- Generic command execution:
  - `docker exec [-w <cwd>] <container> /bin/bash -c "<command>"`
- Working directory defaults:
  - `/workspace/<project>` when project assigned
  - `/workspace` otherwise

Tool-backed operations in sandbox:
- file read/write/append
- directory listing
- grep-based search
- shell command execution
- git commit/push command execution

## Lifecycle Management

### Create / Ensure
- `ensureSandbox(...)` is lazy and idempotent:
  - Reuses existing sandbox if same project and container still running.
  - Recreates if container died.
  - Destroys/recreates when project changes.

### Project switch
- `switchProject(...)`:
  1. `rm -rf /workspace/*`
  2. clone new project into `/workspace/<newProject>`
  3. update tracked project in map

### Destroy (single)
- `destroySandbox(agentId)`:
  - force remove container (`docker rm -f`)
  - remove map entry

### Destroy (all)
- `destroyAll()`:
  - destroys all tracked sandboxes
  - then runs orphan cleanup

### Orphan cleanup
- `cleanupOrphans()`:
  - lists containers matching `name=sandbox-`
  - removes any not tracked in current process map
- Called:
  - at server startup (`server/src/index.js`)
  - after destroy-all shutdown path

### Graceful shutdown
`server/src/index.js` registers `SIGTERM` and `SIGINT` handlers:
1. log shutdown message
2. call `sandboxManager.destroyAll()`
3. exit process

## Failure Handling

- If `docker run` fails: throws explicit sandbox creation error.
- If initial `git clone` fails:
  - force-remove newly created container
  - throw clone failure error
- If Docker is unavailable during orphan cleanup:
  - errors are swallowed (non-fatal startup behavior).
- `_isRunning(...)` uses `docker inspect` to detect dead containers and trigger recreation.

## Practical Summary

- Orchestration is application-level (inside `AgentManager`), not Kubernetes-based.
- Isolation unit is one Docker sandbox per agent.
- Environment is standardized around `/workspace/<project>` with git + optional SSH credentials.
- Lifecycle is fully managed: startup cleanup, lazy provisioning, health re-check, project switching, and shutdown teardown.