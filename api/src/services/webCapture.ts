/**
 * Server-side capture of the web pages an agent consults during one turn.
 *
 * The LLM API (/api/llm/v1/conversations with tools [{ type: "web_search" }])
 * reports the pages behind an answer. They are never taken from what the
 * agent says — its answer, reasoning, files or submit_answer are all text the
 * model wrote and can invent. They are recorded here, from the Web Browser
 * MCP ('mcp-browser') tool calls themselves, at the one choke point every
 * agent tool call goes through: mcpManager.callToolByNameForAgent (native
 * agents via mcp_call, CLI agents via the gateway's call_mcp_tool).
 *
 * How the data gets here: the agent-visible tool output is the Markdown text
 * browserMcp.ts builds from the mcp-browser FastAPI JSON, so the structured
 * part (search_web "results", the crawled "url") travels next to it in the
 * MCP result `_meta` under WEB_CAPTURE_META_KEY — invisible to the model and
 * to every MCP client — and mcpManager._shape hands it over through a WeakMap
 * (rememberWebMeta) without adding a field to the shaped result.
 *
 * What counts as a page:
 * - every http(s) URL of a search_web result;
 * - the URL of a crawl / crawl_many item / extract / get_links page that
 *   succeeded AND whose URL was returned by a search_web call that completed
 *   before that call started, in the same capture. A crawl of a URL the model
 *   picked up from injected text (a page, a README, a comment) does not count.
 * URLs are compared normalized (fragment dropped, trailing slash of the path
 * dropped, host lowercased). Unknown or legacy result shapes give no page —
 * nothing is ever guessed and no URL is ever downloaded to check it.
 *
 * One execution per web tool call, failed ones included (with no pages), and
 * one conversation entry per execution, in call order — the client counts its
 * searches by these entries, all named "web_search". A search_web entry
 * carries the query as arguments. A page tool entry carries '{}': its
 * arguments (a URL, an extract instruction) may come from injected text, so
 * they are never kept; and it only vouches for a URL a search already listed,
 * so after the global dedupe its result is usually empty.
 *
 * One capture per agent at a time. startWebCapture replaces a capture still
 * active for the same agent (the replaced one stops recording; its stop()
 * still returns what it had): the LLM API already refuses a second request
 * to a busy agent, so a leftover capture can only be a leak, and a leak must
 * not block the next turn.
 */

/** `_meta` key of the structured Web Browser tool data (browserMcp.ts → here). */
export const WEB_CAPTURE_META_KEY = 'pulsarteam/web-capture';

/** The built-in Web Browser MCP server — the only server whose calls are captured. */
const WEB_BROWSER_SERVER_ID = 'mcp-browser';

const SEARCH_TOOL = 'search_web';
const PAGE_TOOLS = new Set(['crawl', 'crawl_many', 'extract', 'get_links']);

/** Pages reported for one conversation, all entries together. */
const MAX_CONVERSATION_PAGES = 100;

/** Bounds on what browserMcp.ts forwards per tool result. */
const MAX_META_ITEMS = 100;

export interface ConsultedPage {
  url: string;
  title: string;
}

export interface WebToolExecution {
  name: 'web_search';
  /** The Web Browser tool called: search_web, crawl, crawl_many, extract, get_links. */
  tool: string;
  /** search_web: `{"query":…}` as JSON; a page tool: always '{}'. */
  arguments: string;
  pages: ConsultedPage[];
}

export interface WebCapture {
  /** Ends recording; returns the web tool executions in call order. Idempotent. */
  stop(): WebToolExecution[];
}

export interface ConversationToolEntry {
  object: 'entry';
  type: 'tool.execution';
  name: 'web_search';
  arguments: string;
  info: { result: ConsultedPage[] };
}

/** An in-flight web tool call, as returned by beginWebToolCall. */
export interface WebToolCall {
  finish(result: unknown): void;
}

interface CaptureState {
  recording: boolean;
  executions: WebToolExecution[];
  /** Normalized search_web result URL → sequence number of the search that returned it. */
  searchUrls: Map<string, number>;
  /** Incremented each time a search_web call completes. */
  searchSeq: number;
}

const captures = new Map<string, CaptureState>();
const webMetaByResult = new WeakMap<object, unknown>();

/** Start capturing the agent's web tool calls (replaces any active capture for it). */
export function startWebCapture(agentId: string): WebCapture {
  const previous = captures.get(agentId);
  if (previous) previous.recording = false;
  const state: CaptureState = {
    recording: true,
    executions: [],
    searchUrls: new Map(),
    searchSeq: 0,
  };
  captures.set(agentId, state);
  return {
    stop() {
      state.recording = false;
      if (captures.get(agentId) === state) captures.delete(agentId);
      return state.executions.map(e => ({ ...e, pages: e.pages.map(p => ({ ...p })) }));
    },
  };
}

/**
 * Called by mcpManager before dispatching a tool call. Returns null — after a
 * single Map lookup — unless a capture is recording for this agent and the
 * call is a Web Browser tool. Never throws.
 */
export function beginWebToolCall(
  agentId: string,
  serverId: string,
  toolName: string,
  args: unknown
): WebToolCall | null {
  try {
    const state = captures.get(agentId);
    if (!state || !state.recording || serverId !== WEB_BROWSER_SERVER_ID) return null;
    if (toolName !== SEARCH_TOOL && !PAGE_TOOLS.has(toolName)) return null;

    // The slot is taken now so entries keep call order; it is filled when the
    // call returns. A call that throws or outlives the capture keeps no pages.
    const execution: WebToolExecution = {
      name: 'web_search',
      tool: toolName,
      arguments: toolName === SEARCH_TOOL ? searchArguments(args) : '{}',
      pages: [],
    };
    state.executions.push(execution);
    const searchSeqAtStart = state.searchSeq;

    return {
      finish(result: unknown) {
        try {
          if (!state.recording) return;
          const shaped = asRecord(result);
          if (!shaped || shaped.success !== true) return;
          const meta = asRecord(webMetaByResult.get(shaped));
          if (!meta) return;

          if (toolName === SEARCH_TOOL) {
            execution.pages = searchPages(meta);
            state.searchSeq += 1;
            for (const page of execution.pages) {
              const key = normalizeUrl(page.url);
              if (key && !state.searchUrls.has(key)) state.searchUrls.set(key, state.searchSeq);
            }
            return;
          }

          // Only URLs from a search that completed before this call started.
          const known = (url: string) => {
            const key = normalizeUrl(url);
            const seq = key ? state.searchUrls.get(key) : undefined;
            return seq !== undefined && seq <= searchSeqAtStart;
          };
          const items = toolName === 'crawl_many' ? asArray(meta.pages) : [meta];
          execution.pages = items
            .map(item => crawledPage(item))
            .filter((p): p is ConsultedPage => p !== null && known(p.url));
        } catch {
          // Capture is best effort and must never affect the tool call.
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Pass `call` through, recording its outcome on `webCall` when there is one.
 * With a null webCall the very same promise is returned. The result or the
 * error of the call reaches the caller unchanged.
 */
export function trackWebToolCall<T>(webCall: WebToolCall | null, call: Promise<T>): Promise<T> {
  if (!webCall) return call;
  return call.then(
    result => {
      webCall.finish(result);
      return result;
    },
    (err: unknown) => {
      webCall.finish(undefined);
      throw err;
    }
  );
}

/** Associate the `_meta` of a raw MCP tool result with its shaped result (mcpManager._shape). */
export function rememberWebMeta(shaped: object, meta: unknown): void {
  try {
    const data = asRecord(meta)?.[WEB_CAPTURE_META_KEY];
    if (data !== undefined) webMetaByResult.set(shaped, data);
  } catch {
    // Never let capture bookkeeping fail a tool call.
  }
}

/**
 * The `_meta` browserMcp.ts attaches to a Web Browser tool result: a compact
 * projection of the mcp-browser FastAPI JSON (URLs, titles, success flags —
 * never page content). Undefined when the response carries none of it.
 */
export function browserWebMeta(response: unknown): Record<string, unknown> | undefined {
  const r = asRecord(response);
  if (!r) return undefined;
  const data: Record<string, unknown> = {};
  if (Array.isArray(r.results)) {
    data.results = r.results.slice(0, MAX_META_ITEMS).flatMap(item => {
      const i = asRecord(item);
      return i && typeof i.url === 'string'
        ? [{ url: i.url, title: typeof i.title === 'string' ? i.title : '' }]
        : [];
    });
  }
  if (Array.isArray(r.pages)) {
    data.pages = r.pages.slice(0, MAX_META_ITEMS).flatMap(item => {
      const p = pageMeta(item);
      return p ? [p] : [];
    });
  }
  const single = pageMeta(r);
  if (single) Object.assign(data, single);
  return Object.keys(data).length ? { [WEB_CAPTURE_META_KEY]: data } : undefined;
}

/**
 * Conversation entries for the executions: one per search_web execution in
 * call order, each URL reported once across all entries (first occurrence
 * wins), at most MAX_CONVERSATION_PAGES pages in total. The page tools get no
 * entry: their pages are search results already listed by then.
 */
export function toConversationToolEntries(executions: WebToolExecution[]): ConversationToolEntry[] {
  const seen = new Set<string>();
  let remaining = MAX_CONVERSATION_PAGES;
  return executions.map(execution => {
    const result: ConsultedPage[] = [];
    for (const page of execution.pages) {
      if (remaining <= 0) break;
      const key = normalizeUrl(page.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push({ url: page.url, title: page.title });
      remaining -= 1;
    }
    return {
      object: 'entry' as const,
      type: 'tool.execution' as const,
      name: 'web_search' as const,
      arguments: execution.arguments,
      info: { result },
    };
  });
}

/**
 * Comparison key of an http(s) URL: fragment dropped, trailing slash of the
 * path dropped, host lowercased (by URL). Null for anything else.
 */
export function normalizeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.host) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
}

function searchPages(meta: Record<string, unknown>): ConsultedPage[] {
  return asArray(meta.results).flatMap(item => {
    const r = asRecord(item);
    if (!r || typeof r.url !== 'string' || !normalizeUrl(r.url)) return [];
    return [{ url: r.url, title: typeof r.title === 'string' ? r.title : '' }];
  });
}

function crawledPage(item: unknown): ConsultedPage | null {
  const p = asRecord(item);
  if (!p || p.ok !== true || typeof p.url !== 'string' || !normalizeUrl(p.url)) return null;
  return { url: p.url, title: typeof p.title === 'string' ? p.title : '' };
}

/** {url, title?, ok} of one crawled page in the FastAPI JSON; null without a url. */
function pageMeta(item: unknown): Record<string, unknown> | null {
  const p = asRecord(item);
  if (!p || typeof p.url !== 'string') return null;
  return {
    url: p.url,
    ...(typeof p.title === 'string' ? { title: p.title } : {}),
    ok: p.error === undefined || p.error === null,
  };
}

/** `{"query":…}` of a search_web call, nothing else of its arguments; '{}' without a query. */
function searchArguments(args: unknown): string {
  try {
    const query = asRecord(args)?.query;
    return typeof query === 'string' ? JSON.stringify({ query }) : '{}';
  } catch {
    return '{}';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
