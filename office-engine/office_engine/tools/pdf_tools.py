"""PDF — read / extract / assemble / render. PyMuPDF (fitz) + pypdf.

Deliberately NO rich round-trip text editing: that is not reliable with these
libraries (see plan R3). To "edit" a PDF, convert it to .docx (convert.py), edit
the docx, and convert back. The tool descriptions state this so the LLM doesn't
attempt impossible in-place edits.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import fitz  # PyMuPDF
from pypdf import PdfReader, PdfWriter

from ..util import ToolError, check_size, default_output, resolve_output, resolve_path


def _parse_pages(pages: str | None, page_count: int) -> list[int]:
    """Parse '1-3,5' (1-based, inclusive) into 0-based indexes. None = all."""
    if not pages:
        return list(range(page_count))
    out: list[int] = []
    for part in str(pages).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
            out.extend(range(start - 1, end))
        else:
            out.append(int(part) - 1)
    bad = [p for p in out if p < 0 or p >= page_count]
    if bad:
        raise ToolError(f"page(s) out of range 1..{page_count}: {pages}")
    return out


def read_pdf(path: str, pages: str | None = None) -> dict[str, Any]:
    """Extract text per page + a markdown rendering (page headers + text)."""
    src = resolve_path(path)
    check_size(src)
    doc = fitz.open(str(src))
    try:
        idxs = _parse_pages(pages, doc.page_count)
        out_pages = []
        md = []
        for i in idxs:
            text = doc[i].get_text("text")
            out_pages.append({"page": i + 1, "text": text})
            md.append(f"### Page {i + 1}\n\n{text.strip()}")
        return {
            "format": "pdf",
            "path": str(src),
            "page_count": doc.page_count,
            "pages": out_pages,
            "markdown": "\n\n".join(md),
        }
    finally:
        doc.close()


def get_outline(path: str) -> dict[str, Any]:
    """PDF bookmarks/TOC if present, plus page count."""
    src = resolve_path(path)
    doc = fitz.open(str(src))
    try:
        toc = doc.get_toc()  # [[level, title, page], ...]
        headings = [{"level": lvl, "text": title, "page": page} for lvl, title, page in toc]
        return {"format": "pdf", "path": str(src), "page_count": doc.page_count, "headings": headings}
    finally:
        doc.close()


def extract_pdf(path: str, what: str = "text", pages: str | None = None) -> dict[str, Any]:
    """what = 'text' | 'tables' | 'images'. Tables use PyMuPDF's finder."""
    src = resolve_path(path)
    doc = fitz.open(str(src))
    try:
        idxs = _parse_pages(pages, doc.page_count)
        if what == "text":
            return {"text": "\n".join(doc[i].get_text("text") for i in idxs)}
        if what == "tables":
            tables = []
            for i in idxs:
                finder = doc[i].find_tables()
                for t in finder.tables:
                    tables.append({"page": i + 1, "rows": t.extract()})
            return {"tables": tables}
        if what == "images":
            images = []
            for i in idxs:
                for img in doc[i].get_images(full=True):
                    images.append({"page": i + 1, "xref": img[0], "width": img[2], "height": img[3]})
            return {"images": images}
        raise ToolError(f"unknown extract target: {what} (text|tables|images)")
    finally:
        doc.close()


def merge_pdfs(paths: list[str], output_path: str) -> dict[str, Any]:
    if not isinstance(paths, list) or len(paths) < 2:
        raise ToolError("merge_pdfs needs a list of at least 2 paths")
    writer = PdfWriter()
    for p in paths:
        reader = PdfReader(str(resolve_path(p)))
        for page in reader.pages:
            writer.add_page(page)
    out = resolve_output(output_path)
    with open(out, "wb") as fh:
        writer.write(fh)
    return {"ok": True, "output_path": str(out), "source_count": len(paths)}


def split_pdf(path: str, pages: str, output_path: str | None = None) -> dict[str, Any]:
    """Extract `pages` (e.g. '1-3,7') into a new PDF."""
    src = resolve_path(path)
    reader = PdfReader(str(src))
    idxs = _parse_pages(pages, len(reader.pages))
    writer = PdfWriter()
    for i in idxs:
        writer.add_page(reader.pages[i])
    out = resolve_output(output_path) if output_path else default_output(src, tag="split")
    with open(out, "wb") as fh:
        writer.write(fh)
    return {"ok": True, "output_path": str(out), "pages": [i + 1 for i in idxs]}


def render_preview(path: str, page: int = 1, dpi: int = 150, output_path: str | None = None) -> dict[str, Any]:
    """Render one PDF page to PNG (1-based page). Returns the saved image path."""
    src = resolve_path(path)
    doc = fitz.open(str(src))
    try:
        if not 1 <= page <= doc.page_count:
            raise ToolError(f"page out of range 1..{doc.page_count}: {page}")
        pix = doc[page - 1].get_pixmap(dpi=dpi)
        out = resolve_output(output_path) if output_path else default_output(src, new_suffix="png")
        out = out.with_name(f"{src.stem}.p{page}.png")
        pix.save(str(out))
        return {"ok": True, "output_path": str(out), "width": pix.width, "height": pix.height}
    finally:
        doc.close()
