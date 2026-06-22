/**
 * Native window via the OS webview (WebView2 on Windows, WKWebView on macOS,
 * WebKitGTK on Linux) through the lightweight `webview-nodejs` binding — no
 * bundled Chromium. If the native webview can't load (missing runtime, headless
 * CI), fall back to opening the URL in the user's default browser so the app is
 * still usable.
 */
import { spawn } from 'child_process';

function openInBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log(`🌐 Opened ${url} in the default browser (native webview unavailable).`);
}

/** Open the native window. Resolves when the window is closed (native path) or
 * immediately after launching the browser fallback. */
export async function openWindow(url: string): Promise<void> {
  try {
    // Dynamic import via a NON-literal specifier so the build never hard-requires
    // the native module (it ships only in packaged binaries); a missing/failed
    // native module degrades gracefully to the browser fallback below.
    const spec = 'webview-nodejs';
    const mod: any = await import(spec);
    const Webview = mod.Webview || mod.default?.Webview || mod.default;
    const w = new Webview(true); // debug=true; second-arg/window handle vary by version
    w.title?.('PulsarTeam');
    w.size?.(1280, 860);
    w.navigate(url);
    // .show()/.run() block until the window closes, depending on version.
    if (typeof w.show === 'function') w.show();
    else if (typeof w.run === 'function') w.run();
  } catch (err: any) {
    console.warn('Native webview failed:', err?.message);
    openInBrowser(url);
    // Keep the process alive so the local server + bridge stay up.
    await new Promise(() => {});
  }
}
