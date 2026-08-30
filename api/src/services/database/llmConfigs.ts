import { createJsonDocStore } from './jsonDocStore.js';

/**
 * One row of the `llm_configs` document table — a named provider/model pair
 * plus its cost and capability metadata. Every field but `id` is optional
 * because the table is unvalidated JSONB written by the admin UI over several
 * schema generations; the index signature carries whatever a row has beyond
 * this list as `unknown`.
 */
export interface LlmConfig {
  id: string;
  name?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  endpoint?: string;
  isReasoning?: boolean;
  managesContext?: boolean;
  supportsImages?: boolean;
  temperature?: number | null;
  contextSize?: number | null;
  maxOutputTokens?: number | null;
  costPerInputToken?: number | null;
  costPerOutputToken?: number | null;
  createdAt?: string;
  [key: string]: unknown;
}

const store = createJsonDocStore<LlmConfig>('llm_configs', {
  secretFields: ['apiKey'],
  label: 'LLM config',
  labelPlural: 'LLM configs',
});

export const getAllLlmConfigs = store.getAll;
export const getLlmConfig = store.getById;
export const saveLlmConfig = store.save;
export const deleteLlmConfig = store.remove;
