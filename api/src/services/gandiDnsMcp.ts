import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const GANDI_API = 'https://api.gandi.net/v5/livedns';

/**
 * Call the Gandi LiveDNS API.
 * @param {string} pat  – Personal Access Token
 * @param {string} path – API path (appended to base URL)
 * @param {object} [options] – fetch options (method, body, …)
 */
async function gandiRequest(pat: string, path: string, options: Record<string, any> = {}) {
  const url = `${GANDI_API}${path}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    ...options,
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gandi API ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

export function createGandiDnsMcpServer(mcpManager) {
  const server = new McpServer({ name: 'Gandi DNS', version: '1.0.0' });

  /** Resolve the Gandi PAT from the MCP server config (apiKey field). */
  function getPat() {
    const srv = mcpManager.servers.get('mcp-gandi-dns');
    const pat = srv?.apiKey;
    if (!pat) {
      throw new Error(
        'Gandi PAT not configured. Set the API key in the Gandi DNS MCP server settings (Admin Panel → MCP Servers).'
      );
    }
    return pat;
  }

  // ── List domains ──────────────────────────────────────────────────────

  server.tool(
    'list_domains',
    'List all domains managed by Gandi LiveDNS.',
    {},
    async () => {
      const pat = getPat();
      const domains = await gandiRequest(pat, '/domains');
      const summary = domains.length
        ? domains.map((d) => `- ${d.fqdn}`).join('\n')
        : 'No domains found.';
      return {
        content: [{ type: 'text', text: `${summary}\n\nJSON:\n${JSON.stringify(domains, null, 2)}` }],
      };
    }
  );

  // ── List records ──────────────────────────────────────────────────────

  server.tool(
    'list_records',
    'List all DNS records for a domain.',
    {
      domain: z.string().describe('Fully qualified domain name, e.g. "example.com"'),
    },
    async ({ domain }) => {
      const pat = getPat();
      const records = await gandiRequest(pat, `/domains/${encodeURIComponent(domain)}/records`);
      const summary = records.length
        ? records.map((r) => `${r.rrset_name}\t${r.rrset_type}\t${r.rrset_ttl}\t${r.rrset_values.join(', ')}`).join('\n')
        : 'No records found.';
      return {
        content: [{ type: 'text', text: `Records for ${domain}:\n${summary}\n\nJSON:\n${JSON.stringify(records, null, 2)}` }],
      };
    }
  );

  // ── Get record ────────────────────────────────────────────────────────

  server.tool(
    'get_record',
    'Get a specific DNS record by name and type.',
    {
      domain: z.string().describe('Fully qualified domain name, e.g. "example.com"'),
      name: z.string().describe('Record name (subdomain), e.g. "www" or "@" for apex'),
      type: z.string().describe('Record type: A, AAAA, CNAME, MX, TXT, SRV, NS, etc.'),
    },
    async ({ domain, name, type }) => {
      const pat = getPat();
      const record = await gandiRequest(
        pat,
        `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(name)}/${encodeURIComponent(type)}`
      );
      return {
        content: [{ type: 'text', text: `${name}.${domain} ${type}:\n${JSON.stringify(record, null, 2)}` }],
      };
    }
  );

  // ── Create record ─────────────────────────────────────────────────────

  server.tool(
    'create_record',
    'Create a new DNS record (e.g. A record pointing a subdomain to an IP).',
    {
      domain: z.string().describe('Fully qualified domain name, e.g. "example.com"'),
      name: z.string().describe('Record name (subdomain), e.g. "api", "www", or "@" for apex'),
      type: z.string().describe('Record type: A, AAAA, CNAME, MX, TXT, SRV, NS, etc.'),
      values: z.array(z.string()).describe('Record values, e.g. ["1.2.3.4"] for A, ["target.example.com."] for CNAME'),
      ttl: z.number().int().min(300).max(2592000).optional().describe('TTL in seconds (default 300)'),
    },
    async ({ domain, name, type, values, ttl = 300 }) => {
      const pat = getPat();
      const body = {
        rrset_name: name,
        rrset_type: type,
        rrset_values: values,
        rrset_ttl: ttl,
      };
      const result = await gandiRequest(pat, `/domains/${encodeURIComponent(domain)}/records`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        content: [{
          type: 'text',
          text: `✅ Created ${type} record: ${name}.${domain} → ${values.join(', ')} (TTL ${ttl}s)\n\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    }
  );

  return server;
}

// ─── Express Handler ─────────────────────────────────────────────────────────

export function createGandiDnsMcpHandler(mcpManager) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createGandiDnsMcpServer(mcpManager);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[Gandi DNS MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
