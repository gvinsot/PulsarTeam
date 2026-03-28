import { v4 as uuidv4 } from 'uuid';
import { getAllSkills, saveSkill, deleteSkillFromDb } from './database.js';
import { BUILTIN_SKILLS } from '../data/skills.js';

function normalizeMcp(mcp) {
  return {
    id: mcp.id || uuidv4(),
    name: mcp.name || 'Unnamed Server',
    url: mcp.url || '',
    description: mcp.description || '',
    icon: mcp.icon || '🔌',
    apiKey: mcp.apiKey || '',
    enabled: mcp.enabled !== false,
    userConfig: mcp.userConfig || {},
  };
}

function normalizeSkill(skill, mcpResolver) {
  // Always prefer resolving from mcpServerIds when a resolver is available,
  // so linked MCPs pick up live name/url/description from the MCP manager
  const serverIds = Array.isArray(skill.mcpServerIds) && skill.mcpServerIds.length > 0
    ? skill.mcpServerIds
    : Array.isArray(skill.mcps)
      ? skill.mcps.map(m => m.id).filter(Boolean)
      : [];

  let mcps;
  if (serverIds.length > 0 && mcpResolver) {
    mcps = serverIds.map((id) => {
      const server = mcpResolver(id);
      if (server) {
        return normalizeMcp({ id: server.id, name: server.name, url: server.url, description: server.description || '', icon: server.icon || '🔌', apiKey: server.apiKey || '', enabled: server.enabled !== false, userConfig: {} });
      }
      // Fallback: try to find in existing mcps array for embedded (non-linked) MCPs
      const existing = Array.isArray(skill.mcps) ? skill.mcps.find(m => m.id === id) : null;
      return existing ? normalizeMcp(existing) : { id, name: 'Linked MCP', url: '', description: '', icon: '🔌', apiKey: '', enabled: true, userConfig: {} };
    });
  } else if (Array.isArray(skill.mcps)) {
    mcps = skill.mcps.map(normalizeMcp);
  } else {
    mcps = [];
  }

  return {
    ...skill,
    userConfig: skill.userConfig || {},
    mcps,
    mcpServerIds: mcps.map((m) => m.id),
  };
}


function findBuiltinSkill(identifier) {
  if (!identifier) return null;
  const value = String(identifier).toLowerCase();
  return BUILTIN_SKILLS.find(
    (skill) => skill.id.toLowerCase() === value || skill.name.toLowerCase() === value
  ) || null;
}

const ACTIVE_BUILTIN_SKILL_IDS = new Set(BUILTIN_SKILLS.map((skill) => skill.id));

export class SkillManager {
  constructor() {
    this.skills = new Map();
    this._mcpResolver = null;
  }

  setMcpResolver(resolver) {
    this._mcpResolver = resolver;
  }

  async loadFromDatabase() {
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

  async seedDefaults(defaults) {
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

  getAll() {
    const resolver = this._mcpResolver;
    const skills = Array.from(this.skills.values()).map(s => normalizeSkill(s, resolver));
    const seen = new Set(skills.map((skill) => skill.id));

    for (const builtin of BUILTIN_SKILLS) {
      if (!seen.has(builtin.id)) {
        skills.push(normalizeSkill(builtin, resolver));
      }
    }

    return skills;
  }

  getById(id) {
    const skill = this.skills.get(id) || findBuiltinSkill(id) || null;
    return skill ? normalizeSkill(skill, this._mcpResolver) : null;
  }

  async create(config) {
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, this._mcpResolver);

    this.skills.set(id, skill);
    await saveSkill(skill);
    return skill;
  }

  async update(id, updates) {
    const current = this.skills.get(id);
    if (!current) return null;

    const skill = { ...current };
    const allowed = ['name', 'description', 'category', 'icon', 'instructions', 'userConfig', 'mcps'];
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

  async delete(id) {
    const skill = this.skills.get(id);
    if (!skill) return false;

    this.skills.delete(id);
    await deleteSkillFromDb(id);
    return true;
  }
}