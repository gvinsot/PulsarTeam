"""Shared helpers: path confinement, output naming, error envelope, markdown bits.

Path model
----------
The engine operates on filesystem paths it is handed. Two deployments:
  * server-side: set OFFICE_ROOT to a scratch/uploads volume; every path is
    confined under it (defense in depth).
  * desktop sidecar: the Node `fsGuard` is the authoritative allow-list and has
    ALREADY confined the path before calling the sidecar; OFFICE_ROOT may be the
    chosen folder for a second layer, or unset.

`resolve_path` therefore confines to OFFICE_ROOT when set, and otherwise trusts
the absolute path it is given. It always realpath-resolves to defeat symlink and
`..` traversal.
"""
from __future__ import annotations

import os
from pathlib import Path

# Mirror onedriveMcp.ts MAX_READ_BYTES (5 MiB) for reads; generation/convert may
# write larger outputs.
MAX_READ_BYTES = int(os.environ.get("OFFICE_MAX_READ_BYTES", 25 * 1024 * 1024))


class ToolError(Exception):
    """Raised for any user-facing failure; surfaced as a clean MCP error string."""


def _office_root() -> Path | None:
    root = os.environ.get("OFFICE_ROOT")
    return Path(root).resolve() if root else None


def resolve_path(path: str, *, must_exist: bool = True) -> Path:
    """Resolve `path`, confining under OFFICE_ROOT when that env is set.

    Raises ToolError on traversal escape or (when must_exist) a missing file.
    """
    if not path or not str(path).strip():
        raise ToolError("path is required")

    root = _office_root()
    candidate = Path(path)
    if root is not None:
        # Treat absolute/`..` paths as relative to root, then verify containment.
        rel = candidate
        if rel.is_absolute():
            # Strip the anchor so an absolute path can't escape the root.
            rel = Path(*rel.parts[1:]) if len(rel.parts) > 1 else Path()
        resolved = (root / rel).resolve()
        if root != resolved and root not in resolved.parents:
            raise ToolError(f"path escapes the allowed root: {path}")
    else:
        resolved = candidate.expanduser().resolve()

    if must_exist and not resolved.exists():
        raise ToolError(f"file not found: {path}")
    return resolved


def resolve_output(path: str) -> Path:
    """Resolve a destination path (parent must exist), confined like resolve_path."""
    out = resolve_path(path, must_exist=False)
    if not out.parent.exists():
        raise ToolError(f"output directory does not exist: {out.parent}")
    return out


def default_output(src: Path, new_suffix: str | None = None, tag: str = "edited") -> Path:
    """Derive a sibling output name so edits don't overwrite the source by default.

    e.g. report.docx -> report.edited.docx ; report.docx + ".pdf" -> report.pdf
    """
    suffix = new_suffix if new_suffix is not None else src.suffix
    if not suffix.startswith("."):
        suffix = "." + suffix
    if new_suffix is not None:
        return src.with_suffix(suffix)
    return src.with_name(f"{src.stem}.{tag}{suffix}")


def check_size(p: Path) -> None:
    size = p.stat().st_size
    if size > MAX_READ_BYTES:
        raise ToolError(
            f"file too large: {size} bytes > limit {MAX_READ_BYTES}. "
            "Use get_outline or extract specific pages/sheets instead."
        )


def ext(p: Path) -> str:
    return p.suffix.lower().lstrip(".")
