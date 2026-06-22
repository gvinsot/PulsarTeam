"""Round-trip tests for the pure-library tools (no LibreOffice needed).

Each test GENERATES its sample file, then reads/edits it, so there are no binary
fixtures to commit. PDF samples are built with PyMuPDF.
"""
from __future__ import annotations

import json

import fitz  # PyMuPDF
import pytest

from office_engine.tools import docx_tools, pdf_tools, pptx_tools, xlsx_tools
from office_engine import dispatch
from office_engine.util import ToolError


# --- DOCX ------------------------------------------------------------------
def test_docx_generate_read_edit(tmp_path):
    path = tmp_path / "doc.docx"
    docx_tools.generate_docx(str(path), {
        "title": "Report",
        "sections": [
            {"heading": "Intro", "level": 1, "paragraphs": ["Hello world."], "bullets": ["a", "b"]},
            {"heading": "Data", "level": 1, "table": {"header": ["k", "v"], "rows": [["x", "1"]]}},
        ],
    })
    read = docx_tools.read_docx(str(path))
    assert read["format"] == "docx"
    assert "Hello world." in read["markdown"]
    assert read["table_count"] == 1

    out = docx_tools.edit_docx(str(path), [{"op": "replace_text", "find": "Hello world.", "replace": "Bonjour."}])
    edited = docx_tools.read_docx(out["output_path"])
    assert "Bonjour." in edited["markdown"]
    assert "Hello world." not in edited["markdown"]

    outline = docx_tools.get_outline(str(path))
    assert any(h["text"] == "Intro" for h in outline["headings"])


# --- XLSX ------------------------------------------------------------------
def test_xlsx_generate_read_edit(tmp_path):
    path = tmp_path / "book.xlsx"
    xlsx_tools.generate_xlsx(str(path), {"sheets": [
        {"name": "Sales", "header": ["Item", "Qty"], "rows": [["Pen", 3], ["Book", 5]]},
    ]})
    read = xlsx_tools.read_xlsx(str(path))
    assert read["sheet_names"] == ["Sales"]
    assert "Pen" in read["sheets"][0]["markdown"]

    out = xlsx_tools.edit_xlsx(str(path), [{"sheet": "Sales", "cell": "B2", "value": 99}])
    edited = xlsx_tools.read_xlsx(out["output_path"], sheet="Sales")
    # B2 is row 2 col 2 -> grid[1][1]
    assert edited["sheets"][0]["grid"][1][1] == 99


def test_xlsx_formula(tmp_path):
    path = tmp_path / "f.xlsx"
    xlsx_tools.generate_xlsx(str(path), {"header": ["a"], "rows": [[1], [2]]})
    out = xlsx_tools.edit_xlsx(str(path), [{"cell": "A4", "value": "=SUM(A2:A3)"}])
    read = xlsx_tools.read_xlsx(out["output_path"])
    assert read["sheets"][0]["grid"][3][0] == "=SUM(A2:A3)"


# --- PPTX ------------------------------------------------------------------
def test_pptx_generate_read_edit(tmp_path):
    path = tmp_path / "deck.pptx"
    pptx_tools.generate_pptx(str(path), {"slides": [
        {"title": "Welcome", "bullets": ["one", "two"], "notes": "say hi"},
        {"title": "End", "bullets": ["bye"]},
    ]})
    read = pptx_tools.read_pptx(str(path))
    assert read["slide_count"] == 2
    assert read["slides"][0]["title"] == "Welcome"
    assert "one" in read["slides"][0]["body"]

    out = pptx_tools.edit_pptx(str(path), [{"op": "replace_text", "find": "Welcome", "replace": "Bienvenue"}])
    edited = pptx_tools.read_pptx(out["output_path"])
    assert edited["slides"][0]["title"] == "Bienvenue"

    out2 = pptx_tools.edit_pptx(str(path), [{"op": "add_slide", "title": "Extra", "bullets": ["x"]}])
    assert pptx_tools.read_pptx(out2["output_path"])["slide_count"] == 3


# --- PDF -------------------------------------------------------------------
def _make_pdf(path, pages_text):
    doc = fitz.open()
    for text in pages_text:
        page = doc.new_page()
        page.insert_text((72, 72), text)
    doc.save(str(path))
    doc.close()


def test_pdf_read_extract_split_merge(tmp_path):
    p1 = tmp_path / "a.pdf"
    _make_pdf(p1, ["Alpha page one", "Alpha page two", "Alpha page three"])
    read = pdf_tools.read_pdf(str(p1))
    assert read["page_count"] == 3
    assert "Alpha page one" in read["markdown"]

    sub = pdf_tools.split_pdf(str(p1), "1-2")
    assert pdf_tools.read_pdf(sub["output_path"])["page_count"] == 2

    p2 = tmp_path / "b.pdf"
    _make_pdf(p2, ["Beta only"])
    merged = pdf_tools.merge_pdfs([str(p1), str(p2)], str(tmp_path / "merged.pdf"))
    assert pdf_tools.read_pdf(merged["output_path"])["page_count"] == 4

    text = pdf_tools.extract_pdf(str(p1), what="text", pages="2")
    assert "Alpha page two" in text["text"]


def test_pdf_render_preview(tmp_path):
    p = tmp_path / "r.pdf"
    _make_pdf(p, ["preview me"])
    out = pdf_tools.render_preview(str(p), page=1)
    assert out["ok"] and out["output_path"].endswith(".png")


# --- dispatch / errors -----------------------------------------------------
def test_read_document_dispatch(tmp_path):
    path = tmp_path / "d.docx"
    docx_tools.generate_docx(str(path), {"title": "T", "sections": [{"paragraphs": ["body text"]}]})
    out = dispatch.read_document(str(path))
    assert "body text" in out["markdown"]


def test_missing_file_raises():
    with pytest.raises(ToolError):
        docx_tools.read_docx("nope-does-not-exist.docx")


def test_path_escape_blocked(tmp_path, monkeypatch):
    monkeypatch.setenv("OFFICE_ROOT", str(tmp_path))
    with pytest.raises(ToolError):
        # Absolute path outside root is stripped to relative; a clearly-outside
        # traversal must still be refused.
        from office_engine.util import resolve_path
        resolve_path("../../etc/passwd", must_exist=False)
