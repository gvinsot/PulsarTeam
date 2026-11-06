---
type: security
title: Agent isolation and secrets
description: What actually contains an agent running model-driven commands, including per-agent UIDs, container capabilities, secret file permissions and a sanitized environment, why the command blocklist is not a boundary, how terminal output is scrubbed, and how externally written tasks are handled.
tags: [security, isolation, sandbox, secrets, prompt-injection]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-41c44c9ecf9410c42fa32a60
    resource: repo://api/src/lib/taskTrust.ts
  - id: openwiki-source-1bf8ccb4c92c9c165619797a
    resource: repo://api/src/services/agentManager/tasks.ts
  - id: openwiki-source-38fb1089922375d00ba1dcd6
    resource: repo://api/src/services/security/externalRunProfile.ts
  - id: openwiki-source-af16b8a6b69eebcb7dd9102e
    resource: repo://runner-service/Dockerfile
  - id: openwiki-source-c4d83c13c52d65cb04a754fa
    resource: repo://runner-service/src/agent_user.py
  - id: openwiki-source-4078c5c6bb5ad232bc736796
    resource: repo://runner-service/src/command_security.py
  - id: openwiki-source-8597dadff8cc20c9b00086a4
    resource: repo://runner-service/src/entrypoint.sh
  - id: openwiki-source-cc1245e7cee108852e66543f
    resource: repo://runner-service/src/routes_api.py
  - id: openwiki-source-6ccb2cd1fd7119d55c2bac1a
    resource: repo://runner-service/src/secret_filter.py
  - id: openwiki-source-3a44815832a872f4778f822b
    resource: repo://SECURITY.md
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Agent isolation and secrets

Agents execute commands shaped by model output, which can be influenced by anything they read. So PulsarTeam assumes an agent may run arbitrary code as itself, and focuses on limiting what that can reach. `SECURITY.md` states the model and its accepted weaknesses, and is the authoritative reference.

## What contains an agent, and what doesn't

| Control | Real boundary? | Where |
|---|---|---|
| Per-agent UID, `0700` HOME | **Yes** | `runner-service/src/agent_user.py` |
| Container capability allowlist | **Yes** | `cap_drop: ALL`, `no-new-privileges` in Compose files |
| Sanitized environment | **Yes** | `command_security.sanitize_env` |
| Locked `/run/secrets` | **Yes** | `runner-service/src/entrypoint.sh` |
| Per-agent `shellAccess`, `restrictedPaths` | For the HTTP tool surface | `routes_api.py` |
| External task profile | **Yes**, for its scope | `api/src/services/security/externalRunProfile.ts` |
| Command blocklist | **No**: an accident guardrail | `command_security.validate_command`, `api/src/services/agentTools.ts` |

**Don't treat the blocklist as a sandbox.** It matches a string a shell has not expanded yet, so `/bin/sh -c 'shutdow'"n"` bypasses it trivially. It also only sees the HTTP tool surface, while commands a CLI runs in its PTY never pass through it. It exists to stop a well-behaved agent from accidentally rebooting a host. `SECURITY.md` places bypasses of it out of scope.

## Per-agent users

Each agent's subprocess runs under its own deterministic UID in the range 20000 to 60000, with a `0700` HOME under `DATA_DIR/agents/<username>`.

- The UID is derived from the **sanitized** username, so that variations in the agent ID resolve to the same UID and HOME.
- Directories above are `0711`, so an agent can reach its own HOME but not list others.
- A shared group, GID 19999, owns the writable toolchain trees such as the Android SDK.
- `umask 0077` in the entrypoint keeps tokens and credentials private.

### Why the runner runs as root

**Do not add `USER` to `runner-service/Dockerfile`.** The parent process needs `CAP_CHOWN`, `CAP_SETUID` and `CAP_SETGID` to create HOMEs and launch under other UIDs. Adding `USER` would collapse all agents onto one UID and silently remove the isolation between them.

So containment depends on the capability allowlist. **Deploying this image without equivalent `cap_drop` and `no-new-privileges` settings is unsafe.** Other images drop to an unprivileged UID in the image itself.

### Secret files

Swarm mounts secrets `0444`, readable by any UID in the container. In a runner, an agent could then read `ENCRYPTION_KEY` directly. So the entrypoint sets `/run/secrets` to `0700` and files to `0400`, root-owned.

This is **best-effort**: on a read-only mount, the `chmod` fails, the container still starts, and only a `WARNING` is logged. Look for it after changing how secrets are mounted.

### Environment

`sanitize_env` builds each subprocess's environment from an allowlist. `ANTHROPIC_API_KEY`, `JWT_SECRET` and database credentials are absent from its `environ`, including in the interactive PTY, because backends use the same function. When adding a variable a CLI needs, add it to `ENV_ALLOWLIST` deliberately. Note that the pattern list passes all `GIT_*`, `NODE_*`, `PYTHON*`, `npm_*` and `CLAUDE_CODE_*` variables.

### What an agent can still use

An agent does hold credentials, by design:

- Its GitHub token, in `~/.git-credentials` and `GITHUB_TOKEN`.
- Its CLI login tokens.
- MCP access through the gateway, with its internal token.
- The network: runners sit on the `backend` network, and network confinement for CLI runners isn't implemented.

So an injected prompt can act with the agent's own authority, and the isolation only stops it reaching other agents and platform secrets.

## Untrusted task content

A task created with an `insert` key, a webhook or the contact form contains text from **outside the tenant**, which then enters agent prompts. Nothing can reliably tell an instruction from a description, so `api/src/lib/taskTrust.ts` doesn't try to filter. It provides these instead:

1. **Provenance:** `tasks.trust_level`, written at creation: `null` for internal, `untrusted` when awaiting approval, `approved` when approved and **still external**.
2. **A gate:** an untrusted task is inert until a human approves it via `POST /api/tasks/:id/approve`. Execution entry points check `needsApproval`.
3. **Signals and framing:** `scanForInjection` flags suspicious content for the reviewer, invisible Unicode characters are stripped, and `wrapUntrusted` delimits the text with a random tag and a warning.

**Every prompt builder embedding task text must go through these helpers**, such as `taskContentForPrompt`.

### External run profile

Approval means a human read it, not that it's harmless. So an external task, approved or not, always runs in a restricted profile, `externalRunProfile.ts`:

- Credentials are left out of the prompt and CLI instruction file.
- No MCP server is reachable, no other agent can be asked, and no skill can be edited. `update_task` works on this task only.
- Conversation history is dropped and the CLI session restarted **on entering and on leaving**, so earlier secrets can't be read and injected text can't linger.
- The profile is persisted on the agent and fails closed: after a crash, the agent stays restricted until reset.

**A known gap, documented in that file:** it doesn't narrow network access or skipped permission prompts for CLI runners. Claude Code deny rules merge permanently into `settings.json`, and without `--dangerously-skip-permissions` nobody can answer the PTY's prompts. Native agents do get a `run_command` filter.

## Scrubbing output

Terminal text can contain credentials: a `/login` device URL, an echoed `Authorization` header, an env dump. Because it's stored in task history and broadcast over WebSockets, it's scrubbed at the runner in `secret_filter.py` and `log_redaction.py`, and **again at the API** in `secretFilter.ts`, in case of an older runner.

The filters deliberately over-redact, since a mangled log line is cosmetic while a leaked token isn't. They consume quoted values whole, and handle key material with missing delimiters. `find_truncated_secret` lets callers withhold text that can't be safely bounded.

## Tool hooks

`services/toolHooks.ts` lets a configuration block or warn on tool calls by pattern. As with the blocklist, treat this as guidance for well-behaved agents.

## Changing this area

- Read the block comments at the top of each file, as they record bypasses that were real.
- Extend the blocklist when a new *accident* shows up, but don't gate a security property on it.
- Report vulnerabilities privately, as `SECURITY.md` describes, not in public issues.
