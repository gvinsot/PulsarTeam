import { createJsonDocStore } from './jsonDocStore.js';
import type { Skill } from '../skillManager.js';

const store = createJsonDocStore<Skill>('skills', { label: 'skill', labelPlural: 'skills' });

export const getAllSkills = store.getAll;
export const saveSkill = store.save;
export const deleteSkillFromDb = store.remove;
