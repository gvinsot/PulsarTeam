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
        # Per-agent session IDs for backends that support session resume
        self._sessions: dict[str, str] = {}

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
            return {"type": "text", "content": line}

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

    # ── Sessions ──────────────────────────────────────────────────────────

    def reset_agent_sessions(self, agent_id: str, task_id: Optional[str] = None) -> int:
        removed = 0
        if not agent_id:
            return removed
        if task_id:
            key = f"{agent_id}:{task_id}"
            if key in self._sessions:
                self._sessions.pop(key)
                removed += 1
        if agent_id in self._sessions:
            self._sessions.pop(agent_id)
            removed += 1
        if not task_id:
            for k in [k for k in self._sessions if k.startswith(f"{agent_id}:")]:
                self._sessions.pop(k)
                removed += 1
        return removed

    # ── Common helpers ────────────────────────────────────────────────────

    def _agent_env(self, agent_user: Optional[dict]) -> dict:
        env = {**os.environ}
        if agent_user:
            env["HOME"] = agent_user["home"]
            env["USER"] = agent_user["username"]
            env["LOGNAME"] = agent_user["username"]
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
    ) -> dict:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        cwd = self._resolve_cwd(agent_id)
        permissions = self._get_permissions(agent_id)

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
                env=self._agent_env(agent_user),
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
    ) -> AsyncIterator[dict]:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        cwd = self._resolve_cwd(agent_id)
        permissions = self._get_permissions(agent_id)

        cmd = self._build_command(prompt, stream=True, system_prompt=system_prompt, agent_id=agent_id, task_id=task_id, permissions=permissions)
        logger.info(f"Streaming {self.cli_command}: {prompt[:100]}...")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if self.pass_prompt_via_stdin else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=self._agent_env(agent_user),
            limit=10 * 1024 * 1024,
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
                line = line.decode("utf-8", errors="replace").strip()
                if not line:
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
