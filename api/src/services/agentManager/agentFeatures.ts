// ─── Agent Features: RAG Documents, Skills, MCP Servers ─────────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent } from '../database.js';
import { assertPublicUrl } from '../../lib/ssrfGuard.js';

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

async function fetchUrlContent(url: string): Promise<string> {
  await assertPublicUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual', // prevent cross-host redirect bypassing the SSRF guard
      headers: {
        'User-Agent': 'PulsarTeam/1.0',
        Accept: 'text/plain, text/html, text/markdown, application/json, */*',
      },
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
          headers: {
            'User-Agent': 'PulsarTeam/1.0',
            Accept: 'text/plain, text/html, text/markdown, application/json, */*',
          },
        });
        if (!r2.ok) throw new Error(`HTTP ${r2.status} ${r2.statusText}`);
        const text = await r2.text();
        const maxChars = 200_000;
        return text.length > maxChars
          ? text.slice(0, maxChars) + '\n\n[... truncated at 200k chars]'
          : text;
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    const maxChars = 200_000;
    return text.length > maxChars
      ? text.slice(0, maxChars) + '\n\n[... truncated at 200k chars]'
      : text;
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
    const doc = {
      id: uuidv4(),
      name,
      content,
      type: 'text' as const,
      addedAt: new Date().toISOString(),
    };
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
      id: uuidv4(),
      name,
      url,
      content,
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
