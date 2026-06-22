/**
 * Assemble a distributable bundle for the desktop app.
 *
 * This stages everything a packaged build needs into `release/<platform>/` and
 * prints the remaining OS-specific steps (single-executable + code signing),
 * which require a signing identity not present in CI. Run after `npm run build`.
 *
 *   node scripts/package.mjs
 *
 * Env the staged build expects at runtime:
 *   OFFICE_ENGINE_BIN   path to the office-engine PyInstaller binary
 *   OFFICE_SOFFICE_BIN  path to portable LibreOffice's soffice
 *   FRONTEND_DIST       built frontend (staged to release/<plat>/frontend-dist)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const platform = process.platform;
const outDir = path.join(root, 'release', platform);

function copyDir(src, dst) {
  if (!fs.existsSync(src)) { console.warn(`! missing (skipped): ${src}`); return false; }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
  return true;
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Compiled app.
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) { console.error('Run `npm run build` first (no dist/).'); process.exit(1); }
  copyDir(dist, path.join(outDir, 'dist'));

  // 2. Built frontend bundle.
  const frontend = process.env.FRONTEND_DIST || path.join(root, '..', 'frontend', 'dist');
  copyDir(frontend, path.join(outDir, 'frontend-dist'));

  // 3. node_modules (production) — packagers like pkg/SEA resolve from here.
  copyDir(path.join(root, 'node_modules'), path.join(outDir, 'node_modules'));

  // 4. Sidecar + LibreOffice are large external trees; reference, don't copy here.
  const notes = [
    'Staged to: ' + outDir,
    '',
    'Remaining steps (need a signing identity — see ../docs/desktop-packaging.md):',
    '  • Bundle office-engine (PyInstaller --onedir) → set OFFICE_ENGINE_BIN',
    '  • Bundle portable LibreOffice → set OFFICE_SOFFICE_BIN',
    '  • Build a single executable: Node SEA or `pkg`',
    platform === 'win32'
      ? '  • Sign: signtool (Authenticode); installer via Inno Setup / NSIS'
      : platform === 'darwin'
        ? '  • Sign + notarize the .app (incl. nested LibreOffice.app); ship a .dmg'
        : '  • Build an AppImage / .deb',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'PACKAGING_NOTES.txt'), notes);
  console.log(notes);
}

main();
