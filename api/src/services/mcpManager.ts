import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getJwtSecret } from '../middleware/auth.js';
import { getAllMcpServers, saveMcpServer, deleteMcpServerFromDb } from './database.js';
import { BUILTIN_MCP_SERVERS } from '../data/mcpServers.js';
import { MCPClient } from './mcpClient.js';

function extractMcpResult(content: any[]) {
  const textParts = content.filter((c: any) => c.type === 'text').map((c: any) => c.text);
  const images = content
    .filter((c: any) => c.type === 'image' && c.data && c.mimeType)
    .map((c: any) => ({ data: c.data, mediaType: c.mimeType }));
  return {
    text: textParts.join('\n') || JSON.stringify(content),
    images: images.length > 0 ? images : undefined,
  };
}

export function resolveInternalMcpConfig(serverUrl: string, {
  port = process.env.PORT || 3001,
  jwtSecret = null,
  expiresIn = '1h',
}: { port?: string | number; jwtSecret?: string | null; expiresIn?: SignOptions['expiresIn'] } = {}) {
  const mappings = {
    '__internal__onedrive': `http://localhost:${port}/api/onedrive/mcp`,
    '__internal__code_index': `http://localhost:${port}/api/code-index/mcp`,
    '__internal__code-index': `http://localhost:${port}/api/code-index/mcp`,
    '__internal__gandi_dns': `http://localhost:${port}/api/gandi-dns/mcp`,
    '__internal__swarm_api': `http://localhost:${port}/api/swarm-api/mcp`,
    '__internal__gmail': `http://localhost:${port}/api/gmail/mcp`,
    '__internal__outlook': `http://localhost:${port}/api/outlook/mcp`,
    '__internal__gdrive': `http://localhost:${port}/api/gdrive/mcp`,
    '__internal__slack': `http://localhost:${port}/api/slack/mcp`,
    '__internal__jira': `http://localhost:${port}/api/jira/mcp`,
    '__internal__wordpress': `http://localhost:${port}/api/wordpress/mcp`,
    '__internal__github': `http://localhost:${port}/api/github/mcp`,
    '__internal__aws_s3': `http://localhost:${port}/api/s3/mcp`,
    '__internal__auto_learn': `http://localhost:${port}/api/auto-learn/mcp`,
    '__internal__browser': `http://localhost:${port}/api/browser/mcp`,
  };

  if (!mappings[serverUrl]) {
    return { url: serverUrl, headers: {} };
  }

  const token = jwt.sign(
    { username: 'internal-mcp', role: 'admin', internal: true },
    jwtSecret || getJwtSecret(),
    { expiresIn }
  );

  return {
    url: mappings[serverUrl],
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

/**
 * Manages MCP server registrations, connections, and tool execution.
 * Follows the same pattern as SkillManager: in-memory Map + DB persistence.
 */

export function findBuiltinMcpServer(identifier: any) {
  if (!identifier) return null;
  const value = String(identifier).toLowerCase();
  return BUILTIN_MCP_SERVERS.find(
    (server) => server.id.toLowerCase() === value || server.name.toLowerCase() === value
  ) || null;
}

function createBuiltinServerEntry(def: any) {
  return {
    ...def,
    tools: [],
    status: 'disconnected',
    error: null,
    createdAt: null,
    updatedAt: null,
  };
}

function slugMcpName(value: string): string {
  return String(value || 'mcp')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'mcp';
}

export class MCPManager {
  servers: Map<string, any>;
  clients: Map<string, any>;
  agentClients: Map<string, any>;
  _inflightConnects: Map<string, Promise<any>>;

  constructor() {
    this.servers = new Map();   // id -> server config (with tools[], status, etc.)
    this.clients = new Map();   // id -> MCPClient instance (global/test connections)
    this.agentClients = new Map(); // "agentId:serverId" -> MCPClient (per-agent connections)
    this._inflightConnects = new Map(); // dedup key -> in-flight connect promise
  }

  /**
   * Deduplicate concurrent connect attempts for the same key: callers racing
   * on the same server/agent share one connect instead of each opening a
   * connection and leaking all but the last one cached.
   */
  _dedupedConnect(key: string, factory: () => Promise<any>): Promise<any> {
    let pending = this._inflightConnects.get(key);
    if (!pending) {
      pending = factory().finally(() => this._inflightConnects.delete(key));
      this._inflightConnects.set(key, pending);
    }
    return pending;
  }

  /**
   * Create, connect, and cache a per-agent MCP client (deduped per cacheKey).
   * Internal headers take precedence over extraHeaders on key collisions.
   */
  _connectAgentClient(cacheKey: string, server: any, extraHeaders: Record<string, string>): Promise<any> {
    return this._dedupedConnect(cacheKey, async () => {
      console.log(`🔌 [MCP] Creating per-agent connection key=${cacheKey.slice(0, 8)}… server="${server.name}"`);
      const client = new MCPClient('PulsarTeam');
      const internalConfig = resolveInternalMcpConfig(server.url);
      const connectOpts = { headers: { ...extraHeaders, ...internalConfig.headers } };
      await client.connect(internalConfig.url || server.url, connectOpts);
      this.agentClients.set(cacheKey, client);
      return client;
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async ensureBuiltinServerRegistered(identifier) {
    const existingById = this.servers.get(identifier);
    if (existingById) return existingById;

    const builtin = findBuiltinMcpServer(identifier);
    if (!builtin) return null;

    const existingByBuiltinId = this.servers.get(builtin.id);
    if (existingByBuiltinId) return existingByBuiltinId;

    const entry = {
      ...builtin,
      tools: [],
      status: 'disconnected',
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.servers.set(entry.id, entry);
    await saveMcpServer(entry);
    return entry;
  }


  async loadFromDatabase() {
    const servers = await getAllMcpServers();
    const activeBuiltinIds = new Set(BUILTIN_MCP_SERVERS.map(s => s.id));
    let retiredBuiltins = 0;

    for (const server of servers) {
      // Remove retired built-in servers from DB
      if (server.builtin && !activeBuiltinIds.has(server.id)) {
        await deleteMcpServerFromDb(server.id);
        retiredBuiltins++;
        continue;
      }
      server.status = 'disconnected';
      server.tools = server.tools || [];
      this.servers.set(server.id, server);
    }
    console.log(`✅ Loaded ${this.servers.size} MCP servers from database`);
    if (retiredBuiltins > 0) {
      console.log(`🧹 Removed ${retiredBuiltins} retired built-in MCP server(s)`);
    }
  }

  async seedDefaults(defaults) {
    let seeded = 0;
    let updated = 0;

    for (const def of defaults) {
      if (!this.servers.has(def.id)) {
        const entry = {
          ...def,
          tools: [],
          status: 'disconnected',
          error: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        this.servers.set(entry.id, entry);
        await saveMcpServer(entry);
        seeded++;
      } else if (def.builtin) {
        const existing = this.servers.get(def.id);
        const entry = {
          ...existing,
          id: def.id,
          name: def.name,
          url: def.url,
          description: def.description,
          icon: def.icon,
          builtin: true,
          enabled: existing.enabled !== undefined ? existing.enabled : def.enabled !== false,
          apiKey: existing.apiKey || '',
          tools: existing.tools || [],
          status: existing.status || 'disconnected',
          error: existing.error || null,
          updatedAt: new Date().toISOString(),
        };
        this.servers.set(entry.id, entry);
        await saveMcpServer(entry);
        updated++;
      }
    }

    if (seeded > 0) {
      console.log(`✅ Seeded ${seeded} built-in MCP server(s)`);
    }
    if (updated > 0) {
      console.log(`✅ Updated ${updated} built-in MCP server(s)`);
    }
  }

  /**
   * Connect to all enabled servers (called on startup).
   * Skips servers that require per-agent auth (no global apiKey, external URL).
   * Errors are logged but don't block startup.
   */
  async connectAll() {
    const enabled = Array.from(this.servers.values()).filter(s => {
      if (s.enabled === false) return false;
      // Skip external servers without apiKey — they need per-agent auth
      if (!s.apiKey && s.url && !s.url.startsWith('__internal__')) {
        const internal = resolveInternalMcpConfig(s.url);
        if (Object.keys(internal.headers).length === 0) {
          console.log(`⏭️ [MCP] Skipping "${s.name}" — requires per-agent API key`);
          return false;
        }
      }
      return true;
    });
    const results = await Promise.allSettled(
      enabled.map(s => this.connect(s.id))
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    if (enabled.length > 0) {
      console.log(`🔌 [MCP] Connected ${ok}/${enabled.length} servers${fail > 0 ? ` (${fail} failed)` : ''}`);
    }
  }

  async disconnectAll() {
    for (const [id] of this.clients) {
      await this.disconnect(id);
    }
    for (const [key, client] of this.agentClients) {
      await client.close().catch(() => {});
    }
    this.agentClients.clear();
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  getAll() {
    const servers = Array.from(this.servers.values());
    const seen = new Set(servers.map((server) => server.id));
    for (const builtin of BUILTIN_MCP_SERVERS) {
      if (!seen.has(builtin.id)) {
        servers.push(createBuiltinServerEntry(builtin));
      }
    }
    return servers;
  }

  getById(id) {
    return this.servers.get(id) || (findBuiltinMcpServer(id) ? createBuiltinServerEntry(findBuiltinMcpServer(id)) : null);
  }

  async create(config) {
    // Validate MCP server URL — must be a valid http(s) or sse URL
    if (config.url) {
      try {
        const parsed = new URL(config.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(`Invalid MCP server URL protocol: ${parsed.protocol}. Only http/https allowed.`);
        }
        // Block localhost/private IPs to prevent SSRF (except for internal services)
        const hostname = parsed.hostname.toLowerCase();
        if (hostname === '169.254.169.254' || hostname.startsWith('169.254.')) {
          throw new Error('MCP server URL points to cloud metadata service — blocked for security');
        }
      } catch (err) {
        if (err.message.includes('Invalid URL')) {
          throw new Error(`Invalid MCP server URL: ${config.url}`);
        }
        throw err;
      }
    }

    const id = uuidv4();
    const server = {
      id,
      name: config.name || 'Unnamed Server',
      url: config.url || '',
      description: config.description || '',
      icon: config.icon || '🔌',
      apiKey: config.apiKey || '',
      builtin: false,
      enabled: config.enabled !== false,
      tools: [],
      status: 'disconnected',
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.servers.set(id, server);
    await saveMcpServer(server);

    if (server.enabled && server.url) {
      this.connect(id).catch(() => {});
    }

    return server;
  }

  async update(id, updates) {
    const server = this.servers.get(id);
    if (!server) return null;

    const allowed = ['name', 'url', 'description', 'icon', 'enabled', 'apiKey'];
    const urlChanged = updates.url !== undefined && updates.url !== server.url;
    const apiKeyChanged = updates.apiKey !== undefined && updates.apiKey !== server.apiKey;

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        server[key] = updates[key];
      }
    }
    server.updatedAt = new Date().toISOString();
    await saveMcpServer(server);

    if (urlChanged || apiKeyChanged || updates.enabled !== undefined) {
      if (server.enabled && server.url) {
        this.connect(id).catch(() => {});
      } else {
        await this.disconnect(id);
      }
    }

    return server;
  }

  async delete(id) {
    const server = this.servers.get(id);
    if (!server) return false;

    await this.disconnect(id);
    this.servers.delete(id);
    await deleteMcpServerFromDb(id);
    return true;
  }

  // ── Connection Management ───────────────────────────────────────────

  connect(id) {
    return this._dedupedConnect(`global:${id}`, () => this._connectServer(id));
  }

  async _connectServer(id) {
    let server = this.servers.get(id);
    if (!server) {
      server = await this.ensureBuiltinServerRegistered(id);
    }
    if (!server) throw new Error(`MCP server ${id} not found`);
    if (!server.url) throw new Error(`MCP server "${server.name}" has no URL`);

    await this.disconnect(id);

    server.status = 'connecting';
    server.error = null;

    try {
      const client = new MCPClient('PulsarTeam');
      const connectOpts: { headers?: Record<string, string> } = {};

      if (server.apiKey) {
        connectOpts.headers = { Authorization: `Bearer ${server.apiKey}` };
      }

      const internalConfig = resolveInternalMcpConfig(server.url);
      let connectUrl = internalConfig.url;

      if (Object.keys(internalConfig.headers).length > 0) {
        connectOpts.headers = {
          ...(connectOpts.headers || {}),
          ...internalConfig.headers,
        };
      }

      const { tools } = await client.connect(connectUrl, connectOpts);

      this.clients.set(id, client);
      server.tools = tools.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {}
      }));
      server.status = 'connected';
      server.error = null;
      await saveMcpServer(server);

      console.log(`🔌 [MCP] "${server.name}" connected — ${tools.length} tool(s) discovered`);
      return server;
    } catch (err) {
      server.status = 'error';
      server.error = err.message;
      server.tools = [];
      await saveMcpServer(server);
      console.error(`❌ [MCP] "${server.name}" connection failed: ${err.message}`);
      throw err;
    }
  }

  async disconnect(id) {
    const client = this.clients.get(id);
    if (client) {
      await client.close();
      this.clients.delete(id);
    }
    const server = this.servers.get(id);
    if (server) {
      server.status = 'disconnected';
    }
  }

  // ── Tool Execution ──────────────────────────────────────────────────

  async callTool(serverId, toolName, args = {}) {
    let client = this.clients.get(serverId);
    const server = this.servers.get(serverId);
    if (!server) throw new Error(`MCP server not connected: ${serverId}`);
    if (!client) {
      // No global client (e.g. tools were discovered via a per-agent
      // connection). Only attempt a global connect when global auth exists —
      // an unauthenticated connect would fail and wipe the discovered tools.
      const internal = resolveInternalMcpConfig(server.url);
      if (server.apiKey || Object.keys(internal.headers).length > 0) {
        await this.connect(serverId);
        client = this.clients.get(serverId);
      }
      if (!client) {
        throw new Error(`MCP server "${server.name}" requires a per-agent API key — set it in the agent's Plugins tab`);
      }
    }

    try {
      const result = await client.callTool(toolName, args);
      const extracted = extractMcpResult(result.content);
      return {
        success: !result.isError,
        result: extracted.text,
        images: extracted.images,
        raw: result.content
      };
    } catch (err) {
      if (err.message?.includes('404') || err.message?.includes('session') || err.message?.includes('Invalid token') || err.message?.includes('token') || err.message?.includes('401')) {
        console.log(`🔌 [MCP] Session/token expired for "${server.name}", reconnecting...`);
        try {
          await this.connect(serverId);
          const retryClient = this.clients.get(serverId);
          if (retryClient) {
            const result = await retryClient.callTool(toolName, args);
            const extracted = extractMcpResult(result.content);
            return {
              success: !result.isError,
              result: extracted.text,
              images: extracted.images,
              raw: result.content
            };
          }
        } catch (retryErr) {
          throw new Error(`MCP call failed after reconnect: ${retryErr.message}`);
        }
      }
      throw err;
    }
  }

  async callToolByName(serverName, toolName, args = {}) {
    let server = Array.from(this.servers.values()).find(
      s => s.name.toLowerCase() === serverName.toLowerCase()
    );

    if (!server) {
      server = await this.ensureBuiltinServerRegistered(serverName);
    }

    if (!server) {
      const availableNames = this.getAll().map(s => s.name);
      throw new Error(`MCP server "${serverName}" not found. Available servers: ${availableNames.join(', ') || 'none'}`);
    }

    if (server.status !== 'connected') {
      console.log(`🔌 [MCP] "${server.name}" is ${server.status}, attempting reconnect for ${toolName}...`);
      try {
        await this.connect(server.id);
      } catch (err) {
        throw new Error(`MCP server "${server.name}" is not connected and reconnect failed: ${err.message}`);
      }
    }

    return this.callTool(server.id, toolName, args);
  }

  /**
   * Call an MCP tool on behalf of an agent, using per-agent auth if configured.
   * Falls back to the global connection when no agent-specific auth exists.
   */
  async callToolByNameForAgent(serverName, toolName, args = {}, agentId = null, agentMcpAuth = {}, boardId = null) {
    let server = Array.from(this.servers.values()).find(
      s => s.name.toLowerCase() === serverName.toLowerCase()
    );
    if (!server) server = await this.ensureBuiltinServerRegistered(serverName);
    if (!server) {
      const availableNames = this.getAll().map(s => s.name);
      throw new Error(`MCP server "${serverName}" not found. Available servers: ${availableNames.join(', ') || 'none'}`);
    }

    // Check if agent has custom auth for this server
    const agentAuth = agentMcpAuth[server.id];
    if (agentId && agentAuth?.apiKey) {
      return this._callToolWithAgentAuth(server, toolName, args, agentId, agentAuth.apiKey);
    }

    // For internal OAuth-based MCPs (OneDrive, Gmail): always use per-agent connection
    // to pass agentId context so the MCP handler can resolve agent-specific OAuth tokens
    if (agentId && (server.url === '__internal__onedrive' || server.url === '__internal__gmail' || server.url === '__internal__outlook' || server.url === '__internal__gdrive' || server.url === '__internal__slack' || server.url === '__internal__jira' || server.url === '__internal__wordpress' || server.url === '__internal__github')) {
      return this._callToolWithAgentContext(server, toolName, args, agentId, boardId);
    }

    // No per-agent auth — use global connection
    if (server.status !== 'connected') {
      console.log(`🔌 [MCP] "${server.name}" is ${server.status}, attempting reconnect for ${toolName}...`);
      try {
        await this.connect(server.id);
      } catch (err) {
        throw new Error(`MCP server "${server.name}" is not connected and reconnect failed: ${err.message}`);
      }
    }
    return this.callTool(server.id, toolName, args);
  }

  /**
   * Call a tool using an agent-specific connection with custom auth.
   * Manages a per-agent client cache keyed by "agentId:serverId".
   */
  async _callToolWithAgentAuth(server, toolName, args, agentId, apiKey) {
    const cacheKey = `${agentId}:${server.id}`;
    let client = this.agentClients.get(cacheKey);

    // Connect if no cached client or previous connection is dead
    if (!client || !client.isConnected) {
      client = await this._connectAgentClient(cacheKey, server, { Authorization: `Bearer ${apiKey}` });
    }

    try {
      const result = await client.callTool(toolName, args);
      const extracted = extractMcpResult(result.content);
      return {
        success: !result.isError,
        result: extracted.text,
        images: extracted.images,
        raw: result.content
      };
    } catch (err) {
      // Session expired — reconnect and retry once
      if (err.message?.includes('404') || err.message?.includes('session') || err.message?.includes('Invalid token') || err.message?.includes('token') || err.message?.includes('401')) {
        console.log(`🔌 [MCP] Agent session/token expired for "${server.name}", reconnecting...`);
        // Drop and close the broken client before reconnecting so its
        // socket/session is not leaked when the cache entry is replaced.
        if (this.agentClients.get(cacheKey) === client) this.agentClients.delete(cacheKey);
        await client.close().catch(() => {});
        // A concurrent caller may already have reconnected — reuse its client
        // instead of opening (and leaking) another one.
        let newClient = this.agentClients.get(cacheKey);
        if (!newClient || !newClient.isConnected) {
          newClient = await this._connectAgentClient(cacheKey, server, { Authorization: `Bearer ${apiKey}` });
        }
        const result = await newClient.callTool(toolName, args);
        const extracted = extractMcpResult(result.content);
        return {
          success: !result.isError,
          result: extracted.text,
          images: extracted.images,
          raw: result.content
        };
      }
      throw err;
    }
  }

  /**
   * Call a tool on an internal server with agent context (X-Agent-Id header).
   * Used for servers like OneDrive that need to know which agent is calling
   * to resolve agent-specific tokens, without requiring an API key.
   */
  async _callToolWithAgentContext(server, toolName, args, agentId, boardId = null) {
    const cacheKey = `${agentId}:${server.id}${boardId ? `:${boardId}` : ''}`;
    const contextHeaders = {
      'X-Agent-Id': agentId,
      ...(boardId ? { 'X-Board-Id': boardId } : {}),
    };
    let client = this.agentClients.get(cacheKey);

    // Connect if no cached client or previous connection is dead
    if (!client || !client.isConnected) {
      client = await this._connectAgentClient(cacheKey, server, contextHeaders);
    }

    try {
      const result = await client.callTool(toolName, args);
      const extracted = extractMcpResult(result.content);
      return {
        success: !result.isError,
        result: extracted.text,
        images: extracted.images,
        raw: result.content
      };
    } catch (err) {
      // Session expired — reconnect and retry once
      if (err.message?.includes('404') || err.message?.includes('session') || err.message?.includes('Invalid token') || err.message?.includes('token') || err.message?.includes('401')) {
        console.log(`🔌 [MCP] Agent context session expired for "${server.name}", reconnecting...`);
        // Drop and close the broken client before reconnecting so its
        // socket/session is not leaked when the cache entry is replaced.
        if (this.agentClients.get(cacheKey) === client) this.agentClients.delete(cacheKey);
        await client.close().catch(() => {});
        // A concurrent caller may already have reconnected — reuse its client
        // instead of opening (and leaking) another one.
        let newClient = this.agentClients.get(cacheKey);
        if (!newClient || !newClient.isConnected) {
          newClient = await this._connectAgentClient(cacheKey, server, contextHeaders);
        }
        const result = await newClient.callTool(toolName, args);
        const extracted = extractMcpResult(result.content);
        return {
          success: !result.isError,
          result: extracted.text,
          images: extracted.images,
          raw: result.content
        };
      }
      throw err;
    }
  }

  /**
   * Disconnect all per-agent MCP connections for a specific agent (e.g. on agent delete).
   */
  async disconnectAgent(agentId) {
    const prefix = `${agentId}:`;
    for (const [key, client] of this.agentClients) {
      if (key.startsWith(prefix)) {
        await client.close().catch(() => {});
        this.agentClients.delete(key);
      }
    }
  }

  // ── Agent Integration ───────────────────────────────────────────────

  async getToolsForAgent(mcpServerIds, agentId = null, agentMcpAuth = {}) {
    const tools = [];
    const unavailable = [];

    const reconnectPromises = [];
    for (const serverId of mcpServerIds) {
      let server = this.servers.get(serverId);
      if (!server) {
        server = await this.ensureBuiltinServerRegistered(serverId);
      }
      if (server && server.status !== 'connected' && server.enabled && server.url) {
        // If agent has auth for this server, use per-agent connection to discover tools
        const agentAuth = agentMcpAuth[serverId];
        if (agentId && agentAuth?.apiKey) {
          reconnectPromises.push(
            this._discoverToolsWithAgentAuth(server, agentId, agentAuth.apiKey).catch(err => {
              console.warn(`⚠️ [MCP] Per-agent discovery failed for "${server.name}": ${err.message}`);
            })
          );
        } else {
          // Try global reconnect (only if server has a global key or is internal)
          const internal = resolveInternalMcpConfig(server.url);
          if (server.apiKey || Object.keys(internal.headers).length > 0) {
            console.log(`🔌 [MCP] "${server.name}" not connected — attempting reconnect for agent prompt...`);
            reconnectPromises.push(
              this.connect(serverId).catch(err => {
                console.warn(`⚠️ [MCP] Reconnect failed for "${server.name}": ${err.message}`);
              })
            );
          }
        }
      }
    }
    if (reconnectPromises.length > 0) {
      await Promise.allSettled(reconnectPromises);
    }

    for (const serverId of mcpServerIds) {
      const server = this.servers.get(serverId) || findBuiltinMcpServer(serverId) && createBuiltinServerEntry(findBuiltinMcpServer(serverId));
      if (!server) {
        unavailable.push({ serverId, serverName: serverId, status: 'unknown', reason: 'Server not registered' });
        continue;
      }
      // For per-agent auth servers: check if we have tools (discovered via agent connection)
      // even if global status isn't 'connected'
      if (server.tools && server.tools.length > 0) {
        for (const tool of server.tools) {
          tools.push({
            serverName: server.name,
            serverId: server.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          });
        }
      } else if (server.status !== 'connected') {
        const agentAuth = agentMcpAuth[serverId];
        unavailable.push({
          serverId,
          serverName: server.name,
          status: server.status,
          reason: agentAuth?.apiKey
            ? `Server is ${server.status}` + (server.error ? `: ${server.error}` : '')
            : 'No API key configured for this agent — set it in the agent\'s Plugins tab'
        });
      }
    }
    return { tools, unavailable };
  }

  getClaudeMcpConfigForAgent(agent, skillManager = null, opts: { forceServerIds?: string[] } = {}) {
    if (!agent) return { mcpServers: {}, serverIds: [] };

    const entries = new Map();
    const addEntry = (serverId, authOverride = null) => {
      if (!serverId || entries.has(serverId)) return;
      const server = this.getById(serverId);
      if (!server || server.enabled === false || !server.url) return;

      // This config is written into the CLI runner's config file at spawn and
      // the CLI holds the Authorization header in memory for its whole session,
      // so the internal token must outlive long coding sessions — with the 1h
      // default, every internal MCP call (including task_execution_complete)
      // starts failing with 401 after an hour.
      const internal = resolveInternalMcpConfig(server.url, { expiresIn: '24h' });
      const headers = {
        ...(internal.headers || {}),
      };
      const agentAuth = agent.mcpAuth?.[server.id];
      const apiKey = authOverride?.apiKey || agentAuth?.apiKey || server.apiKey || '';
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (Object.keys(internal.headers || {}).length > 0) {
        headers['X-Agent-Id'] = agent.id;
        if (agent.boardId) headers['X-Board-Id'] = agent.boardId;
      }

      const baseName = slugMcpName(server.name || server.id);
      let name = baseName;
      let suffix = 2;
      while ([...entries.values()].some((entry) => entry.name === name)) {
        name = `${baseName}-${suffix++}`;
      }

      entries.set(server.id, {
        name,
        config: {
          type: 'http',
          url: internal.url || server.url,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });
    };

    // Always-on servers forced by the caller (e.g. CLI runners always get the
    // Swarm API MCP so the agent can signal task completion / inspect the swarm,
    // regardless of explicit plugin/MCP assignment). Added first so their slug
    // names are stable and they cannot be dropped by the dedup below.
    for (const serverId of opts.forceServerIds || []) {
      addEntry(serverId);
    }

    const pluginManaged = new Set(agent.pluginMcpServers || []);
    const directServerIds = Array.isArray(agent.mcpServersExplicit)
      ? agent.mcpServersExplicit
      : (agent.mcpServers || []).filter((serverId) => !pluginManaged.has(serverId));
    for (const serverId of directServerIds) {
      addEntry(serverId);
    }

    if (skillManager) {
      for (const pluginId of agent.skills || []) {
        const plugin = skillManager.getById(pluginId);
        for (const serverId of plugin?.mcpServerIds || []) {
          const pluginMcp = Array.isArray(plugin?.mcps) ? plugin.mcps.find((m) => m.id === serverId) : null;
          addEntry(serverId, pluginMcp);
        }
        for (const pluginMcp of plugin?.mcps || []) {
          addEntry(pluginMcp.id, pluginMcp);
        }
      }
    }

    const mcpServers = {};
    for (const entry of entries.values()) {
      mcpServers[entry.name] = entry.config;
    }
    return { mcpServers, serverIds: [...entries.keys()] };
  }

  /**
   * Discover tools using a per-agent connection, then store them on the server entry
   * (so they appear in the agent prompt) without changing the global connection.
   */
  async _discoverToolsWithAgentAuth(server, agentId, apiKey) {
    const cacheKey = `${agentId}:${server.id}`;
    const cached = this.agentClients.get(cacheKey);
    if (cached && cached.isConnected) return;

    console.log(`🔌 [MCP] Discovering tools for "${server.name}" via agent ${agentId.slice(0, 8)} auth`);
    const client = await this._connectAgentClient(cacheKey, server, { Authorization: `Bearer ${apiKey}` });

    // Store discovered tools on the server entry so they appear in the agent
    // prompt. Deliberately leave server.status untouched: only a per-agent
    // client exists here, and marking the server globally 'connected' makes
    // global-path calls skip reconnect and fail with 'MCP server not connected'.
    server.tools = (client.tools || []).map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {}
    }));
    server.error = null;
  }
}
