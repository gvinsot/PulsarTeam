# Runner Service

Generic agent runtime service. A single FastAPI image that adapts to one
of several agent backends, selected at startup via the `RUNNER_TYPE`
env var.

## Backends

| `RUNNER_TYPE` | Backend                            | LLM agent | OAuth login |
| ------------- | ---------------------------------- | --------- | ----------- |
| `claude-code` | Claude Code CLI (Anthropic)        | yes       | yes (PKCE)  |
| `openclaw`    | OpenClaw CLI                       | yes       | no          |
| `hermes`      | Hermes CLI                         | yes       | no          |
| `opencode`    | OpenCode CLI (opencode.ai)         | yes       | no          |
| `sandbox`     | No LLM — exec/file ops only        | no        | no          |

`claude-code` is the default if `RUNNER_TYPE` is unset.

## Endpoints

All backends expose the same HTTP surface; capabilities the active
backend doesn't support return `501`.

- `GET  /health`
- `POST /execute`                — sync agent run
- `POST /stream`                 — SSE stream
- `POST /reset`                  — clear agent session
- `POST /v1/chat/completions`    — OpenAI-compatible
- `POST /v1/completions`
- `GET  /v1/models`
- `POST /code/execute`           — direct python/shell exec (no LLM)
- `POST /exec-shell`             — shell exec in agent's project workspace
- `POST /projects/ensure`        — clone/refresh per-agent project

Auth (claude-code only):

- `GET/POST /auth/status` · `/auth/login` · `/auth/token`
- `GET/POST /auth/agent/{id}/...`
- `GET/POST /auth/owner/{id}/...`

## Layout

```
runner-service/
├── Dockerfile
├── requirements.txt
└── src/
    ├── server.py             entry point
    ├── config.py             RUNNER_TYPE + shared constants
    ├── models.py             Pydantic schemas
    ├── security.py           API key
    ├── agent_user.py         per-agent isolated home
    ├── code_executor.py      python/shell exec
    ├── routes_api.py         agent + shell endpoints
    ├── routes_auth.py        auth endpoints
    ├── entrypoint.sh
    └── backends/
        ├── __init__.py       factory: RUNNER_TYPE → backend instance
        ├── base.py           RunnerBackend abstract base
        ├── cli_backend.py    common CLI runner base
        ├── claude_code.py    Claude Code backend (with OAuth)
        ├── claude_oauth.py
        ├── claude_token_store.py
        ├── openclaw.py
        ├── hermes.py
        ├── opencode.py
        └── sandbox.py
```
