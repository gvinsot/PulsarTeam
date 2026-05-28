"""
Generic CLI backend — base class for runners driven by a CLI tool.

Subclasses configure:
  - cli_command: the executable name
  - pass_prompt_via_stdin: whether the prompt goes via stdin or as a CLI arg
  - _build_command(): full subprocess args (including prompt if not via stdin)
  - _parse_sync_result() / _parse_stream_event(): output format adapters
"""

import os
import json
import asyncio
import subprocess
from typing import AsyncIterator, Optional

from config import (
    RUNNER_MODEL, CLI_CWD, TIMEOUT, PROJECTS_DIR, VERBOSE, logger,
)
from agent_user import get_agent_project_dir, ensure_agent_user
from .base import RunnerBackend
from .claude_token_store import get_subprocess_kwargs


class CliBackend(RunnerBackend):
    """Base class for CLI-driven runners.

    Override `cli_command`, `pass_prompt_via_stdin`, and `_build_command`
    in subclasses. Optionally override `_parse_sync_result` /
    `_parse_stream_event` to adapt to the CLI's output format.
    """

    cli_command: str = ""
    pass_prompt_via_stdin: bool = True
    supports_agent: bool = True
    supports_oauth_login: bool = False
    supports_token_set: bool = True

    def __init__(self):
        self._permissions: dict[str, dict] = {}
        self._llm_configs: dict[str, dict] = {}

    # ── Hooks subclasses override ─────────────────────────────────────────

    def _build_command(
        self,
        prompt: str,
        stream: bool,
        system_prompt: Optional[str],
        agent_id: Optional[str],
        task_id: Optional[str],
        permissions: Optional[dict],
    ) -> list[str]:
        """Return the full subprocess args.

        If `pass_prompt_via_stdin` is True, the prompt should NOT be in
        the returned list — base class will pipe it via stdin.
        Otherwise the subclass is responsible for embedding the prompt
        as an argument (e.g. `--message <prompt>`).
        """
        raise NotImplementedError

    def _parse_sync_result(self, stdout: str) -> dict:
        """Parse the CLI's --json (or equivalent) output into a result dict.

        Default tries the Claude-code shape: {result, cost_usd, usage:{input_tokens,output_tokens}}.
        Falls back to raw stdout.
        """
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError:
            return {"status": "success", "output": stdout}
        output_text = parsed.get("result") or parsed.get("output") or parsed.get("message") or stdout
        usage = parsed.get("usage", {}) or {}
        input_tokens = usage.get("input_tokens", 0) or 0
        output_tokens = usage.get("output_tokens", 0) or 0
        return {
            "status": "success",
            "output": output_text,
            "cost_usd": parsed.get("cost_usd"),
            "duration_ms": parsed.get("duration_ms"),
            "total_tokens": parsed.get("total_tokens") or (input_tokens + output_tokens),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    def _parse_stream_event(self, line: str) -> Optional[dict]:
        """Parse a stream output line into a canonical event.

        Default assumes JSON-per-line in Claude-code's stream-json format.
        Returns None to skip the event. Returns a dict with "type" set to
        one of: text, thinking, status, result, error.
        """
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # Preserve a line break so multi-line plain-text CLI output (banners,
            # error messages) is not collapsed into a single space-less blob
            # when chunks are concatenated by the OpenAI-stream consumer.
            return {"type": "text", "content": line + "\n"}

        event_type = event.get("type", "")
        if event_type == "assistant":
            content = event.get("message", {}).get("content", "")
            if isinstance(content, str) and content:
                return {"type": "text", "content": content}
            # List of blocks — return as-is so caller iterates
            if isinstance(content, list):
                return {"type": "_blocks", "blocks": content}
        elif event_type == "result":
            usage = event.get("usage", {}) or {}
            return {
                "type": "result",
                "content": event.get("result", "") or "",
                "cost_usd": event.get("cost_usd", 0),
                "duration_ms": event.get("duration_ms", 0),
                "total_tokens": event.get("total_tokens", 0) or (usage.get("input_tokens", 0) + usage.get("output_tokens", 0)),
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
            }
        elif event_type in ("text", "thinking", "status", "error"):
            return event
        return None

    def set_agent_permissions(self, agent_id: str, permissions: dict) -> None:
        if agent_id and permissions:
            self._permissions[agent_id] = permissions

    def _get_permissions(self, agent_id: Optional[str]) -> Optional[dict]:
        return self._permissions.get(agent_id) if agent_id else None

    def set_agent_llm_config(self, agent_id: str, llm_config: dict) -> None:
        if agent_id and llm_config:
            self._llm_configs[agent_id] = llm_config

    def _get_llm_config(self, agent_id: Optional[str]) -> Optional[dict]:
        return self._llm_configs.get(agent_id) if agent_id else None

    def _resolve_effective_user(
        self, agent_id: Optional[str], agent_user: Optional[dict],
    ) -> Optional[dict]:
        """Honor the linuxUser.runAsRoot toggle.

        When the toggle is on, return None so the spawn inherits the parent
        process UID (root in our deployment). When off (default), keep the
        dedicated per-agent UID resolved by ensure_agent_user.
        """
        perms = self._get_permissions(agent_id) or {}
        run_as_root = bool((perms.get("linuxUser") or {}).get("runAsRoot", False))
        if run_as_root:
            if agent_user:
                logger.info(
                    f"[Agent {agent_id[:12] if agent_id else 'unknown'}] "
                    "linuxUser.runAsRoot=true — spawning as root (UID drop disabled)"
                )
            return None
        return agent_user

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def startup(self) -> None:
        logger.info(f"{self.name} backend starting...")
        logger.info(f"  CLI: {self.cli_command}")
        logger.info(f"  Model: {RUNNER_MODEL}")
        logger.info(f"  Timeout: {TIMEOUT}s")
        try:
            result = subprocess.run([self.cli_command, "--version"], capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                logger.info(f"  {self.cli_command} version: {result.stdout.strip()}")
            else:
                logger.error(f"  {self.cli_command} error: {result.stderr.strip()}")
        except FileNotFoundError:
            logger.error(f"  {self.cli_command} not found on PATH")
        except Exception as e:
            logger.error(f"  {self.cli_command} version check failed: {e}")

    def health(self) -> dict:
        try:
            result = subprocess.run([self.cli_command, "--version"], capture_output=True, text=True, timeout=10)
            ok = result.returncode == 0
            version = result.stdout.strip() if ok else None
        except Exception:
            ok = False
            version = None
        return {
            "status": "healthy" if ok else "degraded",
            "backend": self.name,
            "cli": self.cli_command,
            "cli_version": version,
            "model": RUNNER_MODEL,
        }

    # ── Common helpers ────────────────────────────────────────────────────

    def _agent_env(self, agent_user: Optional[dict], agent_id: Optional[str] = None) -> dict:
        from command_security import sanitize_env
        env = sanitize_env(os.environ, agent_user)
        llm = self._get_llm_config(agent_id) if agent_id else None
        if llm:
            api_key = (llm.get("apiKey") or llm.get("api_key") or "").strip()
            provider = (llm.get("provider") or "").lower().strip()
            if api_key:
                # Expose the agent's API key under the env-var name expected by
                # each provider's official SDK. opencode / openclaw read these
                # automatically when no auth.json is present.
                if provider in ("anthropic", "claude"):
                    env["ANTHROPIC_API_KEY"] = api_key
                elif provider == "openai":
                    env["OPENAI_API_KEY"] = api_key
                elif provider == "mistral":
                    env["MISTRAL_API_KEY"] = api_key
                elif provider == "google" or provider == "gemini":
                    env["GOOGLE_API_KEY"] = api_key
                elif provider == "groq":
                    env["GROQ_API_KEY"] = api_key
        return env

    def _resolve_cwd(self, agent_id: Optional[str]) -> str:
        agent_project_dir = get_agent_project_dir(agent_id) if agent_id else None
        if agent_project_dir and os.path.isdir(agent_project_dir):
            return agent_project_dir
        return CLI_CWD

    # ── Sync execution ────────────────────────────────────────────────────

    async def run_sync(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        messages: Optional[list] = None,
    ) -> dict:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        cwd = self._resolve_cwd(agent_id)
        permissions = self._get_permissions(agent_id)
        effective_user = self._resolve_effective_user(agent_id, agent_user)

        cmd = self._build_command(prompt, stream=False, system_prompt=system_prompt, agent_id=agent_id, task_id=task_id, permissions=permissions)
        logger.info(f"Executing {self.cli_command}: {prompt[:100]}...")
        logger.debug(f"Command: {' '.join(cmd)} (cwd={cwd})")

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE if self.pass_prompt_via_stdin else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=self._agent_env(effective_user, agent_id),
                **get_subprocess_kwargs(effective_user),
            )
            stdin_input = prompt.encode("utf-8") if self.pass_prompt_via_stdin else None
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=stdin_input),
                timeout=TIMEOUT,
            )
        except asyncio.TimeoutError:
            return {"status": "timeout", "output": "", "error": f"Execution timeout after {TIMEOUT}s"}

        stdout = stdout_bytes.decode("utf-8", errors="replace").strip()
        stderr = stderr_bytes.decode("utf-8", errors="replace").strip()

        if proc.returncode != 0 and not stdout:
            return {"status": "error", "output": "", "error": stderr or f"{self.cli_command} exited with code {proc.returncode}"}

        return self._parse_sync_result(stdout)

    # ── Streaming ─────────────────────────────────────────────────────────

    async def stream_events(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        messages: Optional[list] = None,
    ) -> AsyncIterator[dict]:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        cwd = self._resolve_cwd(agent_id)
        permissions = self._get_permissions(agent_id)
        effective_user = self._resolve_effective_user(agent_id, agent_user)

        cmd = self._build_command(prompt, stream=True, system_prompt=system_prompt, agent_id=agent_id, task_id=task_id, permissions=permissions)
        logger.info(f"Streaming {self.cli_command}: {prompt[:100]}...")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if self.pass_prompt_via_stdin else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=self._agent_env(effective_user),
            limit=10 * 1024 * 1024,
            **get_subprocess_kwargs(effective_user),
        )
        if self.pass_prompt_via_stdin:
            try:
                proc.stdin.write(prompt.encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()
            except BrokenPipeError:
                pass

        try:
            async for line in proc.stdout:
                # Preserve internal whitespace; only strip the line terminator
                # so that plain-text fallbacks emitted by the CLI keep their
                # spacing when concatenated downstream.
                line = line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line or not line.strip():
                    continue
                event = self._parse_stream_event(line)
                if not event:
                    continue
                # Expand "_blocks" container into individual events
                if event.get("type") == "_blocks":
                    for block in event.get("blocks", []):
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type")
                        if btype == "thinking":
                            yield {"type": "thinking", "content": block.get("thinking", "")}
                        elif btype == "text":
                            yield {"type": "text", "content": block.get("text", "")}
                        elif btype == "tool_use":
                            yield {"type": "status", "content": f"Using tool: {block.get('name', 'unknown')}"}
                else:
                    yield event
        finally:
            try:
                await proc.wait()
            except asyncio.CancelledError:
                pass

        if proc.returncode != 0:
            stderr_bytes = await proc.stderr.read()
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
            if stderr_text:
                yield {"type": "error", "content": stderr_text}
