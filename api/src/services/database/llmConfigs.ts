import { createJsonDocStore } from './jsonDocStore.js';

const store = createJsonDocStore('llm_configs', {
  secretFields: ['apiKey'],
  label: 'LLM config',
  labelPlural: 'LLM configs',
});

export const getAllLlmConfigs = store.getAll;
export const getLlmConfig = store.getById;
export const saveLlmConfig = store.save;
export const deleteLlmConfig = store.remove;
