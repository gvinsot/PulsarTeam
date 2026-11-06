---
type: service
title: Runner service
description: The single FastAPI image that runs each coding CLI as a backend selected by RUNNER_TYPE, how the API dispatches to it, how tasks are injected into a shared terminal, how busy and idle are inferred, and how configuration and credentials reach each agent.
tags: [runner, cli, pty, terminal, fastapi, claude-code, codex]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-b0389ae8ab45d05187ac53c9
    resource: repo://api/src/services/agentManager/cliActivity.ts
  - id: openwiki-source-1bf8ccb4c92c9c165619797a
    resource: repo://api/src/services/agentManager/tasks.ts
  - id: openwiki-source-7f8e93941d40f144ffd807a0
    resource: repo://api/src/services/execution/cloneUrlGuard.ts
  - id: openwiki-source-bbfeccdfe8ff828f8a26c04b
    resource: repo://api/src/services/execution/executionManager.ts
  - id: openwiki-source-f01e35df00e2fa18a93e3bbb
    resource: repo://api/src/services/execution/runnerRegistry.ts
  - id: openwiki-source-4d2147d9e56a37fc4b9b1e33
    resource: repo://docs/cli-updates.md
  - id: openwiki-source-50f9eaee51138e45e005d024
    resource: repo://docs/codex-input-recovery-2026-09-16.md
  - id: openwiki-source-163886d9851c2535e833938f
    resource: repo://runner-service/src/backends/base.py
  - id: openwiki-source-2d825ddae8cb0fafbf7757d8
    resource: repo://runner-service/src/backends/runner_mcp_config.py
  - id: openwiki-source-0685ddcff194bd9c2fd8d572
    resource: repo://runner-service/src/pty_session.py
  - id: openwiki-source-aabbbd665217c75f8fd32cef
    resource: repo://runner-service/src/server.py
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Runner service

`runner-service/` is one image deployed many times. `RUNNER_TYPE` selects a backend at startup, so `claudecode-service`, `codex-service` and the others are the same code with a different setting. `sandbox` has no LLM and provides only execution and file operations for native agents.

| `RUNNER_TYPE` | Module in `src/backends/` | OAuth login |
|---|---|---|
| `claude-code` (default) | `claude_code.py`, `claude_interactive.py` | Yes, PKCE |
| `codex` | `codex.py` | Yes |
| `opencode`, `openclaw`, `hermes`, `vibe`, `aider` | One module each | No |
| `sandbox` | `sandbox.py` | No |
| `mock` | `mock.py`, canned responses for tests | No |

`runner-service/README.md` omits `codex` and `aider` from its table.

## Structure

| Change | Look in |
|---|---|
| Routes | `src/server.py`, `src/routes_*.py` |
| Shared CLI logic | `src/backends/cli_backend.py`, `base.py` |
| One CLI's launch flags and auth | `src/backends/<cli>.py`, `<cli>_oauth.py`, `<cli>_token_store.py` |
| Terminal | `src/pty_session.py`, `src/routes_terminal.py` |
| Per-agent users | `src/agent_user.py`; see [Agent isolation and secrets](../security/agent-isolation.md) |
| Config sync | `src/backends/runner_*_config.py` |
| Usage reporting | `src/usage_watcher.py`, `usage_reporter.py` |

**Each CLI gets one backend module, and shared behaviour belongs in `cli_backend.py`.** A backend sets capability flags in `RunnerBackend`, such as `supports_oauth_login` and `supports_interactive_terminal`. Unsupported methods make their routes return 501. `tests/_cli_matrix.py` pins each interactive CLI's launch command, so add new CLIs there.

## How the API reaches a runner

`api/src/services/execution/` is the API-side client:

- **`runnerRegistry.ts`** maps runner types to URLs. Adding a runner service is a one-line change here.
- **`ExecutionManager`** keeps one HTTP client per runner and routes per-agent calls. An unknown type falls back to `sandbox`.
- **`RunnerExecutionProvider`** is a thin HTTP client over `/exec-shell`, `/projects/ensure` and so on, holding no CLI knowledge.
- **`agentWorkspace.ts`** and **`cloneUrlGuard.ts`** prepare clones. The guard allowlists the final clone URL, because the token is spliced into it, so any host it names would receive the agent's GitHub token.

All calls carry `CODER_API_KEY`.

### HTTP surface

| Route | Purpose |
|---|---|
| `/v1/chat/completions`, `/v1/completions`, `/v1/models` | OpenAI-compatible agent calls |
| `/execute`, `/stream` | Sync and SSE agent runs |
| `/code/execute`, `/exec-shell` | Direct execution |
| `/projects/ensure`, `/credentials/git` | Workspace setup |
| `/terminal/sessions/*`, `/ws/terminal/{agent_id}` | Interactive sessions |
| `/auth/*`, `/auth/agent/{id}/*`, `/auth/owner/{id}/*` | CLI login |
| `/task-files/*` | Task attachments |

## Two ways of running a CLI

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Heuristic: an unescaped angle bracket inside a label breaks rendering; rephrase the label. -->
```text
flowchart LR
  A[API] -- "chat: /v1/chat/completions" --> H["Headless CLI run<br/>usage in HTTP response"]
  A -- "task: terminal input" --> P["Shared PTY<br/>usage from transcripts"]
  B[Browser xterm] -- "/ws/agents/:id/terminal" --> A
  A -- "/ws/terminal/:id" --> P
```

Tasks for CLI agents are generally **injected into the agent's shared terminal** (`_sendPromptStreamed` with `terminalDriven`), so a user can watch and step in. `sendMessage` is used otherwise.

### Shared PTY

`pty_session.py` is a broker with **one subprocess per agent**, however many browsers are attached:

1. The first attach spawns the CLI, using the recipe from `backend.prepare_interactive`.
2. Later attaches join and get the scrollback replayed.
3. When the last viewer leaves, the session stays alive, and an idle timer eventually kills it.
4. If the CLI exits, the session is reaped, and the next attach spawns a new one.

The CLIs run under tmux, and because they daemonize, the container needs an init process.

### Delivering a task to a TUI

This is the most fragile part of the system, because it drives interfaces designed for humans. `docs/codex-input-recovery-2026-09-16.md` records one incident in detail. `PtySession.send_input` handles serialization, readiness and Stop cancellation:

- Readiness comes from recognizing each CLI's prompt on the screen, and a busy indicator such as `esc to interrupt` vetoes it. **A CLI update that changes its screen text can break this**, so test after upgrading.
- For Codex, the paste and Enter are separate steps with a check that the composer rendered. If the draft remains, only Enter is retried. **A task is never pasted twice.**
- Stop cancels pending input.
- Timeouts and cancelled submissions return 409, and closed sessions return 503.

**HTTP 200 means the input was delivered, not that the task finished.** Completion still depends on the agent's task update and its deliverables.

Splash screens can also absorb input, hence `CLI_PREP_DELAY_S`, 2 seconds by default.

### Knowing whether a CLI is working

A terminal-driven agent never goes through `sendMessage`, so `api/src/services/agentManager/cliActivity.ts` infers status from these signals:

- Output relayed to a browser, ignoring cursor blinks and idle animations.
- The runner's `idle_seconds`, which counts changes to the visible text rather than redraws.
- Reported token usage, since tokens consumed means the model is working.

There are failure modes on both sides. An agent thinking silently used to look idle and got nudged mid-work. A CLI with a moving screen used to stay busy forever and block the next task, so a **stall rule** now applies: no tokens consumed for `CLI_STALL_MS` since the last prompt means it is no longer working, whatever its screen does.

**Authentication failures look like success.** An expired token renders to the terminal, then the CLI goes quiet, which resembles a finished task. `_probeCliAuth` polls for a latched `auth_error` (`auth_error_detect.py`) so the workflow doesn't advance.

## Configuration and credentials

**Runners are stateless.** At spawn, each CLI's configuration is fetched from the API with `CODER_API_KEY`:

| Fetched from | Module | Provides |
|---|---|---|
| `/api/internal/runner-mcp` | `runner_mcp_config.py` | MCP config; [only the Pulsar Gateway](../integration/plugins-and-mcp.md#pulsar-gateway) |
| `/api/internal/runner-llm` | `runner_llm_config.py` | The agent's LLM config |
| `/api/internal/runner-instructions` | `runner_instructions_config.py` | The system prompt from `buildRunnerInstructions` |
| `/api/internal/runner-azure` | `runner_azure_config.py` | Azure credentials |
| `/api/internal/claude-tokens`, `codex-tokens` | `*_token_store.py` | CLI OAuth tokens, per owner or agent |

Claude Code launches with `--mcp-config <file> --strict-mcp-config`, making that file the only source of MCP servers for the session.

An agent with no `llmConfigId` uses the runner's built-in credentials. `ensureProject` also reloads the runner's project mapping, which is lost on restart. See [Agent lifecycle and chat](../agents/agent-lifecycle-and-chat.md#a-chat-turn).

## Updating CLIs

`docs/cli-updates.md` keeps the history. Codex follows npm `latest` automatically through a remote `ADD`. Others need `RUNNER_CLI_CACHE_BUST` and `OPENCODE_CLI_CACHE_BUST` bumped, in the Dockerfile default and any `.env` that sets them. **After an update, check TUI readiness and the transcript format used for [token accounting](../llm/providers-and-usage.md#token-accounting).**

## Testing

```bash
cd runner-service
python3 -m pytest -q tests                   # about 75 s
python3 -m pytest -q tests/test_codex.py -k name
```

These are not in CI. Some tests need the image's per-agent users and real CLIs, so compare results against `main`. Never log tokens, OAuth codes or unredacted prompts.
