/**
 * Dependency-free cookie parsing.
 *
 * The API only ever *reads* request cookies (Express' `res.cookie` writes
 * them), so a small parser is preferable to adding `cookie-parser` for a
 * single header — and it works identically for the raw `IncomingMessage`
 * headers of the WebSocket upgrade paths, which never reach Express.
 */

/**
 * Parse a `Cookie:` request header into a name → value map.
 *
 * The returned object has a null prototype so a cookie literally named
 * `__proto__` cannot poison lookups. Duplicate names keep the first value,
 * matching how browsers resolve the most specific cookie first.
 */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;

    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape must not throw away the whole header.
      out[name] = value;
    }
  }
  return out;
}

/** Read a single cookie by name. */
export function readCookie(header: string | undefined | null, name: string): string | undefined {
  return parseCookies(header)[name];
}

/**
 * Read the first cookie present from `names`, in preference order. Used for the
 * session cookie, whose name differs between production (`__Host-` prefixed)
 * and development.
 */
export function readFirstCookie(
  header: string | undefined | null,
  names: readonly string[]
): string | undefined {
  const jar = parseCookies(header);
  for (const name of names) {
    const value = jar[name];
    if (value) return value;
  }
  return undefined;
}
