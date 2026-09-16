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
from pathlib import Path

os.environ.setdefault("RUNNER_TYPE", "codex")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from backends.claude_usage import TranscriptUsage, transcript_path, usage_since  # noqa: E402
from backends.codex import CodexBackend  # noqa: E402
from usage_watcher import UsageWatcher  # noqa: E402


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


def test_watcher_is_inert_for_a_cli_with_no_adapter(tmp_path):
    watcher = UsageWatcher("agent-1", kind="hermes", root=str(tmp_path))
    assert watcher.supported is False
    assert watcher.collect() == {"input_tokens": 0, "output_tokens": 0}
