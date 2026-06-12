import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const BROWSER_SERVICE_URL = process.env.BROWSER_SERVICE_URL || 'http://mcp-browser:8000';

async function browserRequest(path: string, body: any) {
  const url = `${BROWSER_SERVICE_URL}${path}`;
  // Generous budget: mcp-browser uses 30s per-page timeouts and crawl_many /
  // extract fan out over multiple pages. Without an abort signal a wedged
  // upstream pins this handler for undici's ~300s defaults.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`mcp-browser ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export function createBrowserMcpServer() {
  const server = new McpServer({ name: 'Web Browser', version: '1.0.0' });

  server.tool(
    'search_web',
    'Search the web (DuckDuckGo) and return results as clean Markdown.',
    {
      query: z.string().describe('Search query'),
    },
    async ({ query }) => {
      const result = await browserRequest('/search_web', { query });
      const text = result?.content ?? result?.error ?? 'No content.';
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'crawl',
    'Crawl a single webpage and return its content as clean Markdown. Boilerplate (nav, footer, ads) is filtered out.',
    {
      url: z.string().describe('The URL to crawl'),
      word_count_threshold: z.number().int().min(0).optional().describe('Minimum words per content block to keep (default 10)'),
    },
    async ({ url, word_count_threshold = 10 }) => {
      const result = await browserRequest('/crawl', { url, word_count_threshold });
      const text = result?.content ?? result?.error ?? 'No content.';
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'crawl_many',
    'Crawl multiple webpages in parallel and return each page as clean Markdown.',
    {
      urls: z.array(z.string()).describe('List of URLs to crawl'),
      word_count_threshold: z.number().int().min(0).optional().describe('Minimum words per content block to keep (default 10)'),
    },
    async ({ urls, word_count_threshold = 10 }) => {
      const result = await browserRequest('/crawl_many', { urls, word_count_threshold });
      const pages = result?.pages ?? [];
      const text = pages.length
        ? pages.map((p: any) => `## ${p.url}\n\n${p.content || p.error || ''}`).join('\n\n---\n\n')
        : (result?.error ?? 'No pages.');
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'get_links',
    'Extract all hyperlinks (internal and external) from a webpage, excluding nav/footer/header noise.',
    {
      url: z.string().describe('The URL to extract links from'),
    },
    async ({ url }) => {
      const result = await browserRequest('/get_links', { url });
      const text = result?.error ? result.error : JSON.stringify(result?.links ?? {}, null, 2);
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'extract',
    'Extract structured data from a webpage using the configured LLM. Returns free-form text or JSON conforming to an optional schema.',
    {
      url: z.string().describe('The URL to extract data from'),
      instruction: z.string().describe('Natural-language description of what to extract'),
      schema_json: z.string().optional().describe('Optional JSON-schema string for structured output'),
    },
    async ({ url, instruction, schema_json = '' }) => {
      const result = await browserRequest('/extract', { url, instruction, schema_json });
      const text = result?.content ?? result?.error ?? 'No content.';
      return { content: [{ type: 'text', text }] };
    }
  );

  return server;
}

export function createBrowserMcpHandler() {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createBrowserMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error('[Browser MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
