"""Office engine — model-agnostic read/edit/generate/convert for DOCX/XLSX/PPTX/PDF.

One codebase, two homes:
  * server-side `office-service` (Docker) for cloud/upload files;
  * bundled sidecar inside the desktop app for the user's LOCAL folder.

The `tools/` functions are PURE `(path, **args) -> dict` — no MCP dependency, so
they are unit-testable on their own. `mcp_server.py` wraps them as a Streamable
HTTP MCP server (the transport api/src/services/mcpClient.ts connects with).
"""

__version__ = "0.1.0"
