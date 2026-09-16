"""Cursor-safe reading of append-only JSONL transcripts.

Both CLI accounting adapters (claude, codex) tail a transcript the CLI is
still writing to, and both keep a byte cursor between polls. Two properties
matter and neither is free:

  * a poll can land mid-line — the CLI writes a turn while we read it. The
    cursor must stop at the END OF THE LAST COMPLETE LINE, otherwise the
    fragment is parsed as garbage, dropped, and the cursor jumps over it: the
    turn is billed as zero forever.
  * the file can grow between `stat()` and the read. Advancing by "what we
    actually consumed" instead of "the size we sampled" means those extra
    bytes are consumed now and never read twice.

`tail=True` gives exactly that. `tail=False` is for one-shot reads after the
CLI has exited, where an unterminated final line is simply the end of the file
and should still be parsed.
"""

from __future__ import annotations

import json
from typing import Optional

from config import logger


def read_records(
    path: Optional[str], offset: int = 0, *, tail: bool = True
) -> tuple[list[dict], int]:
    """JSON objects written after `offset`, plus the cursor to resume from.

    The returned cursor is the byte offset just past the last record consumed;
    it equals `offset` when nothing complete was available, so an unchanged
    cursor means "retry this region next time".
    """
    start = max(0, int(offset or 0))
    if not path:
        return [], start
    try:
        with open(path, "rb") as fh:
            fh.seek(start)
            data = fh.read()
    except OSError as e:
        logger.debug(f"[Usage] unreadable transcript {path}: {e}")
        return [], start

    if tail:
        # Everything up to (and including) the last newline is complete; a
        # trailing fragment stays unconsumed so the next poll re-reads it whole.
        cut = data.rfind(b"\n")
        if cut < 0:
            return [], start
        data = data[: cut + 1]
    consumed = start + len(data)

    records: list[dict] = []
    for raw in data.splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            entry = json.loads(line.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            records.append(entry)
    return records, consumed
