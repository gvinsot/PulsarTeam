"""
Token accounting for the Claude Code CLI.

The claudecode backend drives the real TUI through a PTY (that is the whole
point: subscription pricing instead of API pricing), so there is no
`--output-format json` envelope to read `usage` from. Both `run_sync` and
`stream_events` therefore used to hand back a hard-coded
`{"input_tokens": 0, "output_tokens": 0, "cost_usd": 0}` result, which made
every Claude-runner turn look free and left the budget screen reading zero.

The CLI does record its usage though: every assistant turn is appended as one
JSONL line to the session transcript

    $CLAUDE_CONFIG_DIR (or $HOME/.claude)/projects/<cwd-slug>/<session-id>.jsonl

and each `assistant` line carries `message.usage` with `input_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens` and `output_tokens`.

Because the backend passes an explicit `--session-id` / `--resume <id>`, the
transcript path is deterministic. We snapshot the file size *before* the spawn
and only read the bytes appended by this run, so a resumed session reports the
tokens of that turn instead of re-reporting the whole conversation on every
message.

All helpers are defensive: usage accounting must never break a run, so every
failure degrades to "no usage reported" rather than raising.
"""

from __future__ import annotations

import os
import re
from glob import glob
from typing import Optional

from jsonl_tail import read_records


def _config_dir(env: Optional[dict], home: Optional[str]) -> Optional[str]:
    """Root of the Claude CLI state dir for the user the CLI ran as."""
    env = env or {}
    explicit = env.get("CLAUDE_CONFIG_DIR")
    if explicit:
        return explicit
    base = home or env.get("HOME")
    return os.path.join(base, ".claude") if base else None


def _cwd_slug(cwd: str) -> str:
    """Claude Code names its per-project transcript dir after the absolute cwd
    with every non-alphanumeric character replaced by a dash
    (`/srv/projects/my.app` → `-srv-projects-my-app`)."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd or "")


def transcript_path(
    session_id: Optional[str],
    cwd: Optional[str] = None,
    env: Optional[dict] = None,
    home: Optional[str] = None,
) -> Optional[str]:
    """Absolute path of the JSONL transcript for `session_id`, or None.

    The slug-derived path is tried first; if the CLI resolved its cwd
    differently (symlinks, `--add-dir`, …) we fall back to globbing every
    project dir for the session file, which is slug-rule independent.
    """
    if not session_id:
        return None
    root = _config_dir(env, home)
    if not root:
        return None
    projects = os.path.join(root, "projects")
    if cwd:
        direct = os.path.join(projects, _cwd_slug(cwd), f"{session_id}.jsonl")
        if os.path.isfile(direct):
            return direct
    try:
        matches = glob(os.path.join(projects, "*", f"{session_id}.jsonl"))
    except OSError:
        return None
    if matches:
        return matches[0]
    # Not written yet (pre-spawn snapshot): return the slug path so the caller
    # can still record a 0 baseline for a file that is about to be created.
    if cwd:
        return os.path.join(projects, _cwd_slug(cwd), f"{session_id}.jsonl")
    return None


def transcript_offset(path: Optional[str]) -> int:
    """Byte size of the transcript right now — the baseline to read from after
    the run. 0 when the file does not exist yet."""
    if not path:
        return 0
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _usage_of(entry: dict) -> Optional[dict]:
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    return usage if isinstance(usage, dict) else None


def _as_int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _assistant_record(entry: dict) -> Optional[tuple[Optional[str], dict]]:
    """`(message id, {input_tokens, output_tokens, cost_usd})` for an assistant
    transcript line, or None for any other line.

    Input tokens include the cache-creation and cache-read counts: they are
    real context tokens the turn consumed, and leaving them out is what makes
    a Claude Code turn look ~100x cheaper than it is (the uncached
    `input_tokens` of a cached turn is typically a handful of tokens).
    """
    if not isinstance(entry, dict) or entry.get("type") != "assistant":
        return None
    usage = _usage_of(entry)
    if not usage:
        return None
    record = {
        "input_tokens": (
            _as_int(usage.get("input_tokens"))
            + _as_int(usage.get("cache_creation_input_tokens"))
            + _as_int(usage.get("cache_read_input_tokens"))
        ),
        "output_tokens": _as_int(usage.get("output_tokens")),
        "cost_usd": float(entry.get("costUSD") or 0.0),
    }
    msg_id = (entry.get("message") or {}).get("id")
    return (msg_id if isinstance(msg_id, str) and msg_id else None), record


def usage_since(path: Optional[str], offset: int = 0) -> dict:
    """Sum the token usage recorded in `path` after byte `offset`.

    Returns ``{"input_tokens", "output_tokens", "total_tokens", "cost_usd"}``
    (all zero when nothing could be read).

    Input tokens include the cache-creation and cache-read counts: they are
    real context tokens the turn consumed, and leaving them out is what makes
    a Claude Code turn look ~100x cheaper than it is (the uncached
    `input_tokens` of a cached turn is typically a handful of tokens).

    Assistant lines are deduplicated by message id — the CLI rewrites a line
    when a turn is amended, and both copies carry the same cumulative usage.
    """
    result = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
    if not path:
        return result
    try:
        size = os.path.getsize(path)
    except OSError:
        return result
    # File replaced/rotated between the two samples — read it whole rather
    # than seeking past its end.
    start = offset if 0 <= offset <= size else 0

    # One-shot read after the run: an unterminated last line is the end of the
    # file, not a fragment someone is still writing, so parse it too.
    entries, _ = read_records(path, start, tail=False)

    by_id: dict = {}
    anonymous: list = []
    for entry in entries:
        parsed = _assistant_record(entry)
        if parsed is None:
            continue
        msg_id, record = parsed
        if msg_id:
            by_id[msg_id] = record
        else:
            anonymous.append(record)

    for record in list(by_id.values()) + anonymous:
        result["input_tokens"] += record["input_tokens"]
        result["output_tokens"] += record["output_tokens"]
        result["cost_usd"] += record["cost_usd"]
    result["total_tokens"] = result["input_tokens"] + result["output_tokens"]
    return result


# ── continuous tailing (the PTY usage watcher) ──────────────────────────────
#
# `usage_since` dedupes by message id WITHIN one read, which is all a one-shot
# "usage of the run that just exited" needs. A watcher polls the same growing
# file every few seconds, and the CLI rewrites an assistant line when a turn is
# amended — the rewritten copy repeats that message's CUMULATIVE usage. Across
# polls the id-keyed dict is rebuilt empty, so the amended copy was billed in
# full a second time. Hence a ledger that survives polls: per message, remember
# what has already been billed and report only the increment.


def bill_records(entries: list, ledger: dict) -> dict:
    """Fold assistant records into `ledger` (mutated) and return the increment.

    Identified messages are billed as `max(0, now − already billed)`, so a
    duplicate line bills nothing and an amended line bills only what it added.
    Anonymous records carry no identity and are billed as they come — the
    cursor guarantees each is read exactly once.
    """
    delta = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
    for entry in entries:
        parsed = _assistant_record(entry)
        if parsed is None:
            continue
        msg_id, record = parsed
        if not msg_id:
            increment = record
        else:
            billed = ledger.get(msg_id) or {}
            increment = {
                "input_tokens": max(
                    0, record["input_tokens"] - _as_int(billed.get("input_tokens"))
                ),
                "output_tokens": max(
                    0, record["output_tokens"] - _as_int(billed.get("output_tokens"))
                ),
                "cost_usd": max(0.0, record["cost_usd"] - float(billed.get("cost_usd") or 0.0)),
            }
            # Keep the high-water mark: a shrinking amendment must not open
            # room to bill the same tokens again later.
            ledger[msg_id] = {
                "input_tokens": max(record["input_tokens"], _as_int(billed.get("input_tokens"))),
                "output_tokens": max(
                    record["output_tokens"], _as_int(billed.get("output_tokens"))
                ),
                "cost_usd": max(record["cost_usd"], float(billed.get("cost_usd") or 0.0)),
            }
        delta["input_tokens"] += increment["input_tokens"]
        delta["output_tokens"] += increment["output_tokens"]
        delta["cost_usd"] += increment["cost_usd"]
    delta["total_tokens"] = delta["input_tokens"] + delta["output_tokens"]
    return delta


def usage_delta_since(path: Optional[str], offset: int, ledger: dict) -> tuple[dict, int]:
    """Unbilled usage appended after `offset`, and the cursor to resume from.

    The cursor only ever advances past COMPLETE lines, so a turn caught
    half-written is read again (whole) on the next poll instead of being
    skipped for good.
    """
    entries, cursor = read_records(path, offset, tail=True)
    return bill_records(entries, ledger), cursor


def seed_ledger(path: Optional[str], ledger: dict, max_bytes: Optional[int] = None) -> None:
    """Record the usage already on disk as billed, without reporting it.

    Without this, a historical message amended after the watcher started would
    be billed in FULL (its whole cumulative usage) the first time the amended
    copy is seen, even though the watcher never billed the original.
    """
    if not path:
        return
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    if size <= 0 or (max_bytes is not None and size > max_bytes):
        return
    entries, _ = read_records(path, 0, tail=False)
    bill_records(entries, ledger)


class TranscriptUsage:
    """Snapshot helper: build one before spawning the CLI, call `collect()`
    once it exits to get the usage of just that run."""

    def __init__(
        self,
        session_id: Optional[str],
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        home: Optional[str] = None,
    ):
        self.session_id = session_id
        self.cwd = cwd
        self.env = env
        self.home = home
        self.path = transcript_path(session_id, cwd=cwd, env=env, home=home)
        self.offset = transcript_offset(self.path)

    def collect(self) -> dict:
        # Re-resolve: on a brand-new session the file did not exist when the
        # baseline was taken, and the CLI may have written it under a
        # different project slug than we guessed.
        path = self.path
        if not path or not os.path.isfile(path):
            path = transcript_path(
                self.session_id, cwd=self.cwd, env=self.env, home=self.home
            )
            if path != self.path:
                # Different file than the one we sized — read it from the top.
                return usage_since(path, 0)
        return usage_since(path, self.offset)
