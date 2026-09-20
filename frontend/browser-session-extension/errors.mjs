// Only fixed, extension-owned messages may cross into the popup. Browser errors
// can contain URLs, page content or credentials and must never be forwarded.
const messages = Object.freeze({
  HTTPS_REQUIRED: 'A public HTTPS origin is required for the website and PulsarTeam.',
  REQUEST_INVALID: 'The request is missing or expired. Cancel it and reconnect in PulsarTeam.',
  REQUEST_MISSING:
    'In PulsarTeam, click “Connect in my browser” and keep the connection panel open, then open the extension from that same tab.',
  REQUEST_MULTIPLE:
    'Several connection requests are open in PulsarTeam. Keep only the request for the website you want to share.',
  REQUEST_CHANGED:
    'The PulsarTeam request has changed. Cancel pairing and start again in PulsarTeam.',
  APP_UNAVAILABLE:
    'The PulsarTeam tab was closed, reloaded or its access was revoked. Cancel pairing and start again from that tab.',
  SITE_MUST_DIFFER: 'The website must be different from PulsarTeam.',
  APP_DOMAIN_FORBIDDEN: 'Do not share cookies from the PulsarTeam domain itself.',
  PARTITIONED_COOKIES:
    'This website uses partitioned cookies that cannot be transferred. Nothing was transferred.',
  AMBIGUOUS_COOKIES:
    'The website has incompatible session cookies across its domain and subdomains. Sign in with a dedicated browser profile, then try transferring again.',
  TOO_MANY_COOKIES:
    'This website has too many cookies to transfer. Use a dedicated browser profile.',
  PAIR_EXISTS: 'Cancel the previous pairing in the extension before starting again.',
  PAIR_EXPIRED: 'The request expired after ten minutes. Cancel it and reconnect in PulsarTeam.',
  PAIR_MISSING: 'No pairing is in progress. Start a new connection from the plugin in PulsarTeam.',
  PERMISSIONS_REQUIRED:
    'Permission to access cookies or websites was revoked. Cancel pairing and start again, allowing the requested permissions.',
  PERMISSION_DENIED: 'Permission denied. Nothing was transferred.',
  TRANSFER_BUSY: 'A transfer is already in progress. Wait for its result in PulsarTeam.',
  SOURCE_CHANGED:
    'After signing in, return to the selected website in the tab opened by the extension.',
  LOGIN_INCOMPLETE:
    'Finish signing in and open the account page you want to share, then transfer the session. Login pages and authentication callbacks cannot be shared.',
  SOURCE_UNAVAILABLE: 'The website tab was closed. Cancel pairing and start again in PulsarTeam.',
  COOKIE_STORE_UNAVAILABLE:
    'The browser profile for this tab could not be identified. Use Chrome or Edge outside private browsing.',
  COOKIE_ACCESS_FAILED:
    'The website cookies could not be read. Check the extension permissions for this website.',
  STORAGE_UNAVAILABLE:
    'The website local storage could not be read. Return to the selected website and try again.',
  SESSION_EMPTY:
    'There are no session cookies to transfer. Check that you are signed in; include local storage if the website uses it.',
  SESSION_TOO_LARGE:
    'The session is too large to transfer. Try without local storage or use a dedicated browser profile.',
  IMPORT_FAILED:
    'PulsarTeam rejected the transfer. Check the message displayed in the PulsarTeam plugin.',
  TRANSFER_UNCONFIRMED:
    'The transfer result could not be confirmed. Check the session status in PulsarTeam before trying again.',
  UNEXPECTED:
    'Unexpected extension error. Check the result in PulsarTeam, then reload the extension before trying again.',
});

export class ExtensionError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'UNEXPECTED';
    super(messages[safeCode]);
    this.code = safeCode;
  }
}

export function safeErrorMessage(error) {
  return error instanceof ExtensionError && Object.hasOwn(messages, error.code)
    ? messages[error.code]
    : messages.UNEXPECTED;
}
