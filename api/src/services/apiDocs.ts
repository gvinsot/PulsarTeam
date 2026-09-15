// ── The API documentation, generated from what the server actually runs ─────
//
// Served as an OpenAPI 3.1 document (routes/apiDocs.ts) that the UI renders in
// the API keys modal and offers for download.
//
// Nothing that can drift is written by hand here:
//
//   • request bodies are `z.toJSONSchema` of the zod schemas the routes
//     validate with (`createTaskFieldsSchema`, `swarmCreateTaskSchema`);
//   • the tool catalogue of each MCP surface is the `tools/list` answer of a
//     REAL server instance, obtained over an in-memory MCP transport — exactly
//     what a client holding a key would receive;
//   • the task response lists `TASK_VIEW_KEYS`, the keys `taskView` returns.
//
// What IS prose — which key opens which surface, the error vocabulary, the
// transport notes — sits next to the mounts it describes and is pinned by
// services/__tests__/apiDocs.test.ts against the route inventory.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentManager } from './agentManager/index.js';
import type { MCPManager } from './mcpManager.js';
import type { SkillManager } from './skillManager.js';
import { createAdminMcpServer } from './mcp/adminMcp.js';
import { createManagementMcpServer } from './mcp/managementMcp.js';
import { createInsertMcpServer } from './mcp/insertMcp.js';
import { createTaskFieldsSchema } from './mcp/taskInsertion.js';
import { TASK_VIEW_KEYS } from './mcp/taskOperations.js';
import { swarmCreateTaskSchema } from '../routes/swarmApi.js';
import { INSERT_RATE_LIMIT_PER_MINUTE } from '../routes/insertApi.js';

/** One tool as `tools/list` publishes it. */
export interface DocumentedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

/**
 * JSON Schema for a zod schema, as an OpenAPI 3.1 component. `io: 'input'`
 * documents what a caller SENDS (defaults optional), and the `$schema` marker
 * is dropped because OpenAPI 3.1 already fixes the dialect.
 */
function bodySchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonObject;
  delete json.$schema;
  return json;
}

/** Ask a real MCP server for its catalogue, the way a remote client would. */
export async function listServerTools(server: McpServer): Promise<DocumentedTool[]> {
  const client = new Client({ name: 'pulsarteam-api-docs', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools
      .map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as JsonObject,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/**
 * Stand-in identity used ONLY to instantiate the servers for `tools/list`.
 * Listing tools runs no handler, so it never reads or writes anything as this
 * actor; it exists because the factories bind every tool to an actor.
 */
const DOCS_ACTOR = { userId: '', username: 'api-docs', role: 'basic', csrf: '' };
const DOCS_BOARD_ID = '00000000-0000-4000-8000-000000000000';

// ── Schemas shared by several operations ────────────────────────────────────

const nullable = (type: string, description: string) => ({
  type: [type, 'null'],
  description,
});

/** Types for `TASK_VIEW_KEYS`. A key missing here is a test failure. */
export const TASK_VIEW_PROPERTIES: Record<(typeof TASK_VIEW_KEYS)[number], JsonObject> = {
  id: { type: 'string', format: 'uuid', description: 'Task id.' },
  title: nullable('string', 'Short title, when set.'),
  text: { type: 'string', description: 'Task description.' },
  status: { type: 'string', description: 'Workflow column id.' },
  boardId: nullable('string', 'Board the task lives on.'),
  agentId: nullable('string', 'Owning agent — null for board-level tasks.'),
  assignee: nullable('string', 'Agent the task is delegated to.'),
  project: nullable('string', "Board project's name, inherited from the board."),
  taskType: nullable('string', 'Free-form task type (bug, feature…).'),
  priority: {
    type: ['string', 'null'],
    enum: ['low', 'medium', 'high', 'urgent', null],
    description: 'Priority.',
  },
  dueDate: nullable('string', 'Deadline, ISO date or timestamp.'),
  isManual: nullable('boolean', 'True when the workflow must not run agents on it.'),
  repoFullName: nullable('string', 'Target repository, "owner/repo".'),
  repoProvider: nullable('string', 'Repository provider (github…).'),
  secondaryRepos: { type: ['array', 'null'], description: 'Extra repositories cloned alongside.' },
  storagePath: nullable('string', 'Target storage location.'),
  storageProvider: nullable('string', 'Storage provider (onedrive…).'),
  createdAt: nullable('string', 'Creation timestamp.'),
  updatedAt: nullable('string', 'Last update timestamp.'),
  startedAt: nullable('string', 'When execution started.'),
  completedAt: nullable('string', 'When the task was completed.'),
  executionStatus: nullable('string', 'Execution state (running, stopped, error…).'),
  actionRunning: nullable('boolean', 'True while a workflow action runs on it.'),
  actionRunningAgentId: nullable('string', 'Agent running that action.'),
  actionRunningMode: nullable('string', 'Mode of that action (decide, refine…).'),
  error: nullable('string', 'Last execution error.'),
  errorFromStatus: nullable('string', 'Column the task was in when it failed.'),
  isTemplate: nullable('boolean', 'True for a recurring rule (never on a created task).'),
  templateId: nullable('string', 'Recurring rule this task is a run of.'),
  occurrenceSeq: nullable('integer', 'Run number within its rule.'),
  recurrence: { type: ['object', 'null'], description: 'Recurrence configuration (rules only).' },
  commits: { type: ['array', 'null'], description: 'Linked commits.' },
  trustLevel: {
    type: ['string', 'null'],
    enum: ['untrusted', 'approved', null],
    description:
      'null: written inside the tenant. `untrusted`: created through an insert key — no agent works on it until a human approves it. `approved`: external and approved; it still runs under a restricted security profile.',
  },
  securityFlags: {
    type: ['array', 'null'],
    description:
      'Prompt-injection signals detected when the external text arrived: `{ code, severity, label, excerpt }`. Signals, not verdicts.',
  },
};

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
};

const validationErrorSchema = {
  type: 'object',
  required: ['error', 'details'],
  properties: {
    error: { const: 'Validation failed' },
    details: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Offending field, dot-separated.' },
          message: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
};

const jsonRpcRequestSchema = {
  type: 'object',
  required: ['jsonrpc', 'id', 'method'],
  properties: {
    jsonrpc: { const: '2.0' },
    id: { type: ['string', 'integer'] },
    method: {
      type: 'string',
      examples: ['initialize', 'tools/list', 'tools/call'],
    },
    params: { type: 'object' },
  },
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

/** The authentication failures every key-guarded operation shares. */
const keyErrors = {
  '401': { $ref: '#/components/responses/MissingKey' },
  '403': { $ref: '#/components/responses/KeyRefused' },
  '503': { $ref: '#/components/responses/AuthUnavailable' },
};

// ── The surfaces ────────────────────────────────────────────────────────────

/** Which key opens which MCP mount. Pinned against src/index.ts by the tests. */
export const MCP_SURFACES = [
  {
    path: '/api/mcp/insert',
    scope: 'insert',
    security: 'insertKey',
    title: 'Insert MCP',
    summary: "Create tasks on the key's board",
    description:
      'Two tools: `get_board` (name and columns the key may write to) and `create_task`. The board comes from the key and is never an argument; no task can be read, moved or deleted. Tasks are created `untrusted`: no agent works on them until a human approves them.',
  },
  {
    path: '/api/mcp/management',
    scope: 'management',
    security: 'managementKey',
    title: 'Management MCP',
    summary: 'File, move, delegate, run and close tasks',
    description:
      'Every tool is bounded by the boards the key owner can reach (own + shared). No agent, board, project or workflow mutation. Also opened by an `admin` key.',
  },
  {
    path: '/api/mcp/admin',
    scope: 'admin',
    security: 'adminKey',
    title: 'Admin MCP',
    summary: 'Shape agents, boards, projects, workflows and shares',
    description:
      '`admin` is a tool set, not a role: every tool stays bounded by what the key owner can already administer in the UI, and instance-wide tools (`list_users`) re-check the owner role.',
  },
] as const;

export interface ApiDocsManagers {
  agentManager: AgentManager;
  mcpManager: MCPManager;
  skillManager: SkillManager;
}

/** Build the whole OpenAPI document. Pure apart from the in-memory tools/list. */
export async function buildOpenApiDocument(managers: ApiDocsManagers): Promise<JsonObject> {
  const { agentManager, mcpManager, skillManager } = managers;
  const [insertTools, managementTools, adminTools] = await Promise.all([
    listServerTools(
      createInsertMcpServer(agentManager, DOCS_ACTOR, {
        apiKeyId: 'api-docs',
        boardId: DOCS_BOARD_ID,
      })
    ),
    listServerTools(createManagementMcpServer(agentManager, DOCS_ACTOR)),
    listServerTools(createAdminMcpServer(agentManager, mcpManager, skillManager, DOCS_ACTOR)),
  ]);
  const toolsBySurface: Record<string, DocumentedTool[]> = {
    '/api/mcp/insert': insertTools,
    '/api/mcp/management': managementTools,
    '/api/mcp/admin': adminTools,
  };

  const bearer = (scope: string, text: string) => ({
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'swarm_sk_<64 hex>',
    description: `${scope} key. ${text}`,
  });

  const mcpPaths = Object.fromEntries(
    MCP_SURFACES.map(surface => [
      surface.path,
      {
        post: {
          tags: ['MCP'],
          operationId: `mcp_${surface.scope}`,
          summary: surface.summary,
          description:
            `${surface.description}\n\n` +
            'Streamable HTTP MCP, stateless: every POST carries one JSON-RPC 2.0 message and no session id is issued. ' +
            'Send `Accept: application/json, text/event-stream`; the answer is streamed as a `text/event-stream` whose `data:` line holds the JSON-RPC response. ' +
            'Tool failures are not HTTP errors: they come back as a 200 whose result has `isError: true` and a JSON `{ "error": "…" }` text content. ' +
            'Out-of-scope ids answer "<Resource> not found", exactly like ids that do not exist.',
          security: [{ [surface.security]: [] }],
          'x-api-key-scope': surface.scope,
          'x-mcp-tools': toolsBySurface[surface.path],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JsonRpcRequest' },
                examples: {
                  list: {
                    summary: 'List the tools',
                    value: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
                  },
                  call: {
                    summary: 'Call a tool',
                    value: {
                      jsonrpc: '2.0',
                      id: 2,
                      method: 'tools/call',
                      params: {
                        name: surface.scope === 'admin' ? 'list_boards' : 'create_task',
                        arguments:
                          surface.scope === 'insert'
                            ? { task: 'Customer reports a broken export', priority: 'high' }
                            : surface.scope === 'management'
                              ? { board_id: '<board uuid>', task: 'Prepare the release notes' }
                              : {},
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'JSON-RPC response, as an event stream.',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            '405': errorResponse('Anything but POST.'),
            '406': errorResponse(
              'The `Accept` header does not list both application/json and text/event-stream.'
            ),
            ...keyErrors,
          },
        },
      },
    ])
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'PulsarTeam API',
      version: '1.0.0',
      description:
        'Key-authenticated API of a PulsarTeam instance.\n\n' +
        'Every request authenticates with `Authorization: Bearer <key>`. Keys are minted, rotated and revoked by each user from the **API keys** dialog, stored as an HMAC and shown in clear exactly once. ' +
        'A key names its owner, never their permissions: the owner is re-read on every request, so a demotion, an unshared board or a deleted account restricts the key on its very next call.\n\n' +
        '| Key | Opens |\n|---|---|\n' +
        '| `insert` | `/api/insert/*`, `/api/mcp/insert` — task creation on the one board it is bound to |\n' +
        '| `management` | `/api/mcp/management` |\n' +
        '| `admin` | `/api/mcp/admin` and `/api/mcp/management` |\n' +
        '| legacy (instance-wide) | `/api/swarm/*` only — deprecated |\n\n' +
        'Keys never cross these lines: an `admin` key does not open the insert surface (it has no board), and no personal key opens `/api/swarm/*`.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'Insert', description: 'REST task creation with a board-bound `insert` key.' },
      { name: 'MCP', description: 'Model Context Protocol surfaces for AI clients.' },
      { name: 'Legacy', description: 'Instance-wide key. Deprecated: migrate to a personal key.' },
    ],
    paths: {
      '/api/insert/board': {
        get: {
          tags: ['Insert'],
          operationId: 'insert_get_board',
          summary: "Describe the key's board",
          description:
            'Name of the board the key is bound to and the columns the key may write to (all of them unless the key was narrowed) — use a column label or id as `status`. Board metadata only; no task is readable with this key.',
          security: [{ insertKey: [] }],
          'x-api-key-scope': 'insert',
          responses: {
            '200': {
              description: 'The board.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { board: { $ref: '#/components/schemas/InsertBoard' } },
                  },
                },
              },
            },
            '429': { $ref: '#/components/responses/RateLimited' },
            ...keyErrors,
          },
        },
      },
      '/api/insert/tasks': {
        post: {
          tags: ['Insert'],
          operationId: 'insert_create_task',
          summary: "Create a task on the key's board",
          description:
            'Creates one unassigned task. `status` accepts a column label or id among the columns the key may write to, and defaults to the first of them.\n\n' +
            '**The task is created `untrusted`.** Its text was written outside the organisation, so no workflow action and no agent touches it until a person approves it in the UI; invisible characters are removed on arrival and prompt-injection signals are recorded in `securityFlags` for that person. Once approved it still runs under a restricted profile (fresh context, no credentials, no MCP servers, no other agent).\n\n' +
            "Fields not listed are ignored. The board is always the key's own: a `board_id` in the body has no effect.",
          security: [{ insertKey: [] }],
          'x-api-key-scope': 'insert',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateTaskInput' },
                examples: {
                  minimal: {
                    summary: 'Minimal',
                    value: { task: 'Call back ACME about invoice 42' },
                  },
                  full: {
                    summary: 'Every field',
                    value: {
                      task: 'The CSV export times out for accounts with more than 10k rows.',
                      title: 'CSV export timeout',
                      priority: 'high',
                      due_date: '2026-10-01',
                      task_type: 'bug',
                      status: 'Backlog',
                      repo_full_name: 'acme/webapp',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Task created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['success', 'task'],
                    properties: {
                      success: { const: true },
                      task: { $ref: '#/components/schemas/Task' },
                    },
                  },
                },
              },
            },
            '400': {
              description:
                'Body failed validation (`Validation failed` + `details`), or a value does not fit the board (unknown column, malformed repository).',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/ValidationError' },
                      { $ref: '#/components/schemas/Error' },
                    ],
                  },
                },
              },
            },
            '429': { $ref: '#/components/responses/RateLimited' },
            '500': {
              description:
                'Server failure — safe to retry. If the task row was already written, `task_id` names it: check before retrying to avoid a duplicate.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' }, task_id: { type: 'string' } },
                  },
                },
              },
            },
            ...keyErrors,
          },
        },
      },
      ...mcpPaths,
      '/api/swarm/mcp': {
        post: {
          tags: ['Legacy'],
          deprecated: true,
          operationId: 'legacy_mcp',
          summary: 'Instance-wide MCP, no tenant',
          description:
            'Streamable HTTP MCP reached with the legacy key. Its tools run with no tenant at all. Migrate to `/api/mcp/management` or `/api/mcp/insert`.',
          security: [{ legacyKey: [] }],
          'x-api-key-scope': 'legacy',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/JsonRpcRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'JSON-RPC response, as an event stream.',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            ...keyErrors,
          },
        },
      },
      '/api/swarm/agents': {
        get: {
          tags: ['Legacy'],
          deprecated: true,
          operationId: 'legacy_list_agents',
          summary: 'List every agent of the instance',
          security: [{ legacyKey: [] }],
          'x-api-key-scope': 'legacy',
          parameters: [
            { name: 'project', in: 'query', schema: { type: 'string' } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['idle', 'busy', 'error'] },
            },
          ],
          responses: { '200': { description: '`{ count, agents }`' }, ...keyErrors },
        },
      },
      '/api/swarm/agents/{id}': {
        get: {
          tags: ['Legacy'],
          deprecated: true,
          operationId: 'legacy_get_agent',
          summary: 'One agent, by id or name',
          security: [{ legacyKey: [] }],
          'x-api-key-scope': 'legacy',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Agent with its task list and metrics.' },
            '404': errorResponse('No such agent.'),
            ...keyErrors,
          },
        },
      },
      '/api/swarm/boards': {
        get: {
          tags: ['Legacy'],
          deprecated: true,
          operationId: 'legacy_list_boards',
          summary: 'List every board of the instance',
          security: [{ legacyKey: [] }],
          'x-api-key-scope': 'legacy',
          responses: { '200': { description: '`{ count, boards }`' }, ...keyErrors },
        },
      },
      '/api/swarm/agents/{id}/tasks': {
        post: {
          tags: ['Legacy'],
          deprecated: true,
          operationId: 'legacy_add_task',
          summary: 'Add a task to an agent',
          description: 'Prefer `POST /api/insert/tasks` with an insert key.',
          security: [{ legacyKey: [] }],
          'x-api-key-scope': 'legacy',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: bodySchema(swarmCreateTaskSchema) } },
          },
          responses: {
            '201': { description: '`{ success, task, agent, board_id }`' },
            '400': errorResponse('Validation failed.'),
            '404': errorResponse('No such agent or board.'),
            ...keyErrors,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        insertKey: bearer(
          'Insert',
          'Bound to one board at mint time, optionally narrowed to some of its columns; creates tasks there and nothing else. Several may exist per board. The owner must still be able to edit the board on every request. Tasks it creates wait for human approval before any agent sees them.'
        ),
        managementKey: bearer('Management', 'One per user; minting again rotates it.'),
        adminKey: bearer('Admin', 'One per user; also opens the management surface.'),
        legacyKey: bearer('Legacy instance-wide', 'Names nobody; deprecated.'),
      },
      schemas: {
        CreateTaskInput: bodySchema(createTaskFieldsSchema),
        Task: {
          type: 'object',
          description: 'Every key is always present; absent values are null.',
          properties: TASK_VIEW_PROPERTIES,
        },
        InsertBoard: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, label: { type: 'string' } },
              },
            },
          },
        },
        Error: errorSchema,
        ValidationError: validationErrorSchema,
        JsonRpcRequest: jsonRpcRequestSchema,
      },
      responses: {
        MissingKey: errorResponse('No `Authorization: Bearer <key>` header.'),
        KeyRefused: errorResponse(
          'Unknown or revoked key; a key used outside its surface; owner deleted; or, for an insert key, owner no longer able to edit its board.'
        ),
        AuthUnavailable: errorResponse('Key store unreachable. Retry later — never fails open.'),
        RateLimited: errorResponse(
          `More than ${INSERT_RATE_LIMIT_PER_MINUTE} requests in a minute on this key (or the per-IP ceiling). See the RateLimit-* headers.`
        ),
      },
    },
  };
}

let cached: Promise<JsonObject> | null = null;

/**
 * The document, built once per process — its inputs are code, not data. A
 * failed build is not cached, so a transient error does not stick.
 */
export function getOpenApiDocument(managers: ApiDocsManagers): Promise<JsonObject> {
  if (!cached) {
    cached = buildOpenApiDocument(managers).catch(err => {
      cached = null;
      throw err;
    });
  }
  return cached;
}
