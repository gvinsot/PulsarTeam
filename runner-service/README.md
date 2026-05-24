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
| `mock`        | Hard-coded canned responses (test) | simulated | no          |

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
        ├── claude_interactive.py  PTY-driven TUI mode (no `-p`)
        ├── claude_oauth.py
        ├── claude_token_store.py
        ├── openclaw.py
        ├── hermes.py
        ├── opencode.py
        ├── sandbox.py
        └── mock.py             canned-response LLM (testing)
```

## Claude Code: interactive vs headless mode

Anthropic announced that Claude Code's headless mode (`claude -p` /
`--print`) is moving to API-rate pricing while the interactive TUI keeps
subscription pricing. The runner now defaults to **interactive mode**:
the CLI is spawned without `-p`, driven through a PTY, and the assistant's
reply is captured by waiting for an idle window.

Set `CLAUDE_USE_PRINT_MODE=true` to opt back into the old `-p` path
(useful for shells with no PTY support or for diagnostic comparisons).

Interactive mode has to answer any Y/N or numbered-choice prompts the TUI
emits. The driver responds with safe defaults (`y` / first option). For
non-trivial prompts you can wire up an external LLM that will be asked
to choose.

**Recommended:** select the LLM from the **team-api Admin Settings**
("Claude Paid Plan — Interactive Fallback LLM" card). The runner fetches
the resolved endpoint/api-key/model from
`GET /api/internal/runner-llm/claude-fallback` (authenticated with the
shared `CODER_API_KEY`) and caches it for 60s. This avoids touching
env vars on every deployment and keeps the API key encrypted at rest in
the `llm_configs` table.

For local dev or operator overrides, the following env vars still work
and take priority over the admin setting:

- `CLAUDE_FALLBACK_LLM_URL` — base URL of an OpenAI-compatible endpoint
- `CLAUDE_FALLBACK_LLM_KEY` — bearer token (also readable from
  `/run/secrets/CLAUDE_FALLBACK_LLM_KEY`)
- `CLAUDE_FALLBACK_LLM_MODEL` — model name (default `gpt-4o-mini`)
- `CLAUDE_INTERACTIVE_IDLE_SECS` — silence window for "reply finished"
  detection (default `4.0`)
- `CLAUDE_INTERACTIVE_TIMEOUT` — per-turn hard cap (default = `TIMEOUT`)

## Mock backend

Set `RUNNER_TYPE=mock` to run without any real CLI or API key. The backend
returns deterministic canned responses chosen by simple keyword matching
against the prompt, with realistic-looking token counts, costs, and
durations. Streaming splits each response into word-sized SSE chunks.

Useful env vars:

- `MOCK_DELAY_MS` — per-chunk delay when streaming (default: `50`)
- `MOCK_FAIL_ON` — substring that triggers a simulated error response
- `MOCK_TIMEOUT_ON` — substring that triggers a simulated timeout

`docker-compose up mock-service` exposes it on `localhost:8010`. Quick test:

```sh
curl -s -X POST http://localhost:8010/execute \
  -H "X-API-Key: $CODER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"hello"}'
```
