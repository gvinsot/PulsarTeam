"""
Claude Code backend — interactive (PTY) driver.

Anthropic has signalled that Claude Code's headless mode (`-p` / `--print`)
will soon be priced at API rates while the interactive TUI keeps the cheap
subscription pricing. This module drives the CLI in TUI mode through a PTY
so we can stay on the subscription plan.

The TUI is meant for humans, so we have to deal with:
  - ANSI escape codes / cursor moves / colors → strip with a regex
  - A startup banner before it accepts input
  - Single-keystroke confirmation prompts ("Y/n", arrow-key lists)
  - No explicit "response complete" sentinel → use an idle-silence window

For prompts we can't auto-answer with a static rule (e.g. "Should I delete
this file?"), we optionally consult an external OpenAI-compatible LLM
configured via env vars. When no fallback LLM is configured we fall back to
the safest default: "y" for Y/N and "1" (first option) for arrow-key lists.

Public API:
    run_interactive(cmd, cwd, env, prompt, preexec_fn=None) -> dict

Result shape mirrors RunnerBackend.run_sync's:
    {
      "status":     "success" | "error" | "timeout",
      "output":     str,
      "stderr":     str,
      "returncode": int | None,
    }
"""

from __future__ import annotations

import os
import re
import pty
import errno
import fcntl
import struct
import select
import signal
import asyncio
import termios
import subprocess
from typing import Optional, Callable

import httpx

try:
    import pyte  # type: ignore
except ImportError:  # pragma: no cover — installed via requirements.txt
    pyte = None  # falls back to the legacy strip-ANSI extractor

from config import (
    CLAUDE_INTERACTIVE_IDLE_SECS,
    CLAUDE_INTERACTIVE_TIMEOUT,
    CLAUDE_FALLBACK_LLM_URL,
    CLAUDE_FALLBACK_LLM_KEY,
    CLAUDE_FALLBACK_LLM_MODEL,
    logger,
)
from backends.fallback_llm_resolver import resolve_fallback_llm


# Fixed PTY size for the Claude Code TUI. Wider than typical terminals so
# the assistant's lines aren't pre-wrapped too aggressively, and tall enough
# that a normal answer fits on-screen (anything that scrolls off is captured
# in pyte's HistoryScreen scrollback). Operator-tunable via env vars.
_TERM_COLS = max(80, int(os.getenv("CLAUDE_PTY_COLS", "200")))
_TERM_ROWS = max(24, int(os.getenv("CLAUDE_PTY_ROWS", "60")))


# ─── ANSI stripping ────────────────────────────────────────────────────────
#
# Claude Code's TUI is heavily styled. We need a clean text view to detect
# prompts and to return readable output. This pattern catches:
#   - CSI sequences:   ESC [ ... letter
#   - OSC sequences:   ESC ] ... BEL  (window title, cwd, links)
#   - Other one-char escapes
#   - Carriage-return-only redraws (we keep \n but drop bare \r)

_ANSI_RE = re.compile(
    r"""
    \x1B \[ [0-?]* [ -/]* [@-~]      # CSI ... final
  | \x1B \] [^\x07]* (?: \x07 | \x1B \\ )   # OSC ... BEL or ST
  | \x1B [@-Z\\-_]                  # ESC + single char
    """,
    re.VERBOSE,
)
_CR_RE = re.compile(r"\r(?!\n)")


def _strip_ansi(text: str) -> str:
    text = _ANSI_RE.sub("", text)
    text = _CR_RE.sub("", text)
    return text


# ─── Prompt detection ──────────────────────────────────────────────────────
#
# Patterns shaped on the Claude Code TUI output. They are best-effort: false
# negatives just mean the prompt isn't auto-answered (the model waits until
# idle-timeout, then we ship whatever was buffered). False positives are the
# real risk — keep these tight.

_YN_RE = re.compile(r"\[\s*y\s*/\s*n\s*\]\s*$", re.IGNORECASE | re.MULTILINE)
# `\s*` (not `\s+`) after the punctuation: Claude Code's TUI uses ANSI absolute
# cursor positioning (e.g. `\x1B[12G`) instead of literal spaces to lay out the
# option labels, so after _strip_ansi the buffer is compacted to `1.Auto`,
# `❯2.Darkmode`, etc. with no space between `.` and the label. Requiring a
# space here was making the theme-picker / onboarding screens invisible to
# `_looks_like_numbered_choice`, which left the driver waiting until hard
# timeout. The matched text is only counted, not extracted, so over-matching
# (e.g. ` 1.5`) is harmless.
_NUMBERED_RE = re.compile(r"^\s*[❯>]?\s*\d+[\.\)]\s*\S", re.MULTILINE)
# Trust-folder prompt: the wording varies across Claude Code CLI versions
# AND the TUI lays each word out with absolute cursor positions (so after
# _strip_ansi the buffer is compacted to e.g. "Isthisaprojectyou…trust?").
# We use `\s*` between every word to match either form. Each alternative is
# distinctive enough that over-matching against chat content is unlikely.
_TRUST_RE = re.compile(
    r"(do\s*you\s*trust\s*this\s*folder"
    r"|is\s*this\s*a\s*project\s*you\s*(created|trust)"
    r"|trust\s*this\s*folder\s*\?"
    r"|yes,?\s*i\s*trust\s*this\s*folder)",
    re.IGNORECASE,
)
# Bypass-permissions warning: shown when the CLI is started with
# `--dangerously-skip-permissions`. Two numbered options where the DEFAULT
# (option 1) is "No, exit" — picking the default would terminate the CLI.
# Match this explicitly so we can ship "2" (Yes, I accept) instead of the
# generic numbered-choice path that would send "1".
_BYPASS_PERMS_RE = re.compile(
    r"(bypass\s*permissions\s*mode|yes,?\s*i\s*accept)",
    re.IGNORECASE,
)
# Arrow-key selector: a caret + a selector-y keyword nearby. Catches non-
# numbered onboarding menus like the post-theme-picker "Select login method"
# screen where each option is just preceded by `❯` (highlighted) or space
# (not highlighted). `\s*` between words because the TUI lays out text with
# absolute cursor moves, which `_strip_ansi` removes (so the buffer ends up
# as "Selectloginmethod" / "Entertoconfirm" etc. with no spaces).
_ARROW_HINT_RE = re.compile(
    r"(select\s*login\s*method"
    r"|select\s*an\s*option"
    r"|use\s*arrow"
    r"|press\s*enter\s*to\s*(confirm|continue|select))",
    re.IGNORECASE,
)


def _looks_like_yn_prompt(tail: str) -> bool:
    return bool(_YN_RE.search(tail))


def _looks_like_numbered_choice(tail: str) -> bool:
    # At least two numbered lines + an instruction keyword. Tightening the
    # heuristic so chat content that happens to include "1. foo\n2. bar"
    # doesn't trigger. `\s*` allows the strip-ANSI-compacted form too.
    matches = _NUMBERED_RE.findall(tail)
    if len(matches) < 2:
        return False
    return bool(re.search(
        r"(select|choose|press\s*\d|enter\s*your\s*choice|use\s*arrow)",
        tail, re.IGNORECASE,
    ))


def _looks_like_arrow_selector(tail: str) -> bool:
    # Caret present and the screen text mentions a selector. The caret alone
    # is too weak (it shows up in normal chat output too); pairing it with a
    # phrase like "select login method" keeps false positives down.
    if "❯" not in tail:
        return False
    return bool(_ARROW_HINT_RE.search(tail))


# ─── Fallback LLM ──────────────────────────────────────────────────────────

async def _ask_fallback_llm(question: str, kind: str) -> Optional[str]:
    """Send the interactive prompt to a configured OpenAI-compatible LLM
    and return a single-token decision. Returns None when no LLM is
    configured or the call fails — caller picks a safe default.

    The LLM config is resolved at call time from (in order):
      1. env vars CLAUDE_FALLBACK_LLM_URL/KEY/MODEL (operator override)
      2. the admin-selected entry exposed via /api/internal/runner-llm/claude-fallback

    kind: "yn"     → expect 'y' or 'n'.
          "choice" → expect a digit '1'..'9' (numbered list, type the digit).
          "arrow"  → expect a digit '1'..'9' (arrow-key menu, 1 = first
                      option; caller turns this into N-1 down arrows + Enter).
    """
    cfg = resolve_fallback_llm()
    if not cfg:
        return None

    if kind == "yn":
        instructions = (
            "You are answering a yes/no confirmation prompt that appeared in "
            "a coding assistant terminal. Reply with exactly ONE character: "
            "'y' to approve or 'n' to refuse. Prefer 'y' when the action is "
            "obviously safe and consistent with completing the user's task; "
            "prefer 'n' for irreversible destructive operations the user did "
            "not explicitly request (rm -rf, force push, etc.)."
        )
    elif kind == "arrow":
        instructions = (
            "You are answering an arrow-key selector that appeared in a "
            "coding assistant terminal. The options are listed in order; the "
            "currently-highlighted option is preceded by `❯`. Reply with "
            "exactly ONE digit (1-9) corresponding to the OPTION INDEX "
            "(1 = first option) that lets the assistant proceed with the "
            "user's task. For onboarding / login screens, prefer the "
            "subscription / default option; never pick options labeled "
            "'Cancel', 'Quit', 'Skip permissions', or 'Untrusted'."
        )
    else:
        instructions = (
            "You are answering a multiple-choice prompt that appeared in a "
            "coding assistant terminal. Reply with exactly ONE digit (1-9) "
            "corresponding to the safest option that lets the assistant "
            "proceed with the user's task. Prefer options labeled 'Yes', "
            "'Allow', 'Approve' over 'No' / 'Cancel'; never pick options "
            "labeled 'Delete forever' / 'Skip permissions' / 'Untrusted'."
        )

    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": f"Prompt:\n{question.strip()}\n\nYour reply (single character):"},
        ],
        "temperature": 0,
        "max_tokens": 4,
    }

    url = cfg["endpoint"].rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url + "/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {cfg['apiKey']}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
        if r.status_code != 200:
            logger.warning(f"[Interactive] Fallback LLM returned {r.status_code}: {r.text[:200]}")
            return None
        data = r.json()
        reply = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip().lower()
        if not reply:
            return None
        # Take the first meaningful char
        for ch in reply:
            if ch in "yn123456789":
                return ch
        return None
    except Exception as e:
        logger.warning(f"[Interactive] Fallback LLM call failed: {e}")
        return None


# ─── PTY driver ────────────────────────────────────────────────────────────

# Banner sentinels we wait for before sending the user's prompt.
_INPUT_READY_HINTS = (
    "▌",                 # the "type a message" caret
    "> ",                # generic prompt indicator
    "│",                 # box-drawing the input area
    "Type / for commands",
    "Try \"",
)


def _read_pty(fd: int, chunk: int = 4096) -> bytes:
    """Non-blocking-style read. Returns b'' if no data available."""
    try:
        return os.read(fd, chunk)
    except OSError as e:
        if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EIO):
            # EIO is what we get on Linux when the slave side has closed
            return b""
        raise


def _drive_pty_blocking(
    cmd: list[str],
    cwd: str,
    env: dict,
    prompt: str,
    preexec_fn: Optional[Callable] = None,
    idle_secs: float = CLAUDE_INTERACTIVE_IDLE_SECS,
    total_timeout: int = CLAUDE_INTERACTIVE_TIMEOUT,
    fallback_resolver: Optional[Callable[[str, str], Optional[str]]] = None,
) -> dict:
    """Blocking PTY driver. Run from a thread executor — DO NOT call from the
    asyncio event loop directly.

    fallback_resolver is called for unrecognised interactive prompts. It must
    be a synchronous callable returning the single-character reply or None.
    """

    master_fd, slave_fd = pty.openpty()

    # Tell the slave-side PTY the agreed dimensions BEFORE the child execs so
    # the TUI lays out at our chosen size (pyte uses the same size to
    # reconstruct the screen). Failure here is non-fatal — the TUI will fall
    # back to its default ~80x24 and pyte will just see a smaller virtual
    # screen.
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ,
                    struct.pack("HHHH", _TERM_ROWS, _TERM_COLS, 0, 0))
    except OSError as e:
        logger.debug(f"[Interactive] TIOCSWINSZ failed: {e}")

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env={**env, "COLUMNS": str(_TERM_COLS), "LINES": str(_TERM_ROWS)},
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=subprocess.PIPE,
            preexec_fn=preexec_fn,
            close_fds=True,
        )
    except Exception as e:
        os.close(master_fd)
        os.close(slave_fd)
        return {"status": "error", "output": "", "stderr": str(e), "returncode": None}

    # We keep the slave open on the parent side too so we can detect EIO
    # cleanly later. Close it now — the child has its own dup.
    os.close(slave_fd)

    # Pyte virtual terminal — feeds the raw bytes through a proper terminal
    # emulator so we get the final screen state (text laid out at absolute
    # positions, redraws collapsed) instead of the messy concatenation that
    # `_strip_ansi` produces. None when pyte is unavailable (we fall back to
    # the legacy extractor).
    screen = None
    stream = None
    if pyte is not None:
        try:
            screen = pyte.HistoryScreen(_TERM_COLS, _TERM_ROWS, history=2000, ratio=0.5)
            stream = pyte.ByteStream(screen)
        except Exception as e:
            logger.warning(f"[Interactive] pyte init failed, falling back: {e}")
            screen = None
            stream = None

    import time
    deadline = time.monotonic() + total_timeout
    last_data_at = time.monotonic()
    waiting_for_input_ready = True
    prompt_sent = False
    raw_buf = bytearray()
    visible_buf = ""  # ANSI-stripped, used for prompt detection
    # Cooldown so we don't re-ship the same auto-answer while the TUI repaints
    # after our keystroke. Bumped a bit higher than _drive_pty_blocking's
    # select() tick (0.2s) so we don't fire twice on the same screen.
    last_auto_answer_at = 0.0
    AUTO_ANSWER_COOLDOWN_S = 1.0
    # Offset into raw_buf at which to start the next detection. After each
    # auto-answer we bump this to len(raw_buf) so we don't re-detect prompts
    # belonging to screens we've already dismissed (e.g. the theme picker
    # lines are still in raw_buf when the login-method screen renders, and
    # without this offset our numbered-choice regex would keep matching the
    # old options).
    detection_offset = 0

    def _ship_keystroke(ch: str) -> None:
        try:
            os.write(master_fd, (ch + "\r").encode())
        except OSError:
            pass

    def _maybe_auto_answer() -> Optional[str]:
        """Detect a known interactive prompt on the NEW content since the last
        auto-answer and ship a reply (consulting the fallback LLM when
        available).

        Called on every chunk — including BEFORE the user's prompt has been
        sent — so first-run onboarding screens (theme picker, login-method,
        trust folder, …) don't deadlock the driver waiting for an input-ready
        hint that will never appear. A 1 s cooldown prevents firing twice on
        the same screen; the `detection_offset` window prevents misfiring on
        stale content from a previous screen.
        """
        nonlocal last_auto_answer_at, detection_offset
        if time.monotonic() - last_auto_answer_at < AUTO_ANSWER_COOLDOWN_S:
            return None
        fresh = _strip_ansi(bytes(raw_buf[detection_offset:]).decode("utf-8", "replace"))
        tail = fresh[-1024:]
        if _looks_like_yn_prompt(tail):
            answer = (fallback_resolver(tail, "yn") if fallback_resolver else None) or "y"
            logger.info(f"[Interactive] Y/N prompt → '{answer}' (prompt_sent={prompt_sent})")
            _ship_keystroke(answer)
            last_auto_answer_at = time.monotonic()
            detection_offset = len(raw_buf)
            return answer
        if _TRUST_RE.search(tail):
            # Send "1" (not "y"): in 2.1.x the trust prompt is a numbered
            # menu where option 1 is "Yes, I trust this folder". "1\r"
            # works for both the 1.x Y/N form and the 2.x numbered form
            # (`1` is also a valid Y/N answer in the older prompt).
            logger.info(f"[Interactive] Trust-folder prompt → '1' (prompt_sent={prompt_sent})")
            _ship_keystroke("1")
            last_auto_answer_at = time.monotonic()
            detection_offset = len(raw_buf)
            return "1"
        if _BYPASS_PERMS_RE.search(tail):
            # `--dangerously-skip-permissions` warning. Option 1 is "No, exit"
            # (the highlighted default) and option 2 is "Yes, I accept". We
            # MUST navigate to option 2 then press Enter — the TUI ignores
            # the `2` keystroke for selection and a bare Enter confirms the
            # currently-highlighted "No, exit" (the CLI then exits rc=1).
            # The 100 ms sleep is critical: without it the `\r` reaches the
            # TUI before it has processed the Down event, so the selection
            # stays on option 1 and the CLI exits.
            logger.info(f"[Interactive] Bypass-permissions warning → option 2 (Down+Enter) (prompt_sent={prompt_sent})")
            try:
                os.write(master_fd, b"\x1b[B")  # CSI B = Down arrow
                time.sleep(0.1)
            except OSError:
                pass
            _ship_keystroke("")  # Bare Enter to confirm
            last_auto_answer_at = time.monotonic()
            detection_offset = len(raw_buf)
            return "2"
        if _looks_like_numbered_choice(tail):
            answer = (fallback_resolver(tail, "choice") if fallback_resolver else None) or "1"
            logger.info(f"[Interactive] Numbered-choice → '{answer}' (prompt_sent={prompt_sent})")
            _ship_keystroke(answer)
            last_auto_answer_at = time.monotonic()
            detection_offset = len(raw_buf)
            return answer
        if _looks_like_arrow_selector(tail):
            # Arrow-key menu (e.g. "Select login method"). Consult the
            # fallback LLM with kind="arrow" to pick an option index 1-9.
            # When no LLM is configured, default to 1 (the first / pre-
            # highlighted option, which for onboarding screens is the
            # subscription/Claude default).
            raw = fallback_resolver(tail, "arrow") if fallback_resolver else None
            try:
                target = int(raw) if raw else 1
            except (TypeError, ValueError):
                target = 1
            target = max(1, min(9, target))
            logger.info(f"[Interactive] Arrow-selector → option #{target} (prompt_sent={prompt_sent})")
            # Navigate from the top assuming the highlight starts at option 1.
            # That holds for the screens we know about (login method, etc.);
            # if a future screen starts elsewhere we'll land one off, which
            # the LLM can recover from on the next round. A short sleep
            # between keystrokes is required: the TUI processes input on its
            # render tick, and back-to-back writes get coalesced before it
            # has updated the selection.
            try:
                for _ in range(target - 1):
                    os.write(master_fd, b"\x1b[B")  # CSI B = Down arrow
                    time.sleep(0.05)
            except OSError:
                pass
            time.sleep(0.05)
            _ship_keystroke("")  # Bare Enter to confirm
            last_auto_answer_at = time.monotonic()
            detection_offset = len(raw_buf)
            return str(target)
        return None

    try:
        while True:
            if time.monotonic() > deadline:
                logger.warning("[Interactive] Hard timeout reached, killing CLI")
                try:
                    proc.send_signal(signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                stderr_out = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
                return {
                    "status": "timeout",
                    "output": _strip_ansi(visible_buf),
                    "stderr": stderr_out,
                    "returncode": proc.returncode,
                }

            r, _, _ = select.select([master_fd], [], [], 0.2)
            if r:
                chunk = _read_pty(master_fd)
                if chunk:
                    raw_buf.extend(chunk)
                    if stream is not None:
                        try:
                            stream.feed(chunk)
                        except Exception as e:
                            # A malformed escape sequence shouldn't kill the
                            # whole session; fall back to text-only extraction.
                            logger.debug(f"[Interactive] pyte feed error (ignored): {e}")
                    visible_buf = _strip_ansi(raw_buf.decode("utf-8", "replace"))
                    last_data_at = time.monotonic()

                    if waiting_for_input_ready and any(h in visible_buf for h in _INPUT_READY_HINTS):
                        waiting_for_input_ready = False

                    if not prompt_sent and not waiting_for_input_ready:
                        # Send the prompt. In Claude Code's TUI, bare Enter
                        # submits the message — for multi-line prompts we
                        # encode each newline as ESC+Enter (Alt+Enter), which
                        # is how the TUI inserts a literal newline. A final
                        # plain Enter submits.
                        try:
                            encoded = prompt.replace("\n", "\x1b\r")
                            os.write(master_fd, encoded.encode("utf-8"))
                            os.write(master_fd, b"\r")
                        except OSError as e:
                            logger.warning(f"[Interactive] Failed to send prompt: {e}")
                        prompt_sent = True
                        last_data_at = time.monotonic()
                        continue

                    # Auto-answer interactive prompts — runs both before and
                    # after the user prompt is delivered. Before delivery it
                    # unblocks first-run onboarding (theme picker, login-
                    # method, trust folder); after delivery it answers mid-
                    # turn Y/N and numbered-choice prompts. The helper reads
                    # raw_buf[detection_offset:] directly so stale prompts
                    # from already-dismissed screens don't fire again.
                    _maybe_auto_answer()

            # If the child exited, we're done.
            if proc.poll() is not None:
                break

            # Idle-based "response complete" detection — only after the prompt
            # has been delivered.
            if prompt_sent and (time.monotonic() - last_data_at) > idle_secs:
                logger.info(f"[Interactive] Idle window ({idle_secs}s) reached — closing CLI")
                # Send `/exit` so the CLI terminates cleanly and flushes.
                try:
                    os.write(master_fd, b"/exit\r")
                except OSError:
                    pass
                # Then give it a beat to drain, then send Ctrl-C as a fallback.
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        proc.send_signal(signal.SIGINT)
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    stderr_out = ""
    try:
        if proc.stderr:
            stderr_out = proc.stderr.read().decode("utf-8", "replace")
    except Exception:
        pass

    visible = _strip_ansi(raw_buf.decode("utf-8", "replace"))
    # Prefer the pyte-reconstructed screen when available — it gives us the
    # TUI's true final state with absolute-cursor layout collapsed, so the
    # extractor only has to recognize `● ` bullet lines for Claude's reply.
    output_text = ""
    if screen is not None:
        try:
            output_text = _extract_assistant_reply_from_screen(screen)
        except Exception as e:
            logger.warning(f"[Interactive] pyte extraction failed, falling back: {e}")
    if not output_text:
        output_text = _extract_assistant_reply(visible, prompt)

    status = "success" if proc.returncode in (0, None) and output_text else "error"
    return {
        "status": status,
        "output": output_text,
        "raw_visible": visible,
        "stderr": stderr_out,
        "returncode": proc.returncode,
    }


def _pyte_screen_lines(screen) -> list[str]:
    """Flatten a pyte HistoryScreen into a list of rendered lines, history
    scrollback first, then the currently-visible display."""
    lines: list[str] = []
    history = getattr(screen, "history", None)
    if history is not None:
        # `history.top` is a deque of buffers. Each buffer is a dict-like
        # mapping column index → pyte Char. Sort columns to get the line in
        # the right order.
        for buf in list(history.top):
            try:
                line = "".join(buf[col].data for col in sorted(buf)).rstrip()
            except Exception:
                continue
            lines.append(line)
    try:
        for line in screen.display:
            lines.append(line.rstrip())
    except Exception:
        pass
    return lines


def _extract_assistant_reply_from_screen(screen) -> str:
    """Pull Claude's response out of a fully-rendered pyte screen.

    The TUI marks each assistant message with a `● ` bullet at the start of
    the line; continuation lines are indented with two spaces. Everything
    else (caret `❯`, status banner `⏵⏵ bypass permissions…`, spinner glyphs
    `✶ ✻ ✽ ✢ ·`, box drawing, "What's new" panel) is chrome we want to drop.
    """
    lines = _pyte_screen_lines(screen)
    blocks: list[list[str]] = []
    current: list[str] = []
    in_block = False
    empty_run = 0

    for raw_line in lines:
        line = raw_line.rstrip()
        if line.startswith("● "):
            if current:
                blocks.append(current)
                current = []
            current.append(line[2:].rstrip())
            in_block = True
            empty_run = 0
        elif in_block and line.startswith("  "):
            # Continuation line (Claude wraps its replies with a 2-space hang).
            if empty_run:
                current.extend([""] * empty_run)
                empty_run = 0
            current.append(line[2:].rstrip())
        elif in_block and not line.strip():
            # Tolerate a single blank line inside an answer (paragraph break);
            # two or more close the block.
            empty_run += 1
            if empty_run >= 2:
                blocks.append(current)
                current = []
                in_block = False
                empty_run = 0
        else:
            if current:
                blocks.append(current)
                current = []
            in_block = False
            empty_run = 0

    if current:
        blocks.append(current)

    return "\n\n".join("\n".join(b).strip() for b in blocks if b).strip()


def _extract_assistant_reply(visible: str, user_prompt: str) -> str:
    """Best-effort: drop the CLI's banner/welcome/input echo and return the
    assistant text. If we can't find a clean boundary, return the whole
    visible buffer trimmed."""
    if not visible:
        return ""

    # Try to drop everything up to the echoed user prompt
    needle = user_prompt.strip().splitlines()[0][:80] if user_prompt.strip() else ""
    if needle:
        idx = visible.rfind(needle)
        if idx >= 0:
            visible = visible[idx + len(needle):]

    # Strip box-drawing characters that may surround the input area
    cleaned = re.sub(r"[│┃┌┐└┘├┤┬┴┼─━╭╮╰╯]+", " ", visible)
    # Collapse runs of whitespace
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()

    # Drop leading/trailing artefacts known to be CLI chrome
    for sentinel in (
        "Welcome to Claude Code",
        "/help for help",
        "Type / for commands",
        "Press Ctrl+C",
        "Bypassing Permissions",
    ):
        cleaned = cleaned.replace(sentinel, "")

    return cleaned.strip()


async def run_interactive(
    cmd: list[str],
    cwd: str,
    env: dict,
    prompt: str,
    preexec_fn: Optional[Callable] = None,
) -> dict:
    """Async wrapper around the blocking PTY driver. Runs the driver in a
    thread pool so we don't block the FastAPI event loop.

    The fallback-LLM resolver is set up here (async-aware) and bridged into
    the blocking driver via an `asyncio.run_coroutine_threadsafe` shim.
    """
    loop = asyncio.get_running_loop()

    def _sync_resolver(question: str, kind: str) -> Optional[str]:
        try:
            fut = asyncio.run_coroutine_threadsafe(_ask_fallback_llm(question, kind), loop)
            return fut.result(timeout=25)
        except Exception as e:
            logger.warning(f"[Interactive] Resolver bridge failed: {e}")
            return None

    return await loop.run_in_executor(
        None,
        lambda: _drive_pty_blocking(
            cmd=cmd,
            cwd=cwd,
            env=env,
            prompt=prompt,
            preexec_fn=preexec_fn,
            idle_secs=CLAUDE_INTERACTIVE_IDLE_SECS,
            total_timeout=CLAUDE_INTERACTIVE_TIMEOUT,
            fallback_resolver=_sync_resolver,
        ),
    )
