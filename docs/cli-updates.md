# Runner CLI refresh — 2026-09-10

All runner images install the upstream latest CLIs at build time. Docker can
reuse those installation layers even when a newer package has been published.
`RUNNER_CLI_CACHE_BUST` now invalidates the first CLI installation layer and all
subsequent CLI layers, including Claude Code, OpenClaw and Hermes. It is forwarded
by both Compose configurations. Existing per-CLI version overrides remain valid.

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

To refresh again, change `RUNNER_CLI_CACHE_BUST` when rebuilding the images.
Deploying rebuilt images is required to update running services; changing these
files alone does not upgrade existing containers.
