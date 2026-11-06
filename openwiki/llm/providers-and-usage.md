---
type: architecture
title: LLM providers, budgets and usage
description: How the API resolves an agent's LLM configuration, the provider classes behind it, how an agent can be addressed as an OpenAI-compatible model, how tokens are counted for both native and terminal-driven agents, why budgets only alert, and how voice providers work.
tags: [llm, providers, usage, budget, voice, openai-compatible]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-572892db2afc2e539d1a1cb3
    resource: repo://api/src/routes/budget.ts
  - id: openwiki-source-7e8836c3ba6669f862a11137
    resource: repo://api/src/routes/internalTokenUsage.ts
  - id: openwiki-source-1b57f3ddc75bbf2d61002e17
    resource: repo://api/src/routes/llmApi.ts
  - id: openwiki-source-e026b90fbd025570c86f1cc7
    resource: repo://api/src/routes/voiceProxy.ts
  - id: openwiki-source-f8a3d4690858d2e0388d948d
    resource: repo://api/src/services/agentManager/index.ts
  - id: openwiki-source-b7974e5ed07fc00446f7e668
    resource: repo://api/src/services/llmCompletion.ts
  - id: openwiki-source-a9ea8f386cca43205c4e014b
    resource: repo://api/src/services/llmConversation.ts
  - id: openwiki-source-f146b0ce6fd91c56a44fe902
    resource: repo://api/src/services/llmProviders.ts
  - id: openwiki-source-84484b2aae00eb84ae1fe711
    resource: repo://runner-service/src/usage_watcher.py
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# LLM providers, budgets and usage

## Resolving an agent's model

An agent points to a stored LLM configuration through `llmConfigId`. `AgentManager.resolveLlmConfig` returns its provider, model, endpoint, key, limits and prices. Without a valid config, it returns empty provider and model values with the agent's own settings, and a runner then falls back to its built-in credentials.

Configurations are JSONB documents with an encrypted `apiKey`, loaded into memory at startup. Important fields include:

| Field | Effect |
|---|---|
| `managesContext` | The provider handles its own context, and also selects `claudecode` as the default runner when an agent has none |
| `contextSize` | Sets [compaction thresholds](../agents/agent-lifecycle-and-chat.md#compaction) |
| `maxOutputTokens`, `isReasoning`, `temperature`, `supportsImages` | Request shape |
| `costPerInputToken`, `costPerOutputToken` | Usage pricing, per million tokens |

## Providers

`createProvider` in `services/llmProviders.ts` is the factory:

| `provider` | Class | Notes |
|---|---|---|
| A CLI runner ID | `VLLMProvider` pointing at the runner service | The runner's HTTP API looks like an OpenAI endpoint |
| `anthropic`, `claude` | `ClaudeProvider` | `claude` is the legacy ID |
| `openai` | `OpenAIProvider` | Handles Responses API and reasoning models |
| `vllm` | `VLLMProvider` | Any OpenAI-compatible endpoint, including AIFabric |
| `ollama` | `OllamaProvider` | Retries, 10-minute connect and 5-minute idle timeouts, for slow model loading |
| `mistral` | `MistralProvider` | Extends `VLLMProvider` |
| `claude-paid` | `VLLMProvider` to the `claudecode` runner | Paid plan through the CLI |
| `decision` | **Rejected** | Decision models work only in [board decision actions](../tasks/workflow-engine.md), never as an agent's chat model |

All providers implement `chatStream`, used by `_consumeStream`, with native tool definitions from `nativeTools.ts`.

## Agents as an LLM API

`/api/llm/v1` lets other services use an agent as if it were a model. Requests need a key with the `llm` scope. `model` names the agent, by name or ID.

| Route | Shape |
|---|---|
| `GET /api/llm/v1/models` | Agents the key's owner may address |
| `POST /api/llm/v1/chat/completions` | OpenAI chat completions, one agent turn |
| `POST /api/llm/v1/conversations` | Mistral conversations, optionally with `web_search` |

The owner must have **edit** access to the agent, which is rechecked per request, so removing a board share stops the key at once. Limits are 20 calls per minute per key, since each call is a full agent turn, and 200,000 prompt characters.

**Getting a clean answer.** An agent's chat reply mixes prose with tool progress, so the agent is asked to write only its final answer to a file under `/tmp/pulsar-llm-api`, or to call the gateway's `submit_answer`. That file's content becomes the completion. If it's missing or empty, the chat reply is used instead.

With `web_search`, the listed sources are **captured server-side** from the agent's browser tool calls (`webCapture.ts`), never taken from what the agent wrote, so an agent cannot fabricate citations there.

A busy or disabled agent is answered with a `Retry-After` of 30 seconds.

## Token accounting

Usage goes to `token_usage_log`. There are two paths, and **a turn must use only one**, or it is counted twice, which has happened before:

| Path | When | How |
|---|---|---|
| Provider pipeline | HTTP chat turns, including `/v1/chat/completions` to a runner | `_recordUsage` in `AgentManager`, from the response's usage block |
| Runner reporting | Tasks injected into an interactive terminal | `runner-service/src/usage_watcher.py` tails the CLI's own transcripts and posts deltas to `/api/internal/token-usage` |

The terminal path exists because injected tasks produce no HTTP usage at all, and the budget screen read zero for those agents. The transcript dialects differ, and each has its own adapter:

- **Claude:** `~/.claude/projects/.../*.jsonl`. A rewritten line repeats cumulative usage, so a per-message ledger reports only the increment.
- **Codex:** `~/.codex/sessions/**/rollout-*.jsonl`. It reports cumulative totals, so the delta is computed from the last reported value.

A CLI update can change these formats, which would silently stop the counting.

**Pricing.** `_resolveUsageCost` prefers a config matching the model actually reported for the turn, then the agent's config. Rows from CLIs often have `model='unknown'`, so `llmVendor.ts` maps a provider or runner ID to a vendor name for charts. Cost for subscription-backed CLIs reflects these estimates, not an invoice.

## Budgets only alert

**Budgets do not stop anything.** `budget_config`, with its daily, monthly and per-project limits, is read only in `routes/budget.ts`, which reports spending and computes alerts. Neither the chat path nor the workflow engine consults it, so agents continue past a limit.

Only admins can change the config. Non-admins see their own agents' usage. To enforce spending limits, you would need to add a check on the turn path.

The "budget" in `ToolBudgetReachedError` and "output budget" in `chat.ts` are unrelated: they refer to tool rounds and output tokens.

## Voice

There are two modes (see `docs/voice-providers.md`, in French):

**Realtime** uses the agent's LLM config:

| Provider | Default model | Transport | Default voice |
|---|---|---|---|
| `openai` | `gpt-realtime-2` | WebRTC | `alloy` |
| `google`, `gemini` | `gemini-3.1-flash-live-preview` | Gemini Live WebSocket | `Kore` |

Permanent keys stay on the API. `/api/realtime/token` checks write access to the agent and returns a short-lived session. The browser's adapters are in `frontend/src/lib/voice`. Voice agents have tools such as `delegate`, defined in `services/voice/config.ts`.

**External voice** bridges the browser to the operator's STT and TTS services through `/ws/voice/{stt,tts}/:agentId`. The audio passes through the API so that the provider key **never reaches a browser**: an earlier design put it in WebSocket URLs readable from developer tools. These WebSocket upgrades are not visible to the route inventory test, so they carry their own checks of origin, session and agent access.

If the microphone is blocked, check the `Permissions-Policy` header set in the Swarm Traefik labels, and whether the page is on HTTPS.
