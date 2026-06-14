/**
 * Shared fetch factory for the per-provider REST helpers used by the MCP
 * services (Gmail, Microsoft Graph, Drive, GitHub, Jira, WordPress).
 *
 * Each provider keeps its own call signature and wire behaviour — this module
 * only owns the common skeleton: resolve per-agent auth, prefix the base URL
 * unless the path is absolute, fetch with an abort timeout, merge headers,
 * throw on !res.ok, and parse the response.
 */

type ProviderAuth = {
  /** Full Authorization header value, e.g. "Bearer x" or "Basic y". */
  authorization: string;
  /** Base URL prefixed to non-absolute paths (may be per-agent, e.g. Jira/WP). */
  base: string;
};

type ProviderFetchConfig = {
  /** Full error label, e.g. "Gmail API error" or "Microsoft Graph error". */
  errorLabel: string;
  /** Resolve per-agent credentials into an auth header + base URL. */
  getAuth: (
    agentId: string | null,
    boardId: string | null,
  ) => ProviderAuth | Promise<ProviderAuth>;
  /** Extra headers sent on every request (overridable per call). */
  defaultHeaders?: Record<string, string>;
  /** Request timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Timeout used when options.raw is set (gdrive download/export). */
  rawTimeoutMs?: number;
  /** HTTP statuses resolved to null (e.g. 202/204 no-content). */
  nullStatuses?: number[];
  /**
   * Content-Type policy:
   *  - 'always': send "application/json" unless overridden (default)
   *  - 'onlyStringBody': send it only when options.body is a string and the
   *    caller didn't provide one (binary uploads send their own)
   *  - 'none': never set a default Content-Type
   */
  contentType?: 'always' | 'onlyStringBody' | 'none';
  /** Response parsing: by content-type header (default) or always JSON. */
  parse?: 'contentType' | 'json';
  /** When set, error bodies are read fail-safe and truncated to this length. */
  maxErrorChars?: number;
};

export function createProviderFetch(cfg: ProviderFetchConfig) {
  const contentTypePolicy = cfg.contentType || 'always';
  const parseMode = cfg.parse || 'contentType';

  return async function providerFetch(
    path: string,
    agentId: string | null = null,
    boardId: string | null = null,
    options: Record<string, any> = {},
  ): Promise<any> {
    const { authorization, base } = await cfg.getAuth(agentId, boardId);
    const url = path.startsWith('http') ? path : `${base}${path}`;

    const headers: Record<string, string> = {
      Authorization: authorization,
      ...(contentTypePolicy === 'always' ? { 'Content-Type': 'application/json' } : {}),
      ...(cfg.defaultHeaders || {}),
      ...(options.headers || {}),
    };
    if (
      contentTypePolicy === 'onlyStringBody' &&
      options.body && !headers['Content-Type'] && typeof options.body === 'string'
    ) {
      headers['Content-Type'] = 'application/json';
    }

    const timeoutMs = options.raw
      ? (cfg.rawTimeoutMs ?? cfg.timeoutMs ?? 60_000)
      : (cfg.timeoutMs ?? 60_000);

    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options, headers });

    if (!res.ok) {
      const text = cfg.maxErrorChars !== undefined
        ? (await res.text().catch(() => '')).slice(0, cfg.maxErrorChars)
        : await res.text();
      throw new Error(`${cfg.errorLabel} ${res.status}: ${text}`);
    }

    if (cfg.nullStatuses?.includes(res.status)) return null;
    if (options.raw) return res;

    if (parseMode === 'json') return res.json();
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  };
}

/**
 * Read a fetch Response body with a hard byte cap as a backstop — upstream
 * size metadata can be stale or absent, and an unbounded read of a huge file
 * would blow up the heap. Streams via getReader() and aborts as soon as the
 * running total exceeds maxBytes, with an arrayBuffer fallback when no
 * reader is available.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`File too large to read (${(buf.length / 1024 / 1024).toFixed(1)} MB; max ${(maxBytes / 1024 / 1024).toFixed(1)} MB).`);
    }
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`File too large to read (>${(maxBytes / 1024 / 1024).toFixed(1)} MB).`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}
