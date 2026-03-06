import { v4 as uuidv4 } from 'uuid';
import { getAllMcpServers, saveMcpServer, deleteMcpServerFromDb } from './database.js';
import { MCPClient } from './mcpClient.js';

/**
 * Manages MCP server registrations, connections, and tool execution.
 * Follows the same pattern as SkillManager: in-memory Map + DB persistence.
 */
export class MCPManager {
  constructor() {
    this.servers = new Map();   // id -> server config (with tools[], status, etc.)
    this.clients = new Map();   // id -> MCPClient instance
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async loadFromDatabase() {
    const servers = await getAllMcpServers();
    for (const server of servers) {
      server.status = 'disconnected';
      server.tools = server.tools || [];
      this.servers.set(server.id, server);
    }
    console.log(`✅ Loaded ${servers.length} MCP servers from database`);
  }

  async seedDefaults(defaults) {
    let seeded = 0;
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
      }
    }
    if (seeded > 0) {
      console.log(`✅ Seeded ${seeded} built-in MCP server(s)`);
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
  }

  // ── CRUD ────────────────────────────────────────────────────────────

  getAll() {
    return Array.from(this.servers.values());
  }

  getById(id) {
    return this.servers.get(id) || null;
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

    // Auto-connect if enabled
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

    // Reconnect if URL, apiKey, or enabled changed
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
    const server = this.servers.get(id);
    if (!server) throw new Error(`MCP server ${id} not found`);
    if (!server.url) throw new Error(`MCP server "${server.name}" has no URL`);

    // Disconnect existing client if any
    await this.disconnect(id);

    server.status = 'connecting';
    server.error = null;

    try {
      const client = new MCPClient('AgentSwarm');
      const connectOpts = {};
      if (server.apiKey) {
        connectOpts.headers = { Authorization: `Bearer ${server.apiKey}` };
      }
      const { tools } = await client.connect(server.url, connectOpts);

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

  /**
   * Call a tool on a specific server by server ID.
   */
  async callTool(serverId, toolName, args = {}) {
    const client = this.clients.get(serverId);
    const server = this.servers.get(serverId);
    if (!client || !server) throw new Error(`MCP server not connected: ${serverId}`);

    try {
      const result = await client.callTool(toolName, args);

      // Extract text content from the MCP content array
      const textParts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text);
      const output = textParts.join('\n') || JSON.stringify(result.content);

      return {
        success: !result.isError,
        result: output,
        raw: result.content
      };
    } catch (err) {
      // If session expired (404), try reconnecting once
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
              result: textParts.join('\n') || JSON.stringify(result.content),
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

  /**
   * Call a tool by server name (used by agents via @mcp_call syntax).
   * Auto-reconnects if the server is registered but not connected.
   */
  async callToolByName(serverName, toolName, args = {}) {
    const server = Array.from(this.servers.values()).find(
      s => s.name.toLowerCase() === serverName.toLowerCase()
    );
    if (!server) throw new Error(`MCP server "${serverName}" not found. Available servers: ${Array.from(this.servers.values()).map(s => s.name).join(', ') || 'none'}`);

    // Auto-reconnect if server exists but is not connected
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

  // ── Agent Integration ───────────────────────────────────────────────

  /**
   * Get all tools available to an agent based on their assigned MCP server IDs.
   * Attempts to reconnect disconnected servers before reporting unavailability.
   * Returns { tools: [...], unavailable: [...] }
   * - tools: flat array of { serverName, serverId, name, description, inputSchema }
   * - unavailable: array of { serverName, serverId, status, reason } for non-connected servers
   */
  async getToolsForAgent(mcpServerIds) {
    const tools = [];
    const unavailable = [];

    // First pass: attempt to reconnect any disconnected servers
    const reconnectPromises = [];
    for (const serverId of mcpServerIds) {
      const server = this.servers.get(serverId);
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

    // Second pass: collect tools from connected servers
    for (const serverId of mcpServerIds) {
      const server = this.servers.get(serverId);
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
