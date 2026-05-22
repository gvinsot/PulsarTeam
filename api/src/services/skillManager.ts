import { v4 as uuidv4 } from 'uuid';
import { getAllSkills, saveSkill, deleteSkillFromDb } from './database.js';
import { BUILTIN_SKILLS } from '../data/skills.js';

interface McpEntry {
  id: string;
  name: string;
  url: string;
  description: string;
  icon: string;
  authMode: string;
  apiKey: string;
  enabled: boolean;
  userConfig: Record<string, any>;
  [key: string]: any;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  category?: string;
  icon?: string;
  instructions?: string;
  userConfig: Record<string, any>;
  mcps: McpEntry[];
  mcpServerIds: string[];
  builtin?: boolean;
  ownerId?: string | null;
  shared?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
}

function normalizeMcp(mcp: any): McpEntry {
  return {
    id: mcp.id || uuidv4(),
    name: mcp.name || 'Unnamed Server',
    url: mcp.url || '',
    description: mcp.description || '',
    icon: mcp.icon || '🔌',
    authMode: mcp.authMode || (mcp.apiKey ? 'bearer' : 'none'),
    apiKey: mcp.apiKey || '',
    enabled: mcp.enabled !== false,
    userConfig: mcp.userConfig || {},
  };
}

function normalizeSkill(skill: any, mcpResolver: ((id: string) => any) | null): Skill {
  // Always prefer resolving from mcpServerIds when a resolver is available,
  // so linked MCPs pick up live name/url/description from the MCP manager
  const serverIds = Array.isArray(skill.mcpServerIds) && skill.mcpServerIds.length > 0
    ? skill.mcpServerIds
    : Array.isArray(skill.mcps)
      ? skill.mcps.map((m: any) => m.id).filter(Boolean)
      : [];

  let mcps: McpEntry[];
  if (serverIds.length > 0 && mcpResolver) {
    mcps = serverIds.map((id: string) => {
      const server = mcpResolver(id);
      // Preserve authMode & apiKey from the skill's own mcp entry (user may have set per-plugin auth)
      const skillMcp = Array.isArray(skill.mcps) ? skill.mcps.find((m: any) => m.id === id) : null;
      if (server) {
        return normalizeMcp({
          id: server.id, name: server.name, url: server.url, description: server.description || '',
          icon: server.icon || '🔌', enabled: server.enabled !== false, userConfig: {},
          authMode: skillMcp?.authMode || undefined,
          apiKey: skillMcp?.apiKey || server.apiKey || '',
        });
      }
      // Fallback: try to find in existing mcps array for embedded (non-linked) MCPs
      return skillMcp ? normalizeMcp(skillMcp) : { id, name: 'Linked MCP', url: '', description: '', icon: '🔌', authMode: 'none', apiKey: '', enabled: true, userConfig: {} };
    });
  } else if (Array.isArray(skill.mcps)) {
    mcps = skill.mcps.map(normalizeMcp);
  } else {
    mcps = [];
  }

  // Built-in plugins are system-owned (ownerId=null) and globally shared by default.
  // User-created plugins keep whatever ownerId/shared was set on them.
  const isBuiltin = skill.builtin === true;
  const ownerId = skill.ownerId === undefined
    ? (isBuiltin ? null : null)
    : skill.ownerId;
  const shared = skill.shared === undefined
    ? !!isBuiltin
    : !!skill.shared;

  return {
    ...skill,
    userConfig: skill.userConfig || {},
    mcps,
    mcpServerIds: mcps.map((m) => m.id),
    ownerId,
    shared,
  };
}


function findBuiltinSkill(identifier: any): any {
  if (!identifier) return null;
  const value = String(identifier).toLowerCase();
  return BUILTIN_SKILLS.find(
    (skill: any) => skill.id.toLowerCase() === value || skill.name.toLowerCase() === value
  ) || null;
}

const ACTIVE_BUILTIN_SKILL_IDS = new Set(BUILTIN_SKILLS.map((skill: any) => skill.id));

export class SkillManager {
  skills: Map<string, Skill>;
  _mcpResolver: ((id: string) => any) | null;

  constructor() {
    this.skills = new Map();
    this._mcpResolver = null;
  }

  setMcpResolver(resolver: (id: string) => any): void {
    this._mcpResolver = resolver;
  }

  async loadFromDatabase(): Promise<void> {
    const skills = await getAllSkills();
    let retiredBuiltins = 0;

    for (const skill of skills) {
      if (skill.builtin && !ACTIVE_BUILTIN_SKILL_IDS.has(skill.id)) {
        await deleteSkillFromDb(skill.id);
        retiredBuiltins++;
        continue;
      }

      this.skills.set(skill.id, normalizeSkill(skill, this._mcpResolver));
    }

    console.log(`✅ Loaded ${this.skills.size} skills from database`);
    if (retiredBuiltins > 0) {
      console.log(`🧹 Removed ${retiredBuiltins} retired built-in skill(s)`);
    }
  }

  async seedDefaults(defaults: any[]): Promise<void> {
    let seeded = 0;
    let updated = 0;
    for (const skill of defaults) {
      if (!this.skills.has(skill.id)) {
        const entry = normalizeSkill({
          ...skill,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }, this._mcpResolver);
        this.skills.set(skill.id, entry);
        await saveSkill(entry);
        seeded++;
      } else if (skill.builtin) {
        // Update existing builtin skills to pick up new fields (e.g. mcpServerIds)
        const existing = this.skills.get(skill.id);
        const entry = normalizeSkill({
          ...existing,
          ...skill,
          updatedAt: new Date().toISOString()
        }, this._mcpResolver);
        this.skills.set(skill.id, entry);
        await saveSkill(entry);
        updated++;
      }
    }
    if (seeded > 0) {
      console.log(`✅ Seeded ${seeded} built-in skills`);
    }
    if (updated > 0) {
      console.log(`✅ Updated ${updated} built-in skills`);
    }
  }

  /**
   * Return every plugin visible to the given user.
   * - Built-in plugins (ownerId=null, shared=true) are visible to everyone.
   * - Plugins with shared=true are visible to everyone.
   * - Plugins owned by `userId` are visible to that user.
   * - Admins see everything.
   * If userId is omitted, returns the full unfiltered list (used by background
   * services like the runner injecting prompts for the agent).
   */
  getAll(userId?: string | null, isAdmin: boolean = false): Skill[] {
    const resolver = this._mcpResolver;
    const all = Array.from(this.skills.values()).map(s => normalizeSkill(s, resolver));
    const seen = new Set(all.map((skill) => skill.id));

    for (const builtin of BUILTIN_SKILLS) {
      if (!seen.has((builtin as any).id)) {
        all.push(normalizeSkill(builtin, resolver));
      }
    }

    if (!userId || isAdmin) {
      return all;
    }

    return all.filter((p) => {
      if (p.shared) return true;
      if (!p.ownerId) return true; // legacy / system-owned → visible
      return p.ownerId === userId;
    });
  }

  getById(id: string): Skill | null {
    const skill = this.skills.get(id) || findBuiltinSkill(id) || null;
    return skill ? normalizeSkill(skill, this._mcpResolver) : null;
  }

  /**
   * True if `userId` is allowed to see this plugin.
   */
  canView(plugin: Skill, userId: string | null, isAdmin: boolean): boolean {
    if (!plugin) return false;
    if (isAdmin) return true;
    if (plugin.shared) return true;
    if (!plugin.ownerId) return true; // built-ins
    return plugin.ownerId === userId;
  }

  /**
   * True if `userId` is allowed to edit/share/delete this plugin.
   * Built-ins (ownerId=null + builtin=true) are admin-only.
   * User-created plugins are restricted to their owner (or admin).
   */
  canManage(plugin: Skill, userId: string | null, isAdmin: boolean): boolean {
    if (!plugin) return false;
    if (isAdmin) return true;
    if (plugin.builtin && !plugin.ownerId) return false;
    return !!plugin.ownerId && plugin.ownerId === userId;
  }

  async create(config: any, ownerId: string | null = null): Promise<Skill> {
    const id = uuidv4();
    const skill = normalizeSkill({
      id,
      name: config.name || 'Unnamed Skill',
      description: config.description || '',
      category: config.category || 'general',
      icon: config.icon || '🔧',
      instructions: config.instructions || '',
      userConfig: config.userConfig || {},
      mcps: Array.isArray(config.mcps) ? config.mcps : [],
      builtin: false,
      ownerId,
      shared: !!config.shared,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, this._mcpResolver);

    this.skills.set(id, skill);
    await saveSkill(skill);
    return skill;
  }

  async setShared(id: string, shared: boolean): Promise<Skill | null> {
    const current = this.skills.get(id);
    if (!current) return null;
    const updated = normalizeSkill({
      ...current,
      shared: !!shared,
      updatedAt: new Date().toISOString(),
    }, this._mcpResolver);
    this.skills.set(id, updated);
    await saveSkill(updated);
    return updated;
  }

  async update(id: string, updates: any): Promise<Skill | null> {
    const current = this.skills.get(id);
    if (!current) return null;

    const skill: any = { ...current };
    const allowed = ['name', 'description', 'category', 'icon', 'instructions', 'userConfig', 'mcps', 'shared'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        skill[key] = updates[key];
      }
    }

    const normalized = normalizeSkill({
      ...skill,
      updatedAt: new Date().toISOString()
    }, this._mcpResolver);

    this.skills.set(id, normalized);
    await saveSkill(normalized);
    return normalized;
  }

  async delete(id: string): Promise<boolean> {
    const skill = this.skills.get(id);
    if (!skill) return false;

    this.skills.delete(id);
    await deleteSkillFromDb(id);
    return true;
  }
}
