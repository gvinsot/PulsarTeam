import {
  parseFieldProjection,
  type FieldProjection,
  type ProjectionPreset,
} from '../../lib/projection.js';

export const AGENT_LIST_OMIT_FIELDS = [
  'conversationHistory',
  'projectContexts',
  'ragDocuments',
] as const;

export const AGENT_PROJECTION_PRESETS: Record<string, ProjectionPreset> = {
  list: { omit: AGENT_LIST_OMIT_FIELDS },
  summary: { omit: AGENT_LIST_OMIT_FIELDS },
  detail: {},
};

export function parseAgentProjection(
  query: Record<string, unknown>,
  defaultView: string | null = 'detail'
): FieldProjection {
  return parseFieldProjection(query, AGENT_PROJECTION_PRESETS, defaultView);
}

export function defaultAgentListProjection(): FieldProjection {
  return parseAgentProjection({ view: 'list' }, 'list');
}
