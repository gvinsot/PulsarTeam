# Runner CLI refresh

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
