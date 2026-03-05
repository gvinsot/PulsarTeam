import { v4 as uuidv4 } from 'uuid';
import { getAllSkills, saveSkill, deleteSkillFromDb } from './database.js';

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

function normalizeSkill(skill) {
  const mcps = Array.isArray(skill.mcps)
    ? skill.mcps.map(normalizeMcp)
    : Array.isArray(skill.mcpServerIds)
      ? skill.mcpServerIds.map((id) => ({ id, name: 'Linked MCP', url: '', description: '', icon: '🔌', apiKey: '', enabled: true, userConfig: {} }))
      : [];

  return {
    ...skill,
    userConfig: skill.userConfig || {},
    mcps,
    mcpServerIds: mcps.map((m) => m.id),
  };
}

export class SkillManager {
  constructor() {
    this.skills = new Map();
  }

  async loadFromDatabase() {
    const skills = await getAllSkills();
    for (const skill of skills) {
      this.skills.set(skill.id, normalizeSkill(skill));
    }
    console.log(`✅ Loaded ${skills.length} skills from database`);
  }

  async seedDefaults(defaults) {
    let seeded = 0;
    for (const skill of defaults) {
      if (!this.skills.has(skill.id)) {
        const entry = normalizeSkill({
          ...skill,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        this.skills.set(skill.id, entry);
        await saveSkill(entry);
        seeded++;
      }
    }
    if (seeded > 0) {
      console.log(`✅ Seeded ${seeded} built-in skills`);
    }
  }

  getAll() {
    return Array.from(this.skills.values()).map(normalizeSkill);
  }

  getById(id) {
    const skill = this.skills.get(id) || null;
    return skill ? normalizeSkill(skill) : null;
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
    });

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
    });

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