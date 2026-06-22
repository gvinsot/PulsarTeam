# office-engine

Model-agnostic **read / edit / generate / convert** tools for **DOCX, XLSX, PPTX, PDF**,
exposed as a Streamable-HTTP **MCP server**. Because it's MCP, *any* LLM configured on
PulsarTeam (claude-code / codex / hermes / openclaw / opencode + native chat) reaches it
through the Pulsar Gateway — no per-model code.

## Two homes, one codebase
- **`office-service`** (Docker) — server-side, for files from cloud connectors / uploads.
  Registered as an external-URL builtin in `api/src/data/mcpServers.ts` via `OFFICE_SERVICE_URL`.
- **Desktop sidecar** — the same package bundled (PyInstaller) inside the local app, operating
  on the user's **local folder** (files never leave the machine; the Node bridge proxies calls).

## Stack (hybrid)
Pure libraries for read/edit/generate (no system deps): **python-docx, openpyxl, python-pptx,
pypdf, PyMuPDF, markitdown**. **LibreOffice headless** (only in `convert.py`) for high-fidelity
conversion/rendering (e.g. PPTX→PDF).

## Layout
```
office_engine/
  tools/{docx,xlsx,pptx,pdf}_tools.py   pure (path, **args) -> dict functions
  dispatch.py                           read_document (markitdown) + get_outline
  convert.py                            LibreOffice headless (the only system dep)
  mcp_server.py                         FastMCP Streamable-HTTP server (17 tools, /mcp + /health)
  util.py                               path confinement (OFFICE_ROOT), size caps, errors
tests/test_office.py                    round-trip tests (generate their own samples)
```

## Run / test
```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
python -m office_engine.mcp_server          # serves /mcp + /health on :8000
python -m pytest                            # pure-lib round-trip tests (no LibreOffice needed)
```

## Env
- `OFFICE_PORT` / `OFFICE_HOST` — listen address (default `0.0.0.0:8000`).
- `OFFICE_ROOT` — confine every path under this dir (server scratch volume / desktop folder).
- `OFFICE_SOFFICE_BIN` — explicit LibreOffice `soffice` path (else PATH / common locations).
- `OFFICE_MAX_READ_BYTES` — read size cap (default 25 MiB).

## Notes
- Edits are **round-trip** for DOCX/XLSX/PPTX (untouched content preserved); the LLM emits small
  JSON deltas, never whole-file rewrites.
- **PDF is read/extract/convert/assemble only** — to "edit" a PDF, `convert` it to DOCX, edit, convert back.
