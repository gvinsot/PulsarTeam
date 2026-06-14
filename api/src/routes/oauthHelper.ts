import crypto from 'crypto';
import type { Response } from 'express';
import type { ScopeType } from '../services/database.js';

/**
 * The core token-scoping rule shared by every OAuth plugin:
 * resolve the storage scope as agent → board → user (fallback 'default').
 */
export function resolveScope(
  agentId: string | null,
  boardId: string | null,
  username: string | undefined,
): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
}

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
.container { text-align: center; padding: 2rem; max-width: 420px; }
.success { color: #34d399; }
.error { color: #f87171; }
.hint { color: #6b7280; font-size: 0.85rem; margin-top: 1.25rem; }
.close-btn { display: none; margin-top: 1rem; padding: 0.5rem 1.25rem; background: #6366f1; color: #fff; border: none; border-radius: 6px; font-size: 0.9rem; cursor: pointer; }
.close-btn:hover { background: #4f46e5; }
</style></head><body>
<div class="container">
  <p class="${statusClass}">${message}</p>
  <p class="hint" id="hint" style="display:none;">If this window doesn't close automatically, you can close it manually.</p>
  <button class="close-btn" id="closeBtn" type="button">Close window</button>
</div>
<script nonce="${nonce}">
(function() {
  var success = ${success ? 'true' : 'false'};
  var payload = ${postMessagePayload};

  // Notify opener — wrap in try/catch in case opener is gone or COOP blocks access.
  // Restrict targetOrigin to our own origin so the OAuth result never leaks to a malicious opener.
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
  } catch (e) {
    // Ignore — opener may be cross-origin under COOP.
  }

  function tryClose() {
    try { window.close(); } catch (e) { /* ignored */ }
  }

  if (success) {
    // First attempt after 1.5s (gives opener time to react).
    setTimeout(tryClose, 1500);
    // Retry a few times in case the first close() is suppressed.
    setTimeout(tryClose, 2500);
    setTimeout(tryClose, 4000);

    // After 3s, if we are still here, reveal the manual close button.
    setTimeout(function() {
      var btn = document.getElementById('closeBtn');
      var hint = document.getElementById('hint');
      if (btn) { btn.style.display = 'inline-block'; btn.onclick = tryClose; }
      if (hint) { hint.style.display = 'block'; }
    }, 3000);
  } else {
    // On error, surface the manual-close button immediately so the user is never stuck.
    var btn = document.getElementById('closeBtn');
    var hint = document.getElementById('hint');
    if (btn) { btn.style.display = 'inline-block'; btn.onclick = tryClose; }
    if (hint) { hint.style.display = 'block'; }
  }
})();
</script></body></html>`;
}
