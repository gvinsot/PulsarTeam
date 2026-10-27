# runner-service/ — agent notes

FastAPI service, one image for every CLI runtime. `RUNNER_TYPE` selects a
backend in `src/backends/` (claude-code, codex, opencode, vibe, hermes,
openclaw, aider, sandbox, mock). Read [`README.md`](README.md) for the HTTP
surface and the root [`AGENTS.md`](../AGENTS.md) for repo rules.

## Commands (run from `runner-service/`)

```bash
python3 -m pytest -q tests                    # full suite (~75 s)
python3 -m pytest -q tests/test_codex.py -k name
```

Tests put `src/` on `sys.path` themselves. A few tests expect the runner image's
per-agent Linux users and real CLIs. Outside that image, expect a handful of
`KeyError: 'username'` / subprocess failures. Compare against `main` before and
after your change. Not in CI.

## Where things live

| Need to change…                      | Look in                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| App + routes                         | `src/server.py`, `src/routes_*.py`                                |
| Shared CLI backend logic             | `src/backends/cli_backend.py`, `base.py`                          |
| One CLI's launch flags / auth        | `src/backends/<cli>.py`, `<cli>_oauth.py`, `<cli>_token_store.py` |
| Interactive terminal (PTY)           | `src/pty_session.py`, `src/routes_terminal.py`                    |
| Per-agent UID isolation              | `src/agent_user.py`, `src/security.py`                            |
| Command allow/deny                   | `src/command_security.py`                                         |
| MCP / LLM / instructions config sync | `src/backends/runner_*_config.py`                                 |
| Secret scrubbing                     | `src/secret_filter.py`, `src/log_redaction.py`                    |
| Image                                | `Dockerfile` (runs as root **on purpose**, so do not add `USER`)  |

## Conventions

- Each CLI gets one module in `src/backends/`. Shared behaviour belongs in
  `cli_backend.py`. Do not copy-paste between backends.
- `tests/_cli_matrix.py` pins each interactive CLI's launch command. When you add
  an interactive CLI, add it there.
- Never log tokens, OAuth codes, or prompts unredacted.
