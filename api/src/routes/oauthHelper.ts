import crypto from 'crypto';
import type { Response } from 'express';

export function sendOAuthResult(
  res: Response,
  provider: string,
  messageType: string,
  success: boolean,
  error?: string | null,
  extraData?: Record<string, any>,
) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
  );
  res.send(oauthResultPage(provider, messageType, success, error, extraData, nonce));
}

function oauthResultPage(
  provider: string,
  messageType: string,
  success: boolean,
  error?: string | null,
  extraData?: Record<string, any>,
  nonce?: string,
): string {
  const statusClass = success ? 'success' : 'error';
  const message = success
    ? 'Connected! This window will close...'
    : `Error: ${error || 'Unknown error'}`;

  const postMessagePayload = JSON.stringify({
    type: messageType,
    success,
    error: error || null,
    ...extraData,
  });

  return `<!DOCTYPE html>
<html><head><title>${provider} - ${success ? 'Connected' : 'Error'}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f14; color: #a0a0b0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
.container { text-align: center; padding: 2rem; }
.success { color: #34d399; }
.error { color: #f87171; }
</style></head><body>
<div class="container">
  <p class="${statusClass}">${message}</p>
</div>
<script nonce="${nonce}">
if (window.opener) {
  window.opener.postMessage(${postMessagePayload}, '*');
  ${success ? 'setTimeout(function() { window.close(); }, 1500);' : ''}
}
</script></body></html>`;
}
