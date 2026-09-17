export function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new Error('Une origine HTTPS est requise.');
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
    throw new Error('Demande absente ou expirée. Recommencez dans PulsarTeam.');
  const site = httpsOrigin(value.site);
  if (site === appOrigin || site !== value.site)
    throw new Error('Le site doit être distinct de PulsarTeam.');
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
  const seen = new Set();
  const result = [];
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    if (!(host === domain || (!c.hostOnly && host.endsWith('.' + domain)))) continue;
    // Device/partition-bound credentials cannot be silently broadened.
    if (c.partitionKey) throw new Error('Les cookies partitionnés ne sont pas pris en charge.');
    if (!c.session && c.expirationDate <= now) continue;
    const key = JSON.stringify([c.name, c.path]);
    if (seen.has(key))
      throw new Error('Cookies ambigus pour ce site. Utilisez un profil navigateur dédié.');
    seen.add(key);
    result.push({
      name: c.name,
      value: c.value,
      path: c.path,
      expires: c.session ? -1 : c.expirationDate,
      httpOnly: c.httpOnly,
      sameSite:
        c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'strict' ? 'Strict' : 'Lax',
    });
  }
  if (result.length > 200) throw new Error('Trop de cookies pour ce site.');
  return result;
}
import { getDomain } from './vendor/tldts.mjs';

export function permissionOrigins(site, appOrigin) {
  const host = new URL(httpsOrigin(site)).hostname;
  const root = getDomain(host, { allowPrivateDomains: true, extractHostname: false });
  const appHost = new URL(httpsOrigin(appOrigin)).hostname;
  const appRoot = getDomain(appHost, { allowPrivateDomains: true, extractHostname: false });
  if (host === appHost || (root && root === appRoot)) {
    throw new Error('Ne partagez pas les cookies du domaine PulsarTeam lui-même.');
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
