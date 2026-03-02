import { v4 as uuidv4 } from 'uuid';
import { getAllSkills, saveSkill, deleteSkillFromDb } from './database.js';

export class SkillManager {
  constructor() {
    this.skills = new Map();
  }

  async loadFromDatabase() {
    const skills = await getAllSkills();
    for (const skill of skills) {
      this.skills.set(skill.id, skill);
    }
    console.log(`✅ Loaded ${skills.length} skills from database`);
  }

  async seedDefaults(defaults) {
    let seeded = 0;
    for (const skill of defaults) {
      if (!this.skills.has(skill.id)) {
        const entry = {
          ...skill,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
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
    return Array.from(this.skills.values());
  }

  getById(id) {
    return this.skills.get(id) || null;
  }

  async create(config) {
    const id = uuidv4();
    const skill = {
      id,
      name: config.name || 'Unnamed Skill',
      description: config.description || '',
      category: config.category || 'general',
      icon: config.icon || '🔧',
      instructions: config.instructions || '',
      mcpServerIds: Array.isArray(config.mcpServerIds) ? config.mcpServerIds : [],
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.skills.set(id, skill);
    await saveSkill(skill);
    return skill;
  }

  async update(id, updates) {
    const skill = this.skills.get(id);
    if (!skill) return null;

    const allowed = ['name', 'description', 'category', 'icon', 'instructions', 'mcpServerIds'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        skill[key] = updates[key];
      }
    }
    skill.updatedAt = new Date().toISOString();

    await saveSkill(skill);
    return skill;
  }

  async delete(id) {
    const skill = this.skills.get(id);
    if (!skill) return false;

    this.skills.delete(id);
    await deleteSkillFromDb(id);
    return true;
  }
}
