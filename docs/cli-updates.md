# Runner CLI updates

Read this before you touch how the agent CLIs (Claude Code, Codex, OpenCode,
OpenClaw, Hermes, Aider, Vibe) are installed in `runner-service/Dockerfile`.

## How updates work

**Every image build installs the latest release of every agent CLI.** Nobody
bumps a version or a cache key for that. The image is the only update path:
runners never update a CLI themselves.

### The mechanism

All runner services (`claudecode-service`, `codex-service`, `opencode-service`,
…) build the same `runner-service/Dockerfile`. Its "Agent CLIs" block gives each
CLI two instructions:

1. A remote `ADD` of the CLI's "latest release" metadata.
2. A `RUN` that reads the version from that document and installs exactly that
   version.

BuildKit downloads the `ADD` document on every build and keys the layer on its
content. When upstream publishes a release, the document changes, so the layer
re-runs and installs the new version. Otherwise the cached layer is reused,
because it already holds the latest release. A build therefore never ships an
outdated CLI, and it reinstalls nothing that has not changed.

| CLI | Package | Metadata that keys the layer | If the install fails |
| --- | --- | --- | --- |
| Aider | PyPI `aider-chat` | `https://pypi.org/pypi/aider-chat/json` | stub |
| Vibe | PyPI `mistral-vibe` | `https://pypi.org/pypi/mistral-vibe/json` | stub |
| Hermes | official installer, stable channel | `https://github.com/NousResearch/hermes-agent/releases.atom` | stub |
| OpenClaw | npm `openclaw` | `https://registry.npmjs.org/openclaw/latest` | stub |
| OpenCode | npm `opencode-ai` | `https://registry.npmjs.org/opencode-ai/latest` | warning, CLI absent |
| Codex | npm `@openai/codex` | `https://registry.npmjs.org/@openai/codex/latest` | **build fails** |
| Claude Code | npm `@anthropic-ai/claude-code` | `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` | **build fails** |

Layer order matters:

- The block comes **after** the stable tooling (Go, Docker CLI, rtk, the
  runner's Python venv), so a CLI release does not rebuild those.
- It comes **before** `COPY runner-service/src`, so a code commit does not
  reinstall the CLIs.
- Inside the block, the CLIs are ordered from least to most frequently released.
  A release re-runs its own layer and every CLI layer below it.

If a registry cannot be reached, the build fails at its `ADD`. That is
deliberate: the alternative is an image with a silently outdated or missing CLI.
Re-run the build once the registry answers.

### Getting a new CLI release onto the runners

A CLI update reaches the running agents only when the runner images are rebuilt
and redeployed. Every PulsarTeam pipeline run (build → test → QA → deploy)
rebuilds them, so:

- any push to `main` picks up every CLI release published since the last build;
- with no code change, run the PulsarTeam pipeline from PulsarCD
  (`trigger_pipeline`) to pick them up.

Editing a file in this repository is never needed for a routine CLI update.

### Checking which versions run

- In the build log, every CLI layer prints
  `Resolved <package> latest to <version>`, and the final verification step
  prints the full list.
- On a live runner, the image records what it shipped:

  ```bash
  docker exec <runner container> cat /opt/runner-cli-versions.txt
  ```

  A line such as `hermes: hermes-stub 0.0.0 (install failed)` means that CLI's
  install failed in that build.

### Why runners never update themselves

Each agent runs its CLI under its own UID (20000+), which cannot write the
global npm/pip prefixes. A CLI's in-app updater fails there, and some exit when
it does. Codex's "Update available" dialog defaults to **1. Update now**, which
runs `npm install -g @openai/codex`, fails with `EACCES` and exits codex with
status 1. That killed a prod agent on every spawn on 2026-11-21. So:

- the runner writes `check_for_update_on_startup = false` into the managed block
  at the top of each agent's `~/.codex/config.toml`
  (`configure_codex_permissions`), so the dialog never opens;
- as a fallback, the PTY broker dismisses the dialog with **Esc** and never with
  Enter (`startup_prompts.codex_update_answer_keys`). A swallowed Esc is retried,
  while a swallowed arrow key followed by Enter used to confirm "Update now".

Apply the same rule to any new CLI: turn its self-update off, and never answer
an update prompt with a key that can confirm its default row.

### Rules

- **Never pin a CLI version, and never add a per-CLI `*_VERSION` or
  `*_CACHE_BUST` build argument.** Those manual keys are how the runners fell
  weeks behind before 2026-11-21. Compose files pass no CLI build arguments.
- To reinstall every CLI at the **same** versions (a corrupted install, not a
  new release), change `ARG RUNNER_CLI_CACHE_BUST` in the Dockerfile. That
  argument is the only manual knob.
- To hold back a broken upstream release, replace the resolved version with a
  fixed one in a dedicated commit that explains why, and revert it as soon as
  upstream ships a fix.
- To add a CLI, copy the pattern: an `ADD` of its latest-release metadata, an
  exact-version install, then either a stub fallback (optional CLI) or a hard
  failure (required CLI). Add it to the `/opt/runner-cli-versions.txt` loop and
  to `runner-service/tests/_cli_matrix.py`.

### Known gap: Hermes ships as a stub

The official Hermes installer (v0.23 layout) fails in the image at its
"Computer Use" step, and every build since then has shipped
`hermes-stub 0.0.0`. With `--skip-computer-use --skip-browser` it installs, but
its Python environment lives under the build user's `HERMES_HOME`. A per-agent
UID can run `hermes --version` but not `hermes chat`. Making Hermes work needs
its own change: an install layout readable by the agent UIDs, plus a
world-reachable launcher. Until then, the failure branch at least deletes the
~3 GB the failed install used to leave in the image.

## History

The entries below describe the mechanism as it was at the time. The section
above is the current behaviour.

## Every CLI follows its latest release — 2026-11-21

- Every CLI layer is now keyed on its registry's latest-release metadata, the
  pattern Codex has used since 2026-09-23. Claude Code, OpenCode, OpenClaw,
  Hermes, Aider and Vibe used to refresh only when someone bumped
  `RUNNER_CLI_CACHE_BUST`, `OPENCODE_CLI_CACHE_BUST`, `AIDER_CLI_CACHE_BUST` or
  `VIBE_CLI_CACHE_BUST`. Prod ran Claude Code 2.1.319 (npm: 2.1.330), Codex
  0.167.0 (npm: 0.171.0) and Vibe 3.1.0 (PyPI: 3.1.4).
- The per-CLI version and cache-bust build arguments were removed from the
  Dockerfile, both Compose files and the `.env.example` files.
  `RUNNER_CLI_CACHE_BUST` remains, in the Dockerfile only, as a force-reinstall
  knob.
- The CLI block moved after the stable tooling and before the runner source.
  The first build after this change rebuilds every layer once.
- The image records its CLI versions in `/opt/runner-cli-versions.txt`.
- Codex's startup update check is disabled in each agent's `config.toml`, and
  the broker answers its update dialog with Esc instead of Down+Enter (see
  "Why runners never update themselves").
- The failed Hermes install no longer leaves `/root/.hermes` (~3 GB) in the image.

## Claude Code, Codex and OpenCode — 2026-11-02

`RUNNER_CLI_CACHE_BUST` and `OPENCODE_CLI_CACHE_BUST` bumped to `2026-11-02` so
cached image builds reinstall the latest CLIs. Codex follows npm `latest`
automatically (remote `ADD`). Versions observed on npm:

| CLI | Version |
| --- | --- |
| Claude Code | 2.1.316 |
| Codex | 0.166.0 |
| OpenCode | 1.19.5 |

Deployments that set `RUNNER_CLI_CACHE_BUST` in their `.env` must bump it there too.

## Codex: automatic latest release — 2026-09-23

Every runner image build now checks the npm `latest` metadata for `@openai/codex`
using a remote Dockerfile `ADD`. When that metadata changes, Docker invalidates
the Codex install layer and installs the version advertised by npm. An unchanged
release can reuse the existing installation. This applies to local Compose,
Swarm builds and direct `docker build` commands, without a manual cache-bust key.
See the [Docker ADD reference](https://docs.docker.com/reference/dockerfile/#adding-files-from-a-url).

The Codex installation runs after the other tools to preserve their build cache.
It verifies `codex --version` and fails the build if installation fails instead
of shipping a stub. `CODEX_CLI_VERSION` and `CODEX_CLI_CACHE_BUST` are no longer
used: Codex always follows the latest stable release. Rebuild and redeploy the
image to update running containers.

## Claude Code CLI — 2026-09-29

`RUNNER_CLI_CACHE_BUST` bumped to `2026-09-29` so cached image builds reinstall
`@anthropic-ai/claude-code@latest` (2.1.284 observed on npm) and expose the
newest Claude models (e.g. Sonnet 5.5) in the CLI's native model picker. Because
the Claude install is the first CLI layer, the other CLIs are refreshed too.

## Other runner CLIs — 2026-09-10

All runner images install the upstream latest CLIs at build time. Docker can
reuse those installation layers even when a newer package has been published.
`RUNNER_CLI_CACHE_BUST` now invalidates the first CLI installation layer and all
subsequent CLI layers, including Claude Code, OpenClaw and Hermes. It is forwarded
by both Compose configurations. Other CLIs retain their per-CLI version overrides.

Stable releases observed during this update:

| CLI | Version | Source |
| --- | --- | --- |
| Claude Code | 2.1.267 | https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest |
| Codex | 0.154.0 | https://registry.npmjs.org/@openai%2fcodex/latest |
| OpenCode | 1.18.30 | https://registry.npmjs.org/opencode-ai/latest |
| OpenClaw | 2026.9.3 | https://registry.npmjs.org/openclaw/latest |
| Aider | 0.86.2 | https://pypi.org/pypi/aider-chat/json |
| Hermes | v2026.9.7 | https://api.github.com/repos/NousResearch/hermes-agent/releases/latest |

These are upstream observations, not installed-version assertions. The next
image build resolves the latest packages again. Hermes retains its upstream
installer workflow, which follows the main branch.

OpenClaw 2026.9.3 declares Node `>=24.16.0 <25 || >=26.1.0`; the shared image now
uses NodeSource's Node 24 LTS channel instead of Node 22. See the
[OpenClaw Node requirements](https://docs.openclaw.ai/install/node).

Model selection remains native to each CLI and account. Explicit per-agent and
terminal selections are preserved. Obsolete Compose defaults and the runner's
hardcoded Sonnet 4 fallback were removed; they are not a reliable description of
the model actually selected by the CLI. Updating the CLI makes its current model
catalog available without overriding saved choices or assuming account access.
Current model references:

- [OpenAI models](https://developers.openai.com/api/docs/models)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude model catalog](https://platform.claude.com/docs/en/models/overview)

To refresh the other CLIs again, change `RUNNER_CLI_CACHE_BUST` when rebuilding the images.
Deploying rebuilt images is required to update running services; changing these
files alone does not upgrade existing containers.

## Mistral Vibe Code — 2026-10-19

New `vibe` runner (`RUNNER_TYPE=vibe`, service `vibe-service`) driving the
[Mistral Vibe](https://github.com/mistralai/mistral-vibe) CLI, installed from
PyPI (`mistral-vibe`, 2.26.1 at the time of writing) in its own virtualenv at
`/opt/vibe`. Pin with `VIBE_CLI_VERSION`, refresh with `VIBE_CLI_CACHE_BUST`.

- MCP servers, permissions and update checks go through Vibe's `VIBE_*`
  env-var config layer; `~/.vibe/config.toml` is left to the user.
- The model is chosen in the terminal (`/model`); `~/.vibe/{config.toml,.env}`
  persist across restarts.
- Base instructions are written to `~/.vibe/AGENTS.md`.
- API key: per-agent Mistral LLM config, else the key saved via
  `vibe --setup`, else the service-wide `MISTRAL_API_KEY`.
