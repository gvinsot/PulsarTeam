"""Token accounting for CLI runners — the budget screen's only input.

Three regressions are pinned here:

  1. codex moved its `token_count` payload from flat `input_tokens` /
     `output_tokens` to a nested `info.total_token_usage`, which the parser
     silently read as 0 tokens per turn.
  2. the claudecode backend drives the real TUI through a PTY and hard-coded
     its result usage to zeros, so every Claude-runner turn looked free.
  3. terminal-driven turns (a task injected into the shared PTY) produce no
     HTTP usage block at all and were never billed.
"""

import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

os.environ.setdefault("RUNNER_TYPE", "codex")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from backends.claude_usage import TranscriptUsage, transcript_path, usage_since  # noqa: E402
from backends.codex import CodexBackend  # noqa: E402
from usage_watcher import UsageWatcher  # noqa: E402
import usage_watcher  # noqa: E402


# ── codex: token_count parsing ──────────────────────────────────────────────


def _codex_line(msg: dict, event_id: str = "0") -> str:
    return json.dumps({"id": event_id, "msg": msg})


def _token_count(total_in, total_out, last_in, last_out) -> dict:
    return {
        "type": "token_count",
        "info": {
            "total_token_usage": {
                "input_tokens": total_in,
                "cached_input_tokens": 0,
                "output_tokens": total_out,
                "reasoning_output_tokens": 0,
                "total_tokens": total_in + total_out,
            },
            "last_token_usage": {
                "input_tokens": last_in,
                "cached_input_tokens": 0,
                "output_tokens": last_out,
                "reasoning_output_tokens": 0,
                "total_tokens": last_in + last_out,
            },
            "model_context_window": 272000,
        },
        "rate_limits": {"primary": {"used_percent": 1.0}},
    }


def test_codex_reads_nested_token_count():
    backend, state = CodexBackend(), {}
    backend._parse_stream_event(_codex_line(_token_count(1200, 300, 1200, 300)), state)
    result = backend._parse_stream_event(
        _codex_line({"type": "task_complete", "last_agent_message": "done"}), state
    )
    assert result["input_tokens"] == 1200
    assert result["output_tokens"] == 300
    assert result["total_tokens"] == 1500


def test_codex_reports_only_this_runs_share_of_a_resumed_session():
    """`total_token_usage` is cumulative over the session; on `codex exec
    resume` it already covers turns billed by earlier runs."""
    backend, state = CodexBackend(), {}
    # First event of this run: 9000 tokens already on the session clock.
    backend._parse_stream_event(_codex_line(_token_count(10000, 500, 1000, 500)), state)
    backend._parse_stream_event(_codex_line(_token_count(12000, 900, 2000, 400)), state)
    result = backend._parse_stream_event(
        _codex_line({"type": "task_complete", "last_agent_message": "done"}), state
    )
    assert result["input_tokens"] == 12000 - 9000
    assert result["output_tokens"] == 900


def test_codex_ignores_repeated_rate_limit_refreshes():
    """codex re-emits token_count with an unchanged `info` when rate limits
    refresh — a naive sum would bill the same turn several times."""
    backend, state = CodexBackend(), {}
    event = _codex_line(_token_count(1200, 300, 1200, 300))
    for _ in range(4):
        backend._parse_stream_event(event, state)
    result = backend._parse_stream_event(
        _codex_line({"type": "task_complete", "last_agent_message": "done"}), state
    )
    assert result["input_tokens"] == 1200
    assert result["output_tokens"] == 300


def test_codex_still_reads_the_legacy_flat_shape():
    backend, state = CodexBackend(), {}
    backend._parse_stream_event(
        _codex_line({"type": "token_count", "input_tokens": 42, "output_tokens": 7}), state
    )
    result = backend._parse_stream_event(
        _codex_line({"type": "task_complete", "last_agent_message": "ok"}), state
    )
    assert (result["input_tokens"], result["output_tokens"]) == (42, 7)


def test_codex_rate_limit_only_event_is_harmless():
    backend, state = CodexBackend(), {}
    backend._parse_stream_event(
        _codex_line({"type": "token_count", "rate_limits": {"primary": {}}}), state
    )
    result = backend._parse_stream_event(
        _codex_line({"type": "task_complete", "last_agent_message": "ok"}), state
    )
    assert (result["input_tokens"], result["output_tokens"]) == (0, 0)


def test_codex_streams_do_not_share_token_state():
    """The backend is a process-wide singleton; two concurrent runs use the
    same codex submission ids, so per-run state must live in `state`."""
    backend = CodexBackend()
    run_a, run_b = {}, {}
    backend._parse_stream_event(_codex_line(_token_count(100, 10, 100, 10)), run_a)
    backend._parse_stream_event(_codex_line(_token_count(7000, 900, 7000, 900)), run_b)
    done = _codex_line({"type": "task_complete", "last_agent_message": ""})
    assert backend._parse_stream_event(done, run_a)["input_tokens"] == 100
    assert backend._parse_stream_event(done, run_b)["input_tokens"] == 7000


# ── claude-code: transcript accounting ──────────────────────────────────────


def _assistant_line(msg_id, input_tokens=0, cache_creation=0, cache_read=0, output=0):
    return json.dumps(
        {
            "type": "assistant",
            "message": {
                "id": msg_id,
                "role": "assistant",
                "usage": {
                    "input_tokens": input_tokens,
                    "cache_creation_input_tokens": cache_creation,
                    "cache_read_input_tokens": cache_read,
                    "output_tokens": output,
                },
            },
        }
    )


def _write_transcript(tmp_path, session_id, cwd, lines):
    import re

    slug = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    directory = tmp_path / ".claude" / "projects" / slug
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session_id}.jsonl"
    with open(path, "a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line + "\n")
    return str(path)


def test_transcript_usage_counts_cache_tokens_as_input(tmp_path):
    """A cached Claude turn reports a handful of plain input_tokens and tens of
    thousands of cache-read tokens. Billing only the former is the difference
    between ~0 and the real consumption."""
    path = _write_transcript(
        tmp_path,
        "sess-1",
        "/srv/project",
        [_assistant_line("m1", input_tokens=4, cache_creation=12000, cache_read=30000, output=500)],
    )
    usage = usage_since(path, 0)
    assert usage["input_tokens"] == 4 + 12000 + 30000
    assert usage["output_tokens"] == 500
    assert usage["total_tokens"] == 42504


def test_transcript_usage_bills_only_the_current_turn(tmp_path):
    """On a resumed session the transcript holds the whole conversation; only
    the lines this run appended may be billed."""
    session, cwd = "sess-2", "/srv/project"
    _write_transcript(tmp_path, session, cwd, [_assistant_line("old", input_tokens=9999, output=999)])
    probe = TranscriptUsage(session, cwd=cwd, home=str(tmp_path))
    _write_transcript(tmp_path, session, cwd, [_assistant_line("new", input_tokens=10, output=5)])
    usage = probe.collect()
    assert usage["input_tokens"] == 10
    assert usage["output_tokens"] == 5


def test_transcript_usage_handles_a_session_created_after_the_baseline(tmp_path):
    """A fresh `--session-id` has no transcript when the baseline is taken."""
    session, cwd = "sess-3", "/srv/project"
    probe = TranscriptUsage(session, cwd=cwd, home=str(tmp_path))
    assert probe.offset == 0
    _write_transcript(tmp_path, session, cwd, [_assistant_line("m1", input_tokens=120, output=30)])
    usage = probe.collect()
    assert (usage["input_tokens"], usage["output_tokens"]) == (120, 30)


def test_transcript_usage_deduplicates_rewritten_messages(tmp_path):
    path = _write_transcript(
        tmp_path,
        "sess-4",
        "/srv/project",
        [
            _assistant_line("m1", input_tokens=100, output=10),
            _assistant_line("m1", input_tokens=100, output=10),
        ],
    )
    assert usage_since(path, 0)["input_tokens"] == 100


def test_transcript_usage_is_zero_when_nothing_is_readable(tmp_path):
    assert usage_since(None, 0)["total_tokens"] == 0
    assert usage_since(str(tmp_path / "missing.jsonl"), 0)["total_tokens"] == 0
    assert TranscriptUsage(None).collect()["total_tokens"] == 0


def test_transcript_path_falls_back_to_a_glob(tmp_path):
    """The CLI may resolve its cwd differently than we guessed (symlinks)."""
    _write_transcript(tmp_path, "sess-5", "/elsewhere", [_assistant_line("m1", output=1)])
    found = transcript_path("sess-5", cwd="/srv/project", home=str(tmp_path))
    assert found is not None and found.endswith("sess-5.jsonl")


# ── terminal (PTY) accounting ───────────────────────────────────────────────


def test_watcher_bills_only_what_the_terminal_session_produced(tmp_path):
    session, cwd = "sess-6", "/srv/project"
    _write_transcript(tmp_path, session, cwd, [_assistant_line("old", input_tokens=5000, output=400)])
    watcher = UsageWatcher("agent-1", kind="claude", root=str(tmp_path))
    watcher.baseline()
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}

    _write_transcript(tmp_path, session, cwd, [_assistant_line("new", input_tokens=700, output=90)])
    assert watcher.collect() == {"input_tokens": 700, "output_tokens": 90}
    # Already reported — a second poll must not re-bill it.
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


# ── continuous tailing across polls ─────────────────────────────────────────
#
# The watcher polls a transcript the CLI is still writing. Two ways that went
# wrong, both pinned below: an amended turn (same message id, cumulative usage)
# billed again on the next poll, and a line caught half-written stepped over by
# a cursor that jumped to the sampled file size.


def _append(path, text):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(text)


def test_watcher_does_not_rebill_a_message_rewritten_in_a_later_poll(tmp_path):
    session, cwd = "sess-dup", "/srv/project"
    watcher = UsageWatcher("agent-1", kind="claude", root=str(tmp_path))
    watcher.baseline()

    path = _write_transcript(
        tmp_path, session, cwd, [_assistant_line("m1", input_tokens=100, output=10)]
    )
    assert watcher.collect() == {"input_tokens": 100, "output_tokens": 10}

    # The CLI rewrites the line for the same turn — same cumulative usage.
    _append(path, _assistant_line("m1", input_tokens=100, output=10) + "\n")
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}

    # Amended upwards: only what the turn added may be billed.
    _append(path, _assistant_line("m1", input_tokens=150, output=25) + "\n")
    assert watcher.collect() == {"input_tokens": 50, "output_tokens": 15}
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


def test_watcher_bills_only_the_increment_of_a_message_older_than_the_baseline(tmp_path):
    """A turn already on disk when the watcher started was never billed by it;
    re-reading its amended copy must not bill the whole history."""
    session, cwd = "sess-hist", "/srv/project"
    path = _write_transcript(
        tmp_path, session, cwd, [_assistant_line("old", input_tokens=9999, output=999)]
    )
    watcher = UsageWatcher("agent-1", kind="claude", root=str(tmp_path))
    watcher.baseline()

    _append(path, _assistant_line("old", input_tokens=9999, output=999) + "\n")
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}

    _append(path, _assistant_line("old", input_tokens=10099, output=1009) + "\n")
    assert watcher.collect() == {"input_tokens": 100, "output_tokens": 10}


def test_watcher_reads_a_line_split_across_two_polls(tmp_path):
    """The poll can land while the CLI is mid-write. The cursor must stay put
    so the fragment is read again whole, not skipped."""
    session, cwd = "sess-split", "/srv/project"
    watcher = UsageWatcher("agent-1", kind="claude", root=str(tmp_path))
    watcher.baseline()

    line = _assistant_line("m1", input_tokens=100, output=10)
    path = _write_transcript(tmp_path, session, cwd, [])
    _append(path, line[: len(line) // 2])
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}

    _append(path, line[len(line) // 2 :] + "\n")
    assert watcher.collect() == {"input_tokens": 100, "output_tokens": 10}
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


def test_watcher_counts_lines_appended_while_it_reads_exactly_once(tmp_path):
    """The file can grow between the size sample and the read. Those bytes are
    consumed by this poll — advancing the cursor to the stale size would read
    them twice."""
    session, cwd = "sess-race", "/srv/project"
    watcher = UsageWatcher("agent-1", kind="claude", root=str(tmp_path))
    watcher.baseline()
    path = _write_transcript(
        tmp_path, session, cwd, [_assistant_line("m1", input_tokens=100, output=10)]
    )

    stat_size = UsageWatcher._size

    def racing_size(p):
        size = stat_size(p)
        # The CLI appends a turn right after we stat'ed the file.
        _append(p, _assistant_line("m2", input_tokens=7, output=3) + "\n")
        return size

    watcher._size = racing_size  # type: ignore[method-assign]
    assert watcher.collect() == {"input_tokens": 107, "output_tokens": 13}

    watcher._size = stat_size  # type: ignore[method-assign]
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


def test_codex_watcher_waits_for_a_complete_token_count_line(tmp_path):
    """The cursor rule is shared: a half-written rollout event must not be
    stepped over either."""
    watcher = UsageWatcher("agent-1", kind="codex", root=str(tmp_path))
    watcher.baseline()

    event = json.dumps(_rollout_token_count(400, 50))
    path = _write_rollout(tmp_path, "rollout-split.jsonl", [])
    _append(path, event[: len(event) // 2])
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}

    _append(path, event[len(event) // 2 :] + "\n")
    assert watcher.collect() == {"input_tokens": 400, "output_tokens": 50}
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


def test_watcher_rebills_from_scratch_when_the_transcript_is_replaced(tmp_path):
    """A rotated/truncated file is a different conversation: the ledger and the
    cursor both restart."""
    session, cwd = "sess-rotate", "/srv/project"
    watcher = UsageWatcher("agent-1", kind="claude", root=str(tmp_path))
    watcher.baseline()
    path = _write_transcript(
        tmp_path, session, cwd, [_assistant_line("m1", input_tokens=100, output=10)]
    )
    assert watcher.collect() == {"input_tokens": 100, "output_tokens": 10}

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(_assistant_line("m9", input_tokens=5, output=1) + "\n")
    assert watcher.collect() == {"input_tokens": 5, "output_tokens": 1}


def test_watcher_ledger_stays_bounded():
    """A long session appends message ids without end; the ledger must not
    grow with it."""
    from usage_watcher import _MAX_TRACKED_MESSAGES, _claude_ledger

    memo: dict = {}
    ledger = _claude_ledger(memo, "transcript")
    for i in range(_MAX_TRACKED_MESSAGES + 100):
        ledger[f"m{i}"] = {"input_tokens": 1, "output_tokens": 1, "cost_usd": 0.0}
    assert len(_claude_ledger(memo, "transcript")) == _MAX_TRACKED_MESSAGES
    # The most recent ids — the ones a rewrite can still touch — are kept.
    assert f"m{_MAX_TRACKED_MESSAGES + 99}" in memo["transcript"]


def test_watcher_picks_up_a_session_started_after_the_baseline(tmp_path):
    watcher = UsageWatcher("agent-1", kind="claude", root=str(tmp_path))
    watcher.baseline()
    _write_transcript(
        tmp_path, "sess-7", "/srv/project", [_assistant_line("m1", input_tokens=42, output=8)]
    )
    assert watcher.collect() == {"input_tokens": 42, "output_tokens": 8}


def _write_rollout(tmp_path, name, entries):
    directory = tmp_path / ".codex" / "sessions" / "2026" / "09" / "16"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    with open(path, "a", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(entry) + "\n")
    return str(path)


def _rollout_token_count(total_in, total_out):
    return {
        "type": "event_msg",
        "payload": _token_count(total_in, total_out, total_in, total_out),
    }


def test_codex_watcher_reports_cumulative_deltas(tmp_path):
    _write_rollout(tmp_path, "rollout-a.jsonl", [_rollout_token_count(1000, 100)])
    watcher = UsageWatcher("agent-1", kind="codex", root=str(tmp_path))
    watcher.baseline()
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}

    # codex rewrites the cumulative counter, it does not append a delta.
    _write_rollout(tmp_path, "rollout-a.jsonl", [_rollout_token_count(2500, 260)])
    assert watcher.collect() == {"input_tokens": 1500, "output_tokens": 160}
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


def test_codex_watcher_handles_a_new_rollout_file(tmp_path):
    watcher = UsageWatcher("agent-1", kind="codex", root=str(tmp_path))
    watcher.baseline()
    _write_rollout(tmp_path, "rollout-b.jsonl", [_rollout_token_count(300, 40)])
    assert watcher.collect() == {"input_tokens": 300, "output_tokens": 40}


def test_codex_watcher_resumes_large_rollout_across_polls_and_restarts(tmp_path, monkeypatch):
    name = "rollout-large.jsonl"
    path = _write_rollout(tmp_path, name, [_rollout_token_count(900_000, 9000)])
    with open(path, "ab") as fh:
        fh.write(b" " * usage_watcher._MAX_BASELINE_BYTES + b"\n")
    _write_rollout(tmp_path, name, [_rollout_token_count(1_000_000, 10_000)])
    reads = []

    class ReadMeter:
        def __init__(self, fh):
            self.fh = fh

        def seek(self, offset):
            return self.fh.seek(offset)

        def read(self, count):
            reads.append(count)
            return self.fh.read(count)

    @contextmanager
    def measured_open(*args, **kwargs):
        with open(*args, **kwargs) as fh:
            yield ReadMeter(fh)

    for run in range(3):
        watcher = UsageWatcher("agent-1", kind="codex", root=str(tmp_path))
        reads.clear()
        with monkeypatch.context() as patch:
            patch.setattr(usage_watcher, "open", measured_open, raising=False)
            watcher.baseline()
        assert sum(reads) <= usage_watcher._BASELINE_BLOCK_BYTES
        assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}
        for poll in range(2):
            step = run * 2 + poll + 1
            _write_rollout(tmp_path, name, [
                _rollout_token_count(1_000_000 + step * 100, 10_000 + step * 10)
            ])
            assert watcher.collect() == {"input_tokens": 100, "output_tokens": 10}
            assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


@pytest.mark.parametrize("reason", ["unreadable", "stat_failure", "no_counter", "outside_window"])
def test_codex_unknown_baseline_never_bills_history(tmp_path, monkeypatch, reason):
    name = "rollout-unknown.jsonl"
    entries = [] if reason == "no_counter" else [_rollout_token_count(1_000_000, 10_000)]
    path = _write_rollout(tmp_path, name, entries)
    if reason == "no_counter":
        with open(path, "a") as fh:
            fh.write('invalid JSON\n{"type":"session_meta"}\n')
    if reason == "outside_window":
        monkeypatch.setattr(usage_watcher, "_MAX_BASELINE_BYTES", 1024)
        with open(path, "a") as fh:
            fh.write(json.dumps({"text": "x" * 2048}) + "\n")
    watcher = UsageWatcher("agent-1", kind="codex", root=str(tmp_path))

    def unreadable(*args, **kwargs):
        raise PermissionError("synthetic read failure")

    with monkeypatch.context() as patch:
        if reason == "unreadable":
            patch.setattr(usage_watcher, "open", unreadable, raising=False)
        elif reason == "stat_failure":
            patch.setattr(watcher, "_size", lambda path: 0)
        watcher.baseline()
    assert watcher._memo[path] is None
    _write_rollout(tmp_path, name, [_rollout_token_count(1_000_100, 10_010)])
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}
    _write_rollout(tmp_path, name, [_rollout_token_count(1_000_200, 10_020)])
    assert watcher.collect() == {"input_tokens": 100, "output_tokens": 10}
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}


def test_codex_baseline_scans_backwards_across_record_and_utf8_boundaries(tmp_path, monkeypatch):
    monkeypatch.setattr(usage_watcher, "_BASELINE_BLOCK_BYTES", 17)
    path = _write_rollout(tmp_path, "rollout-blocks.jsonl", [
        _rollout_token_count(100, 10), _rollout_token_count(200, 20),
    ])
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"text": "é" * 300}, ensure_ascii=False) + '\n{"partial":')
    memo = {}
    usage_watcher._codex_baseline(path, os.path.getsize(path), memo)
    assert memo[path] == {"input_tokens": 200, "output_tokens": 20, "total_tokens": 220}


def test_codex_baseline_stops_at_captured_eof(tmp_path):
    path = _write_rollout(tmp_path, "rollout-snapshot.jsonl", [_rollout_token_count(100, 10)])
    size = os.path.getsize(path)
    _write_rollout(tmp_path, "rollout-snapshot.jsonl", [_rollout_token_count(200, 20)])
    memo = {}
    usage_watcher._codex_baseline(path, size, memo)
    # The adapter answers (delta, cursor); the cursor is asserted by the
    # split-line tests above.
    delta, _ = usage_watcher._codex_delta(path, size, memo)
    assert delta == {"input_tokens": 100, "output_tokens": 10}


def test_codex_missing_baseline_is_not_implicitly_zero(tmp_path):
    path = _write_rollout(tmp_path, "rollout-missing.jsonl", [_rollout_token_count(1_000_000, 10_000)])
    memo = {}
    assert usage_watcher._codex_delta(path, 0, memo)[0] == {}
    assert memo[path] == {
        "input_tokens": 1_000_000, "output_tokens": 10_000, "total_tokens": 1_010_000
    }


def test_watcher_is_inert_for_a_cli_with_no_adapter(tmp_path):
    watcher = UsageWatcher("agent-1", kind="hermes", root=str(tmp_path))
    assert watcher.supported is False
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}
