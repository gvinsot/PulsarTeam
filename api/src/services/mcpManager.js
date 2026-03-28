import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getJwtSecret } from '../middleware/auth.js';
import { getAllMcpServers, saveMcpServer, deleteMcpServerFromDb } from './database.js';
import { BUILTIN_MCP_SERVERS } from '../data/mcpServers.js';
import { MCPClient } from './mcpClient.js';

export function resolveInternalMcpConfig(serverUrl, {
  port = process.env.PORT || 3001,
  jwtSecret = null,
} = {}) {
  const mappings = {
    '__internal__onedrive': `http://localhost:${port}/api/onedrive/mcp`,
    '__internal__code_index': `http://localhost:${port}/api/code-index/mcp`,
    '__internal__code-index': `http://localhost:${port}/api/code-index/mcp`,
    '__internal__gandi_dns': `http://localhost:${port}/api/gandi-dns/mcp`,
  };

  // Check if this is a remapped internal URL
  const remapped = mappings[serverUrl];

  // Platform URLs that share JWT_SECRET and need auto-generated JWT auth
  const needsPlatformJwt = remapped || serverUrl.startsWith('http://swarm-manager');

  if (!needsPlatformJwt) {
    return { url: serverUrl, headers: {} };
  }

  const token = jwt.sign(
    { username: 'internal-mcp', role: 'admin', internal: true },
    jwtSecret || getJwtSecret(),
    { expiresIn: '1h' }
  );

  return {
    url: remapped || serverUrl,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

/**
 * Manages MCP server registrations, connections, and tool execution.
 * Follows the same pattern as SkillManager: in-memory Map + DB persistence.
 */

export function findBuiltinMcpServer(identifier) {
  if (!identifier) return null;
  const value = String(identifier).toLowerCase();
  return BUILTIN_MCP_SERVERS.find(
    (server) => server.id.toLowerCase() === value || server.name.toLowerCase() === value
  ) || null;
}

function createBuiltinServerEntry(def) {
  return {
    ...def,
    tools: [],
    status: 'disconnected',
    error: null,
    createdAt: null,
    updatedAt: null,
  };
}

export class MCPManager {
  constructor() {
    this.servers = new Map();   // id -> server config (with tools[], status, etc.)
    this.clients = new Map();   // id -> MCPClient instance (global/test connections)
    this.agentClients = new Map(); // "agentId:serverId" -> MCPClient (per-agent connections)
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
   * Errors are logged but don't block startup.
   */
  async connectAll() {
    const enabled = Array.from(this.servers.values()).filter(s => s.enabled !== false);
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

  async connect(id) {
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
      const connectOpts = {};

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
    const client = this.clients.get(serverId);
    const server = this.servers.get(serverId);
    if (!client || !server) throw new Error(`MCP server not connected: ${serverId}`);

    try {
      const result = await client.callTool(toolName, args);
      const textParts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text);
      const output = textParts.join('\\n') || JSON.stringify(result.content);

      return {
        success: !result.isError,
        result: output,
        raw: result.content
      };
    } catch (err) {
      if (err.message?.includes('404') || err.message?.includes('session')) {
        console.log(`🔌 [MCP] Session expired for "${server.name}", reconnecting...`);
        try {
          await this.connect(serverId);
          const retryClient = this.clients.get(serverId);
          if (retryClient) {
            const result = await retryClient.callTool(toolName, args);
            const textParts = result.content.filter(c => c.type === 'text').map(c => c.text);
            return {
              success: !result.isError,
              result: textParts.join('\\n') || JSON.stringify(result.content),
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
  async callToolByNameForAgent(serverName, toolName, args = {}, agentId = null, agentMcpAuth = {}) {
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
      console.log(`🔌 [MCP] Creating per-agent connection for agent=${agentId.slice(0, 8)} server="${server.name}"`);
      client = new MCPClient('PulsarTeam');
      const connectOpts = { headers: { Authorization: `Bearer ${apiKey}` } };
      const internalConfig = resolveInternalMcpConfig(server.url);
      if (Object.keys(internalConfig.headers).length > 0) {
        connectOpts.headers = { ...connectOpts.headers, ...internalConfig.headers };
      }
      await client.connect(internalConfig.url, connectOpts);
      this.agentClients.set(cacheKey, client);
    }

    try {
      const result = await client.callTool(toolName, args);
      const textParts = result.content.filter(c => c.type === 'text').map(c => c.text);
      return {
        success: !result.isError,
        result: textParts.join('\n') || JSON.stringify(result.content),
        raw: result.content
      };
    } catch (err) {
      // Session expired — reconnect and retry once
      if (err.message?.includes('404') || err.message?.includes('session')) {
        console.log(`🔌 [MCP] Agent session expired for "${server.name}", reconnecting...`);
        const newClient = new MCPClient('PulsarTeam');
        const connectOpts = { headers: { Authorization: `Bearer ${apiKey}` } };
        const internalConfig = resolveInternalMcpConfig(server.url);
        if (Object.keys(internalConfig.headers).length > 0) {
          connectOpts.headers = { ...connectOpts.headers, ...internalConfig.headers };
        }
        await newClient.connect(internalConfig.url, connectOpts);
        this.agentClients.set(cacheKey, newClient);
        const result = await newClient.callTool(toolName, args);
        const textParts = result.content.filter(c => c.type === 'text').map(c => c.text);
        return {
          success: !result.isError,
          result: textParts.join('\n') || JSON.stringify(result.content),
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

  async getToolsForAgent(mcpServerIds) {
    const tools = [];
    const unavailable = [];

    const reconnectPromises = [];
    for (const serverId of mcpServerIds) {
      let server = this.servers.get(serverId);
      if (!server) {
        server = await this.ensureBuiltinServerRegistered(serverId);
      }
      if (server && server.status !== 'connected' && server.enabled && server.url) {
        console.log(`🔌 [MCP] "${server.name}" not connected — attempting reconnect for agent prompt...`);
        reconnectPromises.push(
          this.connect(serverId).catch(err => {
            console.warn(`⚠️ [MCP] Reconnect failed for "${server.name}": ${err.message}`);
          })
        );
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
      if (server.status !== 'connected') {
        unavailable.push({ serverId, serverName: server.name, status: server.status, reason: `Server is ${server.status}` + (server.error ? `: ${server.error}` : '') });
        continue;
      }
      for (const tool of server.tools) {
        tools.push({
          serverName: server.name,
          serverId: server.id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        });
      }
    }
    return { tools, unavailable };
  }
}