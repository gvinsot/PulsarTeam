import { createJsonDocStore } from './jsonDocStore.js';

const store = createJsonDocStore('skills', { label: 'skill', labelPlural: 'skills' });

export const getAllSkills = store.getAll;
export const saveSkill = store.save;
export const deleteSkillFromDb = store.remove;
