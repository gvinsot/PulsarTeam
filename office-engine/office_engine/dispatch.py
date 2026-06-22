"""Format-agnostic entry points used by the most common LLM flows.

`read_document` is the single "give me this file as markdown" tool — it uses
Microsoft markitdown (which wraps python-docx / openpyxl / python-pptx / PyMuPDF)
and falls back to our own format readers if markitdown is unavailable or chokes.
`get_outline` dispatches to the per-format cheap-navigation reader.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .util import ToolError, check_size, ext, resolve_path
from .tools import docx_tools, pdf_tools, pptx_tools, xlsx_tools

_READERS = {
    "docx": docx_tools.read_docx,
    "xlsx": xlsx_tools.read_xlsx,
    "pptx": pptx_tools.read_pptx,
    "pdf": pdf_tools.read_pdf,
}
_OUTLINERS = {
    "docx": docx_tools.get_outline,
    "xlsx": xlsx_tools.get_outline,
    "pptx": pptx_tools.get_outline,
    "pdf": pdf_tools.get_outline,
}


def read_document(path: str) -> dict[str, Any]:
    """Any office file -> markdown for the LLM. markitdown first, native fallback."""
    src = resolve_path(path)
    check_size(src)
    try:
        from markitdown import MarkItDown

        md = MarkItDown()
        result = md.convert(str(src))
        return {"format": ext(src), "path": str(src), "markdown": result.text_content}
    except ImportError:
        pass  # markitdown not installed — use native readers
    except Exception as e:  # noqa: BLE001 — markitdown can raise many things
        # Fall back to the native reader; report markitdown's failure for context.
        reader = _READERS.get(ext(src))
        if reader is None:
            raise ToolError(f"markitdown failed and no native reader for .{ext(src)}: {e}")
    reader = _READERS.get(ext(src))
    if reader is None:
        raise ToolError(f"unsupported format: .{ext(src)} (docx/xlsx/pptx/pdf)")
    out = reader(str(src))
    return {"format": out.get("format"), "path": str(src), "markdown": out.get("markdown", "")}


def get_outline(path: str) -> dict[str, Any]:
    src = resolve_path(path)
    outliner = _OUTLINERS.get(ext(src))
    if outliner is None:
        raise ToolError(f"unsupported format: .{ext(src)} (docx/xlsx/pptx/pdf)")
    return outliner(str(src))
