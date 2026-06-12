// ─── Agent Features: RAG Documents, Skills, MCP Servers ─────────────────────
import { v4 as uuidv4 } from 'uuid';
import dns from 'dns/promises';
import net from 'net';
import { saveAgent } from '../database.js';

function _pluginMcpIds(plugin: any): string[] {
  const ids = new Set<string>();
  for (const id of plugin?.mcpServerIds || []) {
    if (id) ids.add(id);
  }
  for (const mcp of plugin?.mcps || []) {
    if (mcp?.id) ids.add(mcp.id);
  }
  return Array.from(ids);
}

function _syncPluginMcps(agent: any, skillManager: any): void {
  const explicit = new Set(agent.mcpServersExplicit || []);
  const pluginIds = Array.isArray(agent.skills) ? agent.skills : [];
  const pluginMcpIds = new Set<string>();
  if (skillManager) {
    for (const pluginId of pluginIds) {
      const plugin = skillManager.getById(pluginId);
      for (const mcpId of _pluginMcpIds(plugin)) {
        pluginMcpIds.add(mcpId);
      }
    }
  }
  agent.mcpServers = Array.from(new Set([...explicit, ...pluginMcpIds]));
  agent.pluginMcpServers = Array.from(pluginMcpIds);
}

async function _restartCliForPluginChange(manager: any, agentId: string): Promise<void> {
  if (manager.mcpManager?.disconnectAgent) {
    manager.mcpManager.disconnectAgent(agentId).catch(() => {});
  }
  if (manager.executionManager?.closeTerminalSession) {
    manager.executionManager.closeTerminalSession(agentId).catch((err: any) => {
      console.warn(`⚠️ [Plugins] closeTerminalSession failed for ${agentId}: ${err.message}`);
    });
  }
}

// SSRF guard — reject private/loopback/link-local addresses (incl. AWS metadata 169.254.169.254).
function isPrivateIPv4(ip: string): boolean {
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
function isPrivateIPv6(ip: string): boolean {
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
async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = parsed.hostname;
  if (!host) throw new Error('URL missing host');

  // If literal IP, validate directly. Otherwise resolve all A/AAAA records and reject if any is private.
  if (net.isIP(host)) {
    const isPrivate = net.isIP(host) === 4 ? isPrivateIPv4(host) : isPrivateIPv6(host);
    if (isPrivate) throw new Error('URL resolves to a private address');
    return;
  }
  const records = await dns.lookup(host, { all: true });
  for (const r of records) {
    const isPrivate = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
    if (isPrivate) throw new Error('URL resolves to a private address');
  }
}

async function fetchUrlContent(url: string): Promise<string> {
  await assertPublicUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual', // prevent cross-host redirect bypassing the SSRF guard
      headers: { 'User-Agent': 'PulsarTeam/1.0', 'Accept': 'text/plain, text/html, text/markdown, application/json, */*' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) {
        // Re-validate the redirect target against the SSRF guard, then follow it (single hop).
        const next = new URL(loc, url).toString();
        await assertPublicUrl(next);
        const r2 = await fetch(next, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': 'PulsarTeam/1.0', 'Accept': 'text/plain, text/html, text/markdown, application/json, */*' },
        });
        if (!r2.ok) throw new Error(`HTTP ${r2.status} ${r2.statusText}`);
        const text = await r2.text();
        const maxChars = 200_000;
        return text.length > maxChars ? text.slice(0, maxChars) + '\n\n[... truncated at 200k chars]' : text;
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    const maxChars = 200_000;
    return text.length > maxChars ? text.slice(0, maxChars) + '\n\n[... truncated at 200k chars]' : text;
  } finally {
    clearTimeout(timeout);
  }
}

/** @this {import('./index.js').AgentManager} */
export const agentFeaturesMethods = {

  // ─── RAG Document Management ───────────────────────────────────────
  addRagDocument(this: any, agentId: string, name: string, content: string): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const doc = { id: uuidv4(), name, content, type: 'text' as const, addedAt: new Date().toISOString() };
    agent.ragDocuments.push(doc);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return doc;
  },

  async addRagUrlDocument(this: any, agentId: string, name: string, url: string): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const content = await fetchUrlContent(url);
    const doc = {
      id: uuidv4(), name, url, content,
      type: 'url' as const,
      addedAt: new Date().toISOString(),
      lastFetched: new Date().toISOString(),
    };
    agent.ragDocuments.push(doc);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return doc;
  },

  async refreshRagUrlDocument(this: any, agentId: string, docId: string): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const doc = agent.ragDocuments.find((d: any) => d.id === docId);
    if (!doc || doc.type !== 'url' || !doc.url) return null;
    doc.content = await fetchUrlContent(doc.url);
    doc.lastFetched = new Date().toISOString();
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return doc;
  },

  deleteRagDocument(this: any, agentId: string, docId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.ragDocuments = agent.ragDocuments.filter((d: any) => d.id !== docId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  // ─── Skills ────────────────────────────────────────────────────────
  assignSkill(this: any, agentId: string, skillId: string): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    if (!agent.skills) agent.skills = [];
    if (!agent.skills.includes(skillId)) {
      agent.skills.push(skillId);
    }
    _syncPluginMcps(agent, this.skillManager);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    _restartCliForPluginChange(this, agentId);
    return agent.skills;
  },

  removeSkill(this: any, agentId: string, skillId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.skills) agent.skills = [];
    agent.skills = agent.skills.filter((id: string) => id !== skillId);
    _syncPluginMcps(agent, this.skillManager);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    _restartCliForPluginChange(this, agentId);
    return true;
  },
};
