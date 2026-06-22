# Desktop app — packaging, signing & distribution (P4)

The desktop companion (`desktop/`) is a Node app shown in a native webview. A
shippable build bundles four things into one signed installer:

1. the compiled Node app (`desktop/dist`),
2. the **office-engine** as a PyInstaller binary,
3. a **portable LibreOffice** (for `convert` / `render_preview` fidelity),
4. the built **frontend** bundle (`frontend/dist`).

This is the one phase that needs a real machine + signing identities (Authenticode
cert / Apple Developer ID), so it isn't run in CI.

## 1. Build the office-engine sidecar (resolve R1 early)
```bash
cd office-engine && python -m venv .venv && .venv/bin/pip install -r requirements.txt pyinstaller
.venv/bin/pyinstaller --onedir --name office-engine \
  --collect-all fitz --collect-all docx --collect-all pptx --collect-all openpyxl \
  --collect-all markitdown -p . -c -m office_engine/mcp_server.py
# → dist/office-engine/office-engine(.exe). Set OFFICE_ENGINE_BIN to it.
```
`--onedir` (not `--onefile`): no slow per-launch temp extraction, fewer AV false
positives. Verify the native wheels (PyMuPDF/`fitz`, lxml via python-docx) load
from the bundle on a clean machine — this is the biggest packaging risk.

## 2. Bundle portable LibreOffice
- **Windows**: extract the LibreOffice install tree; ship `program/soffice.exe`.
- **macOS**: include `LibreOffice.app` inside the app bundle `Resources/`.
- **Linux**: ship the LibreOffice AppImage or a portable tree.

Set `OFFICE_SOFFICE_BIN` to the bundled `soffice`. The engine always runs it with
a throwaway profile (`--env:UserInstallation=…`), headless, no network.

## 3. Stage + single-executable
```bash
cd desktop && npm ci && npm run build && node scripts/package.mjs   # → release/<platform>/
```
Then produce one executable from `release/<platform>/`:
- **Node SEA** (`node --experimental-sea-config`) + `postject` to inject the blob into a copied `node` binary, **or**
- **pkg** (`@yao-pkg/pkg`) targeting the current OS.

Include the `webview-nodejs` native addon next to the executable.

## 4. Sign & package the installer
- **Windows**: `signtool sign /fd SHA256 /tr <timestamp> ...`; wrap with **Inno Setup** or **NSIS**.
- **macOS**: `codesign --deep --options runtime` the `.app` **including the nested
  LibreOffice.app**, then `notarytool submit` + `stapler staple`; ship a `.dmg`.
  Notarizing a ~400 MB app with nested LibreOffice is the long pole (plan R2).
- **Linux**: AppImage or `.deb`.

## 5. Distribute
Host the installers (object storage / releases page) and set **`DESKTOP_DOWNLOAD_URL`**
on the api. The in-app **Local Folder** connector
(`frontend/src/components/LocalFolderConnect.tsx`) surfaces that link when no
desktop is connected. Add auto-update later (e.g. an update manifest the app polls).

## Runtime env recap
| Var | Used by | Meaning |
|---|---|---|
| `PULSAR_SERVER_URL` | desktop | remote platform to proxy/bridge to |
| `OFFICE_ENGINE_BIN` | desktop sidecar | PyInstaller office-engine binary |
| `OFFICE_SOFFICE_BIN` | office-engine | portable LibreOffice `soffice` |
| `FRONTEND_DIST` | desktop | built frontend bundle |
| `DESKTOP_DOWNLOAD_URL` | api | download link shown in the connector |
| `OFFICE_SERVICE_URL` | api | server-side office-service MCP URL |
