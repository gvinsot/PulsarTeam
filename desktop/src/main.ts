/**
 * PulsarTeam desktop entry point.
 *
 * Boots the local web host (which proxies to the platform and captures the
 * user's token for the bridge), opens the native webview window, and tears the
 * bridge + sidecar down on exit. The bridge connects lazily once the user logs
 * in inside the webview (token sniffed off the first /api call) and starts
 * serving file/office tool calls once a folder is shared.
 */
import { startServer } from './server.js';
import { openWindow } from './window.js';
import { bridge } from './bridge.js';

async function shutdown(code = 0): Promise<void> {
  try { await bridge.stop(); } catch { /* ignore */ }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main(): Promise<void> {
  const { url } = await startServer();
  await openWindow(url); // resolves when the native window closes
  await shutdown(0);
}

main().catch(err => {
  console.error('fatal:', err);
  shutdown(1);
});
