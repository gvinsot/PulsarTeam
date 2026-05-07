var params = new URLSearchParams(window.location.search);
var code = params.get('code');
var state = params.get('state');
var error = params.get('error');

var spinner = document.getElementById('spinner');
var messageEl = document.getElementById('message');

function tryClose() {
  try { window.close(); } catch (e) { /* ignored */ }
}

function showManualClose() {
  if (document.getElementById('closeBtn')) return;
  var hint = document.createElement('p');
  hint.style.cssText = 'color:#6b7280;font-size:0.85rem;margin-top:1.25rem;';
  hint.textContent = "If this window doesn't close automatically, you can close it manually.";
  var btn = document.createElement('button');
  btn.id = 'closeBtn';
  btn.type = 'button';
  btn.textContent = 'Close window';
  btn.style.cssText = 'margin-top:1rem;padding:0.5rem 1.25rem;background:#6366f1;color:#fff;border:none;border-radius:6px;font-size:0.9rem;cursor:pointer;';
  btn.onclick = tryClose;
  messageEl.parentNode.appendChild(hint);
  messageEl.parentNode.appendChild(btn);
}

function finishSuccess() {
  spinner.style.display = 'none';
  messageEl.className = 'success';
  messageEl.textContent = 'Connected! This window will close...';
  setTimeout(tryClose, 1500);
  setTimeout(tryClose, 2500);
  setTimeout(tryClose, 4000);
  setTimeout(showManualClose, 3000);
}

function finishError(msg) {
  spinner.style.display = 'none';
  messageEl.className = 'error';
  messageEl.textContent = msg;
  showManualClose();
}

if (error) {
  finishError('Error: ' + error);
} else if (code) {
  var posted = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'slack-oauth-callback', code: code, state: state }, window.location.origin);
      posted = true;
    }
  } catch (e) {
    // Opener may be inaccessible under COOP — fall through.
  }
  if (posted) {
    finishSuccess();
  } else {
    spinner.style.display = 'none';
    messageEl.textContent = 'Authorization successful. You can close this window.';
    showManualClose();
  }
} else {
  finishError('No authorization code received.');
}
