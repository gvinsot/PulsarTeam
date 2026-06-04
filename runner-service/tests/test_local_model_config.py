"""Verify that a selected local / OpenAI-compatible model is actually wired
into the agent's spawn environment for every CLI backend.

These guard against the silent-fallback class of bug where an agent is
configured for a local vLLM/LM Studio model but the runner spawns the CLI with
no endpoint/credentials, so it quietly talks to the cloud default instead.
"""
import os
import sys
from pathlib import Path


os.environ.setdefault("RUNNER_TYPE", "openclaw")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from backends.cli_backend import CliBackend, OPENAI_COMPATIBLE_LOCAL_PROVIDERS


class _Probe(CliBackend):
    """Minimal concrete backend so we can exercise the base env wiring."""

    name = "probe"
    cli_command = "probe"


def _env_for(provider, model="my-local-model", endpoint="http://localhost:8000/v1", api_key=None):
    backend = _Probe()
    cfg = {"provider": provider, "model": model, "endpoint": endpoint}
    if api_key is not None:
        cfg["apiKey"] = api_key
    backend.set_agent_llm_config("agent", cfg)
    return backend._agent_env({"home": "/tmp/agent", "username": "agent"}, "agent")


def test_vllm_endpoint_sets_openai_base_url():
    env = _env_for("vllm")
    assert env["OPENAI_BASE_URL"] == "http://localhost:8000/v1"
    assert env["OPENAI_API_BASE"] == "http://localhost:8000/v1"


def test_local_provider_without_key_gets_placeholder_key():
    # OpenAI SDK refuses to start without a key even when the server ignores it.
    env = _env_for("openai-compatible", api_key=None)
    assert env.get("OPENAI_API_KEY") == "sk-local"


def test_local_provider_with_key_is_preserved():
    env = _env_for("lmstudio", api_key="real-key")
    assert env["OPENAI_API_KEY"] == "real-key"
    assert env["OPENAI_BASE_URL"] == "http://localhost:8000/v1"


def test_all_known_local_providers_route_to_openai_base_url():
    for provider in OPENAI_COMPATIBLE_LOCAL_PROVIDERS:
        env = _env_for(provider)
        assert env.get("OPENAI_BASE_URL"), f"{provider} did not set OPENAI_BASE_URL"


def test_ollama_endpoint_sets_host_and_openai_compat():
    backend = _Probe()
    backend.set_agent_llm_config("agent", {
        "provider": "ollama", "model": "llama3", "endpoint": "http://localhost:11434",
    })
    env = backend._agent_env({"home": "/tmp/agent", "username": "agent"}, "agent")
    assert env["OLLAMA_HOST"] == "http://localhost:11434"
    assert env["OPENAI_BASE_URL"] == "http://localhost:11434/v1"
    assert env["OPENAI_API_KEY"] == "ollama"


def test_openclaw_passes_agent_id_so_local_creds_are_injected():
    # The historical bug: openclaw called _agent_env WITHOUT agent_id, so no
    # provider credentials/endpoint reached the spawn. Verify the env now
    # carries the local model wiring.
    os.environ["RUNNER_TYPE"] = "openclaw"
    from backends.openclaw import OpenClawBackend, _resolve_openclaw_model

    backend = OpenClawBackend()
    backend.set_agent_llm_config("agent", {
        "provider": "vllm", "model": "qwen-local", "endpoint": "http://localhost:8000/v1",
        "apiKey": "k",
    })
    env = backend._agent_env({"home": "/tmp/agent", "username": "agent"}, "agent")
    assert env["OPENAI_BASE_URL"] == "http://localhost:8000/v1"
    assert env["OPENAI_API_KEY"] == "k"
    assert env["OPENCLAW_MODEL"] == "qwen-local"
    assert _resolve_openclaw_model({"model": "qwen-local"}) == "qwen-local"


def test_hermes_maps_local_provider_to_auto():
    os.environ["RUNNER_TYPE"] = "hermes"
    from backends.hermes import _PROVIDER_TO_HERMES, _resolve_hermes_provider_and_model

    for provider in OPENAI_COMPATIBLE_LOCAL_PROVIDERS:
        assert _PROVIDER_TO_HERMES.get(provider) == "auto", provider

    provider, model = _resolve_hermes_provider_and_model(
        {"provider": "vllm", "model": "qwen"}
    )
    assert provider == "auto"
    assert model == "qwen"
