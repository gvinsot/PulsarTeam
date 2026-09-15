// ── Reading the generated OpenAPI document for display ──────────────────────
//
// Pure functions only, so the API docs panel stays a renderer and this file
// can be tested without a DOM. The document itself comes from
// api/src/services/apiDocs.ts; nothing here invents an endpoint, a field or a
// tool — it only resolves references and formats what the server published.

import type {
  JsonSchema,
  OpenApiDocument,
  OpenApiMethod,
  OpenApiOperation,
  OpenApiResponse,
} from '../../types';

const METHODS: OpenApiMethod[] = ['get', 'post', 'put', 'delete'];

export interface DocOperation {
  path: string;
  method: OpenApiMethod;
  op: OpenApiOperation;
}

/** Operations grouped by their first tag, tags in the document's order. */
export function operationsByTag(doc: OpenApiDocument): { tag: string; ops: DocOperation[] }[] {
  const order = (doc.tags || []).map(t => t.name);
  const groups = new Map<string, DocOperation[]>();
  for (const tag of order) groups.set(tag, []);
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] || 'Other';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push({ path, method, op });
    }
  }
  return [...groups.entries()]
    .filter(([, ops]) => ops.length > 0)
    .map(([tag, ops]) => ({ tag, ops }));
}

/** Follow a `#/components/schemas/<Name>` reference; anything else is returned as is. */
export function resolveSchema(
  doc: OpenApiDocument,
  schema: JsonSchema | undefined
): JsonSchema | undefined {
  let current = schema;
  // Bounded: a malformed self-reference must not hang the renderer.
  for (let hops = 0; current?.$ref && hops < 8; hops++) {
    const name = current.$ref.replace('#/components/schemas/', '');
    current = doc.components.schemas?.[name];
  }
  return current;
}

/** Follow a `#/components/responses/<Name>` reference. */
export function resolveResponse(doc: OpenApiDocument, response: OpenApiResponse): OpenApiResponse {
  if (!response.$ref) return response;
  const name = response.$ref.replace('#/components/responses/', '');
  return doc.components.responses?.[name] || response;
}

function literal(value: unknown): string {
  return value === null ? 'null' : JSON.stringify(value);
}

/** A compact, human type for a schema node: `string | null`, `"low" | "high"`, `string[]`… */
export function typeLabel(doc: OpenApiDocument, raw: JsonSchema | undefined): string {
  const schema = resolveSchema(doc, raw);
  if (!schema) return 'any';
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(' | ');
  const union = schema.anyOf || schema.oneOf;
  if (union) {
    return [...new Set(union.map(member => typeLabel(doc, member)))].join(' | ');
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map(t => (t === 'array' && schema.items ? `${typeLabel(doc, schema.items)}[]` : t))
      .join(' | ');
  }
  if (schema.type === 'array') {
    const item = schema.items ? typeLabel(doc, schema.items) : 'any';
    return item.includes(' ') ? `(${item})[]` : `${item}[]`;
  }
  if (schema.type) return schema.format ? `${schema.type} (${schema.format})` : schema.type;
  if (schema.properties) return 'object';
  return 'any';
}

/** Constraints worth a reader's attention, e.g. `max 5000 chars`. */
export function constraintsOf(doc: OpenApiDocument, raw: JsonSchema | undefined): string[] {
  const schema = resolveSchema(doc, raw);
  if (!schema) return [];
  const members = schema.anyOf || schema.oneOf || [schema];
  const out: string[] = [];
  for (const member of members) {
    const m = resolveSchema(doc, member) || {};
    if (m.minLength !== undefined && m.minLength > 0) out.push(`min ${m.minLength} chars`);
    if (m.maxLength !== undefined) out.push(`max ${m.maxLength} chars`);
    if (m.minimum !== undefined) out.push(`≥ ${m.minimum}`);
    if (m.maximum !== undefined) out.push(`≤ ${m.maximum}`);
  }
  if (schema.default !== undefined) out.push(`default ${literal(schema.default)}`);
  return [...new Set(out)];
}

/** Every non-union member of a (possibly nested) anyOf/oneOf, refs resolved. */
function flattenUnion(doc: OpenApiDocument, schema: JsonSchema, depth = 0): JsonSchema[] {
  const union = schema.anyOf || schema.oneOf;
  if (!union || depth > 8) return [schema];
  return union.flatMap(m => flattenUnion(doc, resolveSchema(doc, m) || {}, depth + 1));
}

export interface SchemaField {
  name: string;
  required: boolean;
  type: string;
  description: string;
  constraints: string[];
  /** True when the field holds structure worth opening as raw JSON Schema. */
  nested: boolean;
}

/** The top-level fields of an object schema, required ones first. */
export function schemaFields(doc: OpenApiDocument, raw: JsonSchema | undefined): SchemaField[] {
  const schema = resolveSchema(doc, raw);
  if (!schema?.properties) return [];
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties)
    .map(([name, prop]) => {
      const resolved = resolveSchema(doc, prop) || {};
      const members = resolved.anyOf || resolved.oneOf || [resolved];
      const nested = flattenUnion(doc, resolved).some(
        r => !!r.properties || !!resolveSchema(doc, r.items)?.properties
      );
      return {
        name,
        required: required.has(name),
        type: typeLabel(doc, prop),
        description:
          resolved.description ||
          members.map(m => resolveSchema(doc, m)?.description).find(Boolean) ||
          '',
        constraints: constraintsOf(doc, prop),
        nested,
      };
    })
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/** The first example body an operation publishes, if any. */
export function firstExample(op: OpenApiOperation, key?: string): unknown {
  const media = op.requestBody?.content['application/json'];
  const examples = media?.examples;
  if (!examples) return undefined;
  if (key && examples[key]) return examples[key].value;
  return Object.values(examples)[0]?.value;
}

/** The key placeholder a snippet should show for an operation's scope. */
export function keyPlaceholder(op: OpenApiOperation): string {
  return `<${op['x-api-key-scope'] || 'api'}-key>`;
}

/** Shell-quote for single-quoted POSIX strings. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A copy-pasteable curl invocation for one operation. */
export function curlFor(
  origin: string,
  entry: DocOperation,
  body?: unknown,
  key = keyPlaceholder(entry.op)
): string {
  const isMcp = !!entry.op['x-mcp-tools'] || entry.path.endsWith('/mcp');
  const lines = [
    `curl -X ${entry.method.toUpperCase()} ${shellQuote(origin + entry.path)}`,
    `  -H ${shellQuote(`Authorization: Bearer ${key}`)}`,
  ];
  if (body !== undefined) {
    lines.push(`  -H ${shellQuote('Content-Type: application/json')}`);
    if (isMcp) lines.push(`  -H ${shellQuote('Accept: application/json, text/event-stream')}`);
    lines.push(`  -d ${shellQuote(JSON.stringify(body))}`);
  }
  return lines.join(' \\\n');
}

/** A `tools/call` JSON-RPC body for one tool, with its required fields stubbed. */
export function toolCallBody(
  doc: OpenApiDocument,
  tool: { name: string; inputSchema: JsonSchema }
) {
  const args: Record<string, unknown> = {};
  for (const field of schemaFields(doc, tool.inputSchema)) {
    if (field.required) args[field.name] = `<${field.name}>`;
  }
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool.name, arguments: args },
  };
}

/** The document with its `servers` pointed at this instance, for download. */
export function withServer(doc: OpenApiDocument, origin: string): OpenApiDocument {
  return { ...doc, servers: [{ url: origin }] };
}

/** Anchor id for an operation card. */
export function operationAnchor(op: OpenApiOperation): string {
  return `api-op-${op.operationId}`;
}
