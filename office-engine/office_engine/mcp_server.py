"""Streamable HTTP MCP server exposing the office tools.

Transport matches api/src/services/mcpClient.ts (Streamable HTTP, /mcp path), so
the api registers this as an external-URL builtin and every configured LLM reaches
it through the Pulsar Gateway. Run: `python -m office_engine.mcp_server`.

Each tool returns a JSON string (or markdown for reads); failures are caught and
returned as `{"error": "..."}` so the model gets actionable text, not a stack trace.
"""
from __future__ import annotations

import functools
import json
import os
from typing import Any, Callable

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import convert as convert_mod
from . import dispatch
from .tools import docx_tools, pdf_tools, pptx_tools, xlsx_tools
from .util import ToolError

mcp = FastMCP(
    "Office Documents",
    host=os.environ.get("OFFICE_HOST", "0.0.0.0"),
    port=int(os.environ.get("OFFICE_PORT", "8000")),
)


def _envelope(fn: Callable[..., Any]) -> Callable[..., str]:
    """Run a pure tool fn, JSON-stringify the result, convert errors to clean text."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> str:
        try:
            result = fn(*args, **kwargs)
        except ToolError as e:
            return json.dumps({"error": str(e)})
        except FileNotFoundError as e:
            return json.dumps({"error": f"file not found: {e}"})
        except Exception as e:  # noqa: BLE001 — surface anything as a tool error
            return json.dumps({"error": f"{type(e).__name__}: {e}"})
        if isinstance(result, str):
            return result
        return json.dumps(result, ensure_ascii=False, default=str)

    return wrapper


# --- Universal -------------------------------------------------------------
@mcp.tool()
def read_document(path: str) -> str:
    """Read ANY office file (docx/xlsx/pptx/pdf) and return its content as markdown.
    The best first step to understand a document before editing it."""
    return _envelope(dispatch.read_document)(path)


@mcp.tool()
def get_outline(path: str) -> str:
    """Return a document's structure only (headings / sheets / slides / bookmarks)
    with indexes — cheap navigation for large files before a full read."""
    return _envelope(dispatch.get_outline)(path)


@mcp.tool()
def convert_document(path: str, to_format: str, output_path: str | None = None) -> str:
    """High-fidelity convert via LibreOffice (docx<->pdf, pptx->pdf, md->docx, ...).
    Also the way to 'edit a PDF': convert to docx, edit, convert back. Supported
    targets: pdf, docx, xlsx, pptx, odt, ods, odp, csv, html, png, txt."""
    return _envelope(convert_mod.convert)(path, to_format, output_path)


@mcp.tool()
def render_preview(path: str, page: int = 1, dpi: int = 150, output_path: str | None = None) -> str:
    """Render one page/slide to a PNG image (office formats are converted to PDF
    first for fidelity). Returns the saved image path."""
    return _envelope(convert_mod.render_preview)(path, page, dpi, output_path)


# --- Word ------------------------------------------------------------------
@mcp.tool()
def read_docx(path: str) -> str:
    """Read a .docx into indexed paragraphs, tables and markdown (paragraph indexes
    are the addresses used by edit_docx)."""
    return _envelope(docx_tools.read_docx)(path)


@mcp.tool()
def edit_docx(path: str, operations: list[dict], output_path: str | None = None) -> str:
    """Edit an existing .docx in place (round-trip; untouched content is preserved).
    operations: [{op:'replace_text',find,replace,first?}, {op:'set_paragraph',index,text},
    {op:'insert_paragraph',after_index,text,style?}, {op:'delete_paragraph',index}].
    Saves to output_path (default: <name>.edited.docx)."""
    return _envelope(docx_tools.edit_docx)(path, operations, output_path)


@mcp.tool()
def generate_docx(output_path: str, spec: dict) -> str:
    """Create a new .docx. spec: {title?, sections:[{heading,level,paragraphs[],bullets[],
    table:{header[],rows[][]}}]}."""
    return _envelope(docx_tools.generate_docx)(output_path, spec)


# --- Excel -----------------------------------------------------------------
@mcp.tool()
def read_xlsx(path: str, sheet: str | None = None, max_rows: int = 500, max_cols: int = 50) -> str:
    """Read a .xlsx — sheet names, a capped cell grid and markdown tables."""
    return _envelope(xlsx_tools.read_xlsx)(path, sheet, max_rows, max_cols)


@mcp.tool()
def edit_xlsx(path: str, cells: list[dict], output_path: str | None = None) -> str:
    """Set cells in an existing .xlsx (round-trip). cells: [{sheet?, cell:'B3', value}];
    a value starting with '=' is written as a formula. Saves to output_path
    (default: <name>.edited.xlsx)."""
    return _envelope(xlsx_tools.edit_xlsx)(path, cells, output_path)


@mcp.tool()
def generate_xlsx(output_path: str, spec: dict) -> str:
    """Create a new .xlsx. spec: {sheets:[{name,header?,rows:[[...]]}]} or a single-sheet
    shortcut {header?,rows:[[...]]}."""
    return _envelope(xlsx_tools.generate_xlsx)(output_path, spec)


# --- PowerPoint ------------------------------------------------------------
@mcp.tool()
def read_pptx(path: str) -> str:
    """Read a .pptx — per-slide title, body text, notes and markdown."""
    return _envelope(pptx_tools.read_pptx)(path)


@mcp.tool()
def edit_pptx(path: str, operations: list[dict], output_path: str | None = None) -> str:
    """Edit an existing .pptx (round-trip). operations: [{op:'replace_text',find,replace,slide?},
    {op:'set_title',slide,text}, {op:'set_notes',slide,text},
    {op:'add_slide',layout?,title?,bullets?[],notes?}]. Default output: <name>.edited.pptx."""
    return _envelope(pptx_tools.edit_pptx)(path, operations, output_path)


@mcp.tool()
def generate_pptx(output_path: str, spec: dict) -> str:
    """Create a new .pptx. spec: {slides:[{layout?,title,bullets[],notes?}]}."""
    return _envelope(pptx_tools.generate_pptx)(output_path, spec)


# --- PDF -------------------------------------------------------------------
@mcp.tool()
def read_pdf(path: str, pages: str | None = None) -> str:
    """Extract text from a PDF (pages like '1-3,5'; default all) as markdown."""
    return _envelope(pdf_tools.read_pdf)(path, pages)


@mcp.tool()
def extract_pdf(path: str, what: str = "text", pages: str | None = None) -> str:
    """Extract 'text' | 'tables' | 'images' from a PDF (pages like '1-3,5')."""
    return _envelope(pdf_tools.extract_pdf)(path, what, pages)


@mcp.tool()
def merge_pdfs(paths: list[str], output_path: str) -> str:
    """Concatenate 2+ PDFs into output_path."""
    return _envelope(pdf_tools.merge_pdfs)(paths, output_path)


@mcp.tool()
def split_pdf(path: str, pages: str, output_path: str | None = None) -> str:
    """Extract pages (e.g. '1-3,7') from a PDF into a new file."""
    return _envelope(pdf_tools.split_pdf)(path, pages, output_path)


@mcp.custom_route("/health", methods=["GET"])
async def health(_request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "service": "office-engine"})


def main() -> None:
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
