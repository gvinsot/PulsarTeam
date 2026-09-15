// ── The generated API documentation ─────────────────────────────────────────
//
// What GET /api/settings/api-docs/openapi.json returns. Produced by
// api/src/services/apiDocs.ts buildOpenApiDocument: an OpenAPI 3.1 document
// whose request bodies are `z.toJSONSchema` of the zod schemas the routes
// validate with, and whose `x-mcp-tools` are the live `tools/list` answer of
// each MCP surface.
//
// Only the subset the API docs panel reads is declared. JSON Schema is an open
// vocabulary (zod emits anyOf/const/format/…), so `JsonSchema` names the keys
// the renderer understands and keeps the rest reachable as `unknown`.

/** A JSON Schema node, as zod's toJSONSchema and the doc builder emit it. */
export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  description?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

/** One tool of an MCP surface, verbatim from `tools/list`. */
export interface McpToolDoc {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface OpenApiExample {
  summary?: string;
  value: unknown;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface OpenApiResponse {
  $ref?: string;
  description?: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface OpenApiOperation {
  tags?: string[];
  operationId: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  security?: Record<string, string[]>[];
  /** Which key opens it: 'insert' | 'management' | 'admin' | 'legacy'. */
  'x-api-key-scope'?: string;
  /** MCP surfaces only. */
  'x-mcp-tools'?: McpToolDoc[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema?: JsonSchema; examples?: Record<string, OpenApiExample> }>;
  };
  responses: Record<string, OpenApiResponse>;
}

export type OpenApiMethod = 'get' | 'post' | 'put' | 'delete';

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Partial<Record<OpenApiMethod, OpenApiOperation>>>;
  components: {
    securitySchemes?: Record<string, { description?: string }>;
    schemas?: Record<string, JsonSchema>;
    responses?: Record<string, OpenApiResponse>;
  };
}
