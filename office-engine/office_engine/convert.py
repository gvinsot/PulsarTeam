"""High-fidelity conversion via LibreOffice headless — the ONLY system-dep tool.

Any -> any: docx<->pdf, pptx->pdf, xlsx->pdf, md->docx, etc. LibreOffice gives
far better visual fidelity than pure-Python renderers (especially PPTX->PDF).
Locates `soffice` via OFFICE_SOFFICE_BIN, then PATH, then common install dirs;
raises a clear ToolError when it is unavailable so the caller can fall back.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .util import ToolError, default_output, resolve_output, resolve_path

# Format aliases -> LibreOffice convert-to target.
_TARGETS = {
    "pdf": "pdf",
    "docx": "docx:MS Word 2007 XML",
    "doc": "doc",
    "odt": "odt",
    "xlsx": "xlsx:Calc MS Excel 2007 XML",
    "ods": "ods",
    "csv": "csv",
    "pptx": "pptx:Impress MS PowerPoint 2007 XML",
    "odp": "odp",
    "png": "png",
    "html": "html",
    "txt": "txt",
}

_COMMON_PATHS = [
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]


def find_soffice() -> str | None:
    explicit = os.environ.get("OFFICE_SOFFICE_BIN")
    if explicit and Path(explicit).exists():
        return explicit
    found = shutil.which("soffice") or shutil.which("soffice.exe")
    if found:
        return found
    for p in _COMMON_PATHS:
        if Path(p).exists():
            return p
    return None


def convert(path: str, to_format: str, output_path: str | None = None, timeout: int = 120) -> dict[str, Any]:
    """Convert `path` to `to_format`. Returns the produced file path."""
    src = resolve_path(path)
    fmt = to_format.lower().lstrip(".")
    if fmt not in _TARGETS:
        raise ToolError(f"unsupported target format: {to_format} (supported: {sorted(_TARGETS)})")

    soffice = find_soffice()
    if not soffice:
        raise ToolError(
            "LibreOffice (soffice) not found. Set OFFICE_SOFFICE_BIN or install "
            "libreoffice. (Pure-library read/edit/generate tools work without it.)"
        )

    out = resolve_output(output_path) if output_path else default_output(src, new_suffix=fmt)
    with tempfile.TemporaryDirectory(prefix="office-lo-") as tmp:
        # Throwaway profile keeps concurrent conversions from clashing on the
        # shared user profile, and avoids first-run wizard prompts.
        profile = Path(tmp) / "profile"
        cmd = [
            soffice,
            f"-env:UserInstallation=file://{profile.as_posix()}",
            "--headless", "--norestore", "--nolockcheck", "--nodefault",
            "--convert-to", _TARGETS[fmt],
            "--outdir", tmp,
            str(src),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout, text=True)
        except subprocess.TimeoutExpired:
            raise ToolError(f"LibreOffice conversion timed out after {timeout}s")
        if proc.returncode != 0:
            raise ToolError(f"LibreOffice conversion failed: {proc.stderr.strip() or proc.stdout.strip()}")

        produced = Path(tmp) / f"{src.stem}.{fmt}"
        if not produced.exists():
            # LibreOffice names by the extension of the target filter.
            candidates = list(Path(tmp).glob(f"{src.stem}.*"))
            if not candidates:
                raise ToolError(f"conversion produced no output (cmd: {' '.join(cmd)})")
            produced = candidates[0]
        shutil.move(str(produced), str(out))
    return {"ok": True, "output_path": str(out), "format": fmt}


def render_preview(path: str, page: int = 1, dpi: int = 150, output_path: str | None = None) -> dict[str, Any]:
    """Render a page/slide to PNG. PDF/image goes straight through PyMuPDF; office
    formats are converted to PDF first for fidelity, then rendered."""
    src = resolve_path(path)
    suffix = src.suffix.lower().lstrip(".")
    if suffix == "pdf":
        from .tools import pdf_tools

        return pdf_tools.render_preview(str(src), page=page, dpi=dpi, output_path=output_path)

    # Convert to PDF (fidelity), then render the page from the PDF.
    with tempfile.TemporaryDirectory(prefix="office-prev-") as tmp:
        pdf_path = Path(tmp) / f"{src.stem}.pdf"
        convert(str(src), "pdf", output_path=str(pdf_path))
        from .tools import pdf_tools

        return pdf_tools.render_preview(str(pdf_path), page=page, dpi=dpi, output_path=output_path)
