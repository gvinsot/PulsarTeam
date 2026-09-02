import {
  parseFieldProjection,
  type FieldProjection,
  type ProjectionPreset,
} from '../lib/projection.js';

export const TASK_LIST_OMIT_FIELDS = ['history'] as const;

export const TASK_PROJECTION_PRESETS: Record<string, ProjectionPreset> = {
  list: { omit: TASK_LIST_OMIT_FIELDS },
  summary: { omit: ['history', 'commits'] },
  detail: {},
};

export function parseTaskProjection(
  query: Record<string, unknown>,
  defaultView: string | null = 'detail'
): FieldProjection {
  return parseFieldProjection(query, TASK_PROJECTION_PRESETS, defaultView);
}

export function defaultTaskListProjection(): FieldProjection {
  return parseTaskProjection({ view: 'list' }, 'list');
}
