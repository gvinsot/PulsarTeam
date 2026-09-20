import { ExtensionError } from './errors.mjs';
import { getDomain } from './vendor/tldts.mjs';

export function httpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ExtensionError('HTTPS_REQUIRED');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new ExtensionError('HTTPS_REQUIRED');
  return url.origin;
}

export function validateRequest(value, appUrl, now = Date.now()) {
  const appOrigin = httpsOrigin(appUrl);
  if (
    !value ||
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.requestId) ||
    !/^(agent|board):[a-zA-Z0-9_-]{1,200}$/.test(value.scope) ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + 610_000
  )
    throw new ExtensionError('REQUEST_INVALID');
  const site = httpsOrigin(value.site);
  if (site === appOrigin || site !== value.site) throw new ExtensionError('SITE_MUST_DIFFER');
  permissionOrigins(site, appOrigin);
  return {
    version: 1,
    requestId: value.requestId,
    scope: value.scope,
    expiresAt: value.expiresAt,
    site,
    appOrigin,
  };
}

export function sessionCookies(cookies, site, now = Date.now() / 1000) {
  const host = new URL(httpsOrigin(site)).hostname;
  const seen = new Map();
  const result = [];
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    if (!(host === domain || (!c.hostOnly && host.endsWith('.' + domain)))) continue;
    // Device/partition-bound credentials cannot be silently broadened.
    if (c.partitionKey) throw new ExtensionError('PARTITIONED_COOKIES');
    if (!c.session && c.expirationDate <= now) continue;
    const key = JSON.stringify([c.name, c.path]);
    const imported = {
      name: c.name,
      value: c.value,
      path: c.path,
      expires: c.session ? -1 : c.expirationDate,
      httpOnly: c.httpOnly,
      sameSite:
        c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'strict' ? 'Strict' : 'Lax',
    };
    const previous = seen.get(key);
    if (previous) {
      // Parent and host cookies become host-only at import. They can merge only
      // when every exported field agrees; never guess which session should win.
      if (
        previous.value !== imported.value ||
        previous.expires !== imported.expires ||
        previous.httpOnly !== imported.httpOnly ||
        previous.sameSite !== imported.sameSite
      ) {
        throw new ExtensionError('AMBIGUOUS_COOKIES');
      }
      continue;
    }
    seen.set(key, imported);
    result.push(imported);
  }
  if (result.length > 200) throw new ExtensionError('TOO_MANY_COOKIES');
  return result;
}
export function permissionOrigins(site, appOrigin) {
  const host = new URL(httpsOrigin(site)).hostname;
  const root = getDomain(host, { allowPrivateDomains: true, extractHostname: false });
  const appHost = new URL(httpsOrigin(appOrigin)).hostname;
  const appRoot = getDomain(appHost, { allowPrivateDomains: true, extractHostname: false });
  if (host === appHost || (root && root === appRoot)) {
    throw new ExtensionError('APP_DOMAIN_FORBIDDEN');
  }
  // Chrome also requires permission for the parent domain of a Domain cookie.
  // Exact hosts only, stopping before any public/private suffix; no wildcard.
  const origins = [site + '/*', appOrigin + '/*'];
  if (root) {
    let parent = host;
    while (parent !== root && parent.endsWith('.' + root)) {
      parent = parent.slice(parent.indexOf('.') + 1);
      origins.push(`https://${parent}/*`);
    }
  }
  return [...new Set(origins)];
}
