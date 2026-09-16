"""
Token accounting for the shared interactive terminal.

A task assigned to a CLI-runner agent is *injected into the agent's shared
PTY* (see routes_terminal), not sent through `/v1/chat/completions` — so
team-api never sees a `usage` block for it and the budget screen read exactly
zero for every terminal-driven Claude Code / Codex / … agent, no matter how
many millions of tokens the CLI burned.

The CLIs do keep their own accounting, though: each appends a JSONL session
transcript under the agent's HOME with per-turn token counts. This module
tails those transcripts for as long as the PTY session lives and pushes the
deltas to team-api through `usage_reporter`.

Two transcript dialects, one adapter each:

  claude — ``<home>/.claude/projects/<cwd-slug>/<session>.jsonl``; every
           ``assistant`` line carries ``message.usage``. Appended lines are
           NOT simply the delta: the CLI rewrites a line when a turn is
           amended, and the rewritten copy repeats that message's cumulative
           usage, so each message id keeps a ledger of what it was already
           billed and only the increment is reported.
  codex  — ``<home>/.codex/sessions/**/rollout-*.jsonl``; ``token_count``
           events carry a *cumulative* ``info.total_token_usage``, so the
           delta is (latest cumulative − last cumulative reported).

Only bytes appended after the watcher started are ever billed: the first pass
baselines each file (cursor + codex's cumulative counter + claude's message
ledger) without reporting, so restarting the terminal never re-bills the
history — and a historical turn amended later bills only what it added.
If an existing Codex baseline cannot be recovered, the first later cumulative
counter only seeds accounting. This may omit new usage up to that counter,
but never charges an unknown amount of historical usage.

Both adapters share one cursor rule: advance to the end of the last COMPLETE
record actually consumed (see jsonl_tail), never to the file size sampled
before the read. A turn caught half-written is re-read whole next poll instead
of being skipped, and bytes that landed mid-read are never counted twice.

Everything here is best-effort — accounting must not be able to break a
terminal session.
"""

from __future__ import annotations

import asyncio
import json
import os
from glob import glob
from typing import Optional

from config import logger
from jsonl_tail import read_records
from usage_reporter import report_usage

try:
    USAGE_WATCH_INTERVAL_SEC = float(os.environ.get("USAGE_WATCH_INTERVAL_SEC", "20"))
except ValueError:
    USAGE_WATCH_INTERVAL_SEC = 20.0

# Transcripts of a busy agent grow without bound; cap what one baseline pass
# will read back when seeding a per-file counter.
_MAX_BASELINE_BYTES = 32 * 1024 * 1024
_BASELINE_BLOCK_BYTES = 64 * 1024
# Ceiling on the per-transcript message ledger (see _claude_ledger).
_MAX_TRACKED_MESSAGES = 5000


def _as_int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


# ── claude-code transcripts ─────────────────────────────────────────────────


def _claude_globs(root: str) -> list[str]:
    return [os.path.join(root, ".claude", "projects", "*", "*.jsonl")]


def _claude_ledger(memo: dict, path: str) -> dict:
    """Per-transcript ledger of what each message id has already been billed.

    Bounded: a long-lived session appends message ids without end, and the
    watcher outlives the turns it accounts for. Evicting the oldest ids is safe
    — Claude amends the turn it is writing, not one thousands of messages back.
    """
    ledger = memo.get(path)
    if not isinstance(ledger, dict):
        ledger = {}
        memo[path] = ledger
    if len(ledger) > _MAX_TRACKED_MESSAGES:
        for stale in list(ledger)[: len(ledger) - _MAX_TRACKED_MESSAGES]:
            ledger.pop(stale, None)
    return ledger


def _claude_baseline(path: str, size: int, memo: dict) -> None:
    """Mark the messages already in the transcript as billed.

    Only their identity and counters are kept — never their content — so a
    historical turn that the CLI later amends bills its increment instead of
    its whole cumulative usage.
    """
    if size <= 0 or size > _MAX_BASELINE_BYTES:
        return
    from backends.claude_usage import seed_ledger

    seed_ledger(path, _claude_ledger(memo, path), _MAX_BASELINE_BYTES)


def _claude_delta(path: str, offset: int, memo: dict) -> tuple[dict, int]:
    """Unbilled tokens recorded in `path` after byte `offset`, and the cursor.

    Not simply "the new lines": the CLI rewrites an assistant line when a turn
    is amended, so the same message can arrive in several polls carrying its
    cumulative usage. The ledger turns that stream into increments.
    """
    from backends.claude_usage import usage_delta_since

    return usage_delta_since(path, offset, _claude_ledger(memo, path))


# ── codex rollout transcripts ───────────────────────────────────────────────


def _codex_globs(root: str) -> list[str]:
    sessions = os.path.join(root, ".codex", "sessions")
    # Codex buckets rollouts by yyyy/mm/dd; glob a few depths rather than
    # walking, so an unexpected layout simply yields nothing.
    return [
        os.path.join(sessions, "*.jsonl"),
        os.path.join(sessions, "*", "*.jsonl"),
        os.path.join(sessions, "*", "*", "*.jsonl"),
        os.path.join(sessions, "*", "*", "*", "*.jsonl"),
    ]


def _codex_find_token_count(entry) -> Optional[dict]:
    """Return the `token_count` message inside a rollout line, if any.

    Rollout lines wrap the live event stream, and the wrapper shape has moved
    around across codex versions (`{"type":"event_msg","payload":{...}}`,
    `{"msg":{...}}`, or the bare message). Look through the handful of known
    containers instead of pinning one.
    """
    if not isinstance(entry, dict):
        return None
    for candidate in (entry, entry.get("payload"), entry.get("msg"), entry.get("item")):
        if isinstance(candidate, dict) and candidate.get("type") == "token_count":
            return candidate
    return None


def _codex_cumulative(msg: dict) -> Optional[dict]:
    """Cumulative session totals carried by one `token_count` message."""
    from backends.codex import _usage_totals

    info = msg.get("info")
    if isinstance(info, dict):
        return _usage_totals(info.get("total_token_usage"))
    return _usage_totals(msg)


def _codex_scan(path: str, start: int, *, tail: bool = True) -> tuple[Optional[dict], int]:
    """Last cumulative total recorded at or after byte `start`, and the cursor.

    Shares the complete-line cursor with the claude adapter: a `token_count`
    event caught half-written must be re-read next poll, not stepped over.
    """
    latest: Optional[dict] = None
    entries, cursor = read_records(path, start, tail=tail)
    for entry in entries:
        msg = _codex_find_token_count(entry)
        if msg is None:
            continue
        cumulative = _codex_cumulative(msg)
        if cumulative:
            latest = cumulative
    return latest, cursor


def _codex_baseline(path: str, size: int, memo: dict) -> None:
    """Seed the per-file cumulative counter so pre-existing history is never
    billed. Search backwards in growing blocks, bounded by the read budget
    and the captured EOF. None explicitly means an unknown baseline, including
    stat/read failures, missing counters, and counters outside the search window.
    """
    memo[path] = None
    if size <= 0:
        return
    cursor = size
    lower_bound = max(0, size - _MAX_BASELINE_BYTES)
    block_size = _BASELINE_BLOCK_BYTES
    pending = b""
    try:
        with open(path, "rb") as fh:
            while cursor > lower_bound:
                count = min(block_size, cursor - lower_bound)
                cursor -= count
                fh.seek(cursor)
                block = fh.read(count)
                if len(block) != count:  # File shrank after the size snapshot.
                    return
                lines = (block + pending).split(b"\n")
                # A block can start inside a JSON record (or a UTF-8 character).
                # Keep that prefix for the next block; never parse it alone.
                pending = lines.pop(0) if cursor else b""
                for line in reversed(lines):
                    try:
                        entry = json.loads(line)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    msg = _codex_find_token_count(entry)
                    cumulative = _codex_cumulative(msg) if msg else None
                    if cumulative is not None:
                        memo[path] = cumulative
                        return
                block_size *= 2
    except OSError as e:
        logger.debug(f"[Usage] unreadable codex baseline {path}: {e}")


def _codex_delta(path: str, offset: int, memo: dict) -> tuple[dict, int]:
    cumulative, cursor = _codex_scan(path, offset)
    if not cumulative:
        return {}, cursor
    previous = memo.get(path)
    memo[path] = cumulative
    if previous is None:
        # Unknown is not zero: establish a reference without billing history.
        return {}, cursor
    delta = {
        "input_tokens": max(0, cumulative["input_tokens"] - _as_int(previous.get("input_tokens"))),
        "output_tokens": max(
            0, cumulative["output_tokens"] - _as_int(previous.get("output_tokens"))
        ),
    }
    return delta, cursor


_ADAPTERS = {
    "claude": (_claude_globs, _claude_delta, _claude_baseline),
    "codex": (_codex_globs, _codex_delta, _codex_baseline),
}


class UsageWatcher:
    """Tails an agent's CLI transcripts and reports the token deltas.

    Build one per PTY session (`kind` selects the transcript dialect, `root`
    is the agent's HOME), call `baseline()` before the CLI runs anything, then
    `run()` it as a background task. `poll_once()` is the unit under test.
    """

    def __init__(
        self,
        agent_id: str,
        kind: str,
        root: str,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.agent_id = agent_id
        self.kind = kind
        self.root = root
        self.provider = provider or kind
        self.model = model or ""
        self._offsets: dict[str, int] = {}
        self._memo: dict[str, Optional[dict]] = {}
        adapter = _ADAPTERS.get(kind)
        self._globs, self._delta, self._baseline = adapter if adapter else (None, None, None)

    @property
    def supported(self) -> bool:
        return self._globs is not None and bool(self.root)

    def _files(self) -> list[str]:
        found: list[str] = []
        for pattern in self._globs(self.root):
            try:
                found.extend(glob(pattern))
            except OSError:
                continue
        return found

    @staticmethod
    def _size(path: str) -> int:
        try:
            return os.path.getsize(path)
        except OSError:
            return 0

    def baseline(self) -> None:
        """Mark everything already on disk as already-billed."""
        if not self.supported:
            return
        for path in self._files():
            size = self._size(path)
            self._offsets[path] = size
            if self._baseline:
                self._baseline(path, size, self._memo)

    def collect(self) -> dict:
        """Sum the token deltas across every transcript and advance the
        cursors. Returns ``{"input_tokens", "output_tokens"}``."""
        totals = {"input_tokens": 0, "output_tokens": 0}
        if not self.supported:
            return totals
        for path in self._files():
            size = self._size(path)
            offset = self._offsets.get(path)
            if offset is None:
                # A file that appeared after baseline() — bill it whole.
                offset = 0
                if self._baseline:
                    # Only files first seen after baseline have a known zero.
                    self._memo[path] = {}
            if size < offset:
                # Truncated/replaced underneath us — restart from the top.
                offset = 0
                self._memo.pop(path, None)
            elif size == offset:
                continue
            try:
                delta, cursor = self._delta(path, offset, self._memo)
            except Exception as e:  # never let accounting break the session
                logger.debug(f"[Usage] transcript scan failed for {path}: {e}")
                delta, cursor = {}, offset
            # The adapter reports what it actually consumed, which is NOT the
            # size we sampled: it stops at the last complete line (a turn
            # caught half-written stays unread until it is whole) and it may
            # run past `size` when the CLI appended while we were reading
            # (those bytes are consumed now, not re-read next poll).
            self._offsets[path] = max(offset, _as_int(cursor))
            totals["input_tokens"] += _as_int((delta or {}).get("input_tokens"))
            totals["output_tokens"] += _as_int((delta or {}).get("output_tokens"))
        return totals

    async def poll_once(self) -> bool:
        """One scan + report. Returns True when usage was reported."""
        if not self.supported:
            return False
        loop = asyncio.get_running_loop()
        totals = await loop.run_in_executor(None, self.collect)
        if not totals["input_tokens"] and not totals["output_tokens"]:
            return False
        return await report_usage(
            self.agent_id,
            input_tokens=totals["input_tokens"],
            output_tokens=totals["output_tokens"],
            provider=self.provider,
            model=self.model,
        )

    async def run(self, closed) -> None:
        """Poll until the session closes, then do a final pass so the tokens
        of the last turn are not lost with the session."""
        try:
            while not closed():
                try:
                    await asyncio.sleep(USAGE_WATCH_INTERVAL_SEC)
                except asyncio.CancelledError:
                    return
                try:
                    await self.poll_once()
                except Exception as e:
                    logger.debug(f"[Usage] watcher tick failed for {self.agent_id}: {e}")
        except Exception as e:
            logger.warning(f"[Usage] watcher loop crashed for {self.agent_id}: {e}")


def build_watcher(agent_id: str, spec: Optional[dict]) -> Optional[UsageWatcher]:
    """Instantiate the watcher described by a backend's `usage_watch` recipe
    entry: ``{"kind": "claude"|"codex", "root": "<agent HOME>", …}``."""
    if not agent_id or not isinstance(spec, dict):
        return None
    watcher = UsageWatcher(
        agent_id,
        kind=str(spec.get("kind") or ""),
        root=str(spec.get("root") or ""),
        provider=spec.get("provider"),
        model=spec.get("model"),
    )
    return watcher if watcher.supported else None
