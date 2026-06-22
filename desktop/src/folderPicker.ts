/**
 * Native "choose folder" dialog without Electron — shell out to the OS picker.
 * This is the one capability a bare webview lacks; a tiny per-platform spawn
 * keeps the app dependency-light while still feeling native.
 */
import { execFile } from 'child_process';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve('');
      resolve((stdout || '').trim());
    });
  });
}

export async function pickFolder(): Promise<string | null> {
  if (process.platform === 'win32') {
    // Windows Forms folder browser via PowerShell.
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      'if ($d.ShowDialog() -eq "OK") { [Console]::Out.Write($d.SelectedPath) }',
    ].join(' ');
    const out = await run('powershell', ['-NoProfile', '-STA', '-Command', ps]);
    return out || null;
  }
  if (process.platform === 'darwin') {
    const out = await run('osascript', ['-e', 'POSIX path of (choose folder)']);
    return out || null;
  }
  // Linux: try zenity then kdialog.
  const zen = await run('zenity', ['--file-selection', '--directory']);
  if (zen) return zen;
  const kd = await run('kdialog', ['--getexistingdirectory', process.env.HOME || '.']);
  return kd || null;
}
