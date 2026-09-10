/**
 * SSRF guard — reject URLs that point back inside the perimeter.
 *
 * The API runs on the same Docker network as `team-api`, `postgres`,
 * `mcp-browser` and every runner, so a server-side fetch of an attacker-chosen
 * URL is a direct pivot onto services that have no authentication of their own
 * beyond a shared key. The URLs concerned are not typed by a human operator:
 * they arrive from agent tool calls, and an agent's input is whatever it just
 * read — a repository README, a Jira ticket, a crawled page. Treat every one of
 * them as attacker-controlled.
 *
 * This lives in lib/ rather than next to its first caller because it now has
 * two: services/agentManager/agentFeatures.ts (RAG document ingestion, where it
 * originated) and services/browserMcp.ts (the agent-facing crawl tools, which
 * had no guard at all). A second copy would have drifted from the first.
 *
 * What it does NOT do: follow redirects. A 302 to `http://team-api:3001` defeats
 * a check that only looked at the initial URL, so every caller must either
 * re-validate each hop (`redirect: 'manual'`, see fetchPublicUrl below) or hand
 * the URL to a fetcher that guards its own hops (mcp-browser does this in
 * mcp-browser/src/server.py).
 */
import dns from 'dns/promises';
import net from 'net';

/**
 * True for any IPv4 the perimeter should never be asked to reach: RFC1918,
 * loopback, link-local (which covers the 169.254.169.254 cloud metadata
 * endpoint), CGNAT and multicast/reserved.
 *
 * Unparseable input returns true — fail closed, so a malformed address can
 * never read as "public".
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Same for IPv6: loopback, unique-local, link-local, and IPv4-mapped forms. */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped — extract and validate as IPv4
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}

/**
 * `URL.hostname` keeps the brackets on an IPv6 literal (`http://[::1]/` →
 * `[::1]`), which `net.isIP` does not recognise. Left as-is, `[::1]` fell
 * through to the DNS branch and was rejected only because the lookup happened
 * to fail — the right answer for the wrong reason, and one resolver quirk away
 * from being no answer at all. Strip them so the literal takes the literal path.
 */
function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Throw unless `url` is an http(s) URL whose host resolves exclusively to
 * public addresses.
 *
 * Every A/AAAA record is checked, not just the first: a DNS name that answers
 * with one public and one private address would otherwise pass here and be
 * connected to the private one.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = unbracket(parsed.hostname);
  if (!host) throw new Error('URL missing host');

  // If literal IP, validate directly. Otherwise resolve all A/AAAA records and
  // reject if any is private.
  const literal = net.isIP(host);
  if (literal) {
    const isPrivate = literal === 4 ? isPrivateIPv4(host) : isPrivateIPv6(host);
    if (isPrivate) throw new Error('URL resolves to a private address');
    return;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    // An unresolvable host is not a public host. Fail closed rather than let
    // the caller's own fetch decide (a resolver that answers differently at
    // connect time would then pick the target).
    throw new Error('URL host could not be resolved');
  }
  if (records.length === 0) throw new Error('URL host could not be resolved');
  for (const r of records) {
    const isPrivate = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
    if (isPrivate) throw new Error('URL resolves to a private address');
  }
}

/** True when `url` passes assertPublicUrl — for callers filtering a list. */
export async function isPublicUrl(url: string): Promise<boolean> {
  try {
    await assertPublicUrl(url);
    return true;
  } catch {
    return false;
  }
}
