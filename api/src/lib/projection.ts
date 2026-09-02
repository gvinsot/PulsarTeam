export interface ProjectionPreset {
  fields?: readonly string[];
  omit?: readonly string[];
}

export interface FieldProjection {
  fields: Set<string> | null;
  omit: Set<string>;
  view: string | null;
  active: boolean;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}

function normalizeField(value: string): string | null {
  const field = value.trim();
  if (!field || field === '*') return null;
  // Keep projections to simple top-level JSON fields. Unknown field names are
  // harmless later, but rejecting punctuation prevents accidental path syntax.
  return /^[A-Za-z0-9_$-]+$/.test(field) ? field : null;
}

function fieldList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(fieldList);
  if (typeof value !== 'string') return [];
  const fields: string[] = [];
  for (const raw of value.split(',')) {
    const field = normalizeField(raw);
    if (field) fields.push(field);
  }
  return fields;
}

function fieldsFromQuery(query: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.flatMap(key => fieldList(query[key]));
}

export function parseFieldProjection(
  query: Record<string, unknown>,
  presets: Record<string, ProjectionPreset> = {},
  defaultView: string | null = null
): FieldProjection {
  const requestedView = firstString(query.view);
  const view = requestedView && presets[requestedView] ? requestedView : defaultView;
  const preset = view ? presets[view] : undefined;
  const requestedFields = fieldsFromQuery(query, ['fields', 'field', 'select']);
  const hasFieldWhitelist = requestedFields.length > 0;

  const fields = hasFieldWhitelist
    ? new Set(requestedFields)
    : preset?.fields
      ? new Set(preset.fields)
      : null;

  const omit = new Set<string>();
  if (!hasFieldWhitelist) {
    for (const field of preset?.omit ?? []) omit.add(field);
  }
  for (const field of fieldsFromQuery(query, ['omit', 'exclude'])) omit.add(field);

  const include = fieldsFromQuery(query, ['include']);
  for (const field of include) {
    if (fields) fields.add(field);
    omit.delete(field);
  }

  return {
    fields,
    omit,
    view: view ?? null,
    active: fields !== null || omit.size > 0,
  };
}

export function projectionIncludesField(projection: FieldProjection, field: string): boolean {
  if (projection.fields) return projection.fields.has(field) && !projection.omit.has(field);
  return !projection.omit.has(field);
}

export function projectObject<T extends Record<string, unknown>>(
  source: T,
  projection: FieldProjection,
  always: readonly string[] = []
): Partial<T> {
  if (!projection.active && always.length === 0) return source;

  const projected: Partial<T> = {};
  const alwaysSet = new Set(always);

  if (projection.fields) {
    const selected = new Set([...always, ...projection.fields]);
    const sourceRecord = source as Record<string, unknown>;
    const projectedRecord = projected as Record<string, unknown>;
    for (const key of selected) {
      if (!alwaysSet.has(key) && projection.omit.has(key)) continue;
      if (key in sourceRecord) projectedRecord[key] = sourceRecord[key];
    }
    return projected;
  }

  for (const key of Object.keys(source) as Array<keyof T>) {
    const name = String(key);
    if (!alwaysSet.has(name) && projection.omit.has(name)) continue;
    projected[key] = source[key];
  }
  return projected;
}

export function projectArray<T extends Record<string, unknown>>(
  items: readonly T[],
  projection: FieldProjection,
  always: readonly string[] = []
): Array<Partial<T>> {
  return items.map(item => projectObject(item, projection, always));
}
