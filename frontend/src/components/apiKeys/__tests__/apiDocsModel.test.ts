// The API docs panel renders the OpenAPI document the server generates
// (api/src/services/apiDocs.ts). These tests pin how the shapes zod's
// toJSONSchema actually emits are read back for display — nested nullable
// unions, $refs into components, enums with null — and that the copy-paste
// snippets are valid shell, because a doc whose curl fails is worse than none.
//
// The fixture is a trimmed copy of real generator output, not a hand-imagined
// schema. Run with `npm test` from frontend/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { OpenApiDocument } from '../../../types';
import {
  curlFor,
  firstExample,
  mcpSetupCommands,
  operationsByTag,
  resolveResponse,
  schemaFields,
  toolCallBody,
  typeLabel,
  withServer,
  type DocOperation,
} from '../apiDocsModel';

const doc: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'PulsarTeam API', version: '1.0.0' },
  servers: [{ url: '/' }],
  tags: [{ name: 'Insert' }, { name: 'MCP' }, { name: 'Legacy' }],
  paths: {
    '/api/swarm/boards': {
      get: {
        tags: ['Legacy'],
        operationId: 'legacy_list_boards',
        'x-api-key-scope': 'legacy',
        responses: { '200': { description: 'ok' } },
      },
    },
    '/api/insert/tasks': {
      post: {
        tags: ['Insert'],
        operationId: 'insert_create_task',
        'x-api-key-scope': 'insert',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateTaskInput' },
              examples: {
                minimal: { value: { task: "Call O'Brien" } },
                full: { value: { task: 'x', priority: 'high' } },
              },
            },
          },
        },
        responses: { '403': { $ref: '#/components/responses/KeyRefused' } },
      },
    },
    '/api/insert/board': {
      get: {
        tags: ['Insert'],
        operationId: 'insert_get_board',
        'x-api-key-scope': 'insert',
        responses: {},
      },
    },
    '/api/mcp/insert': {
      post: {
        tags: ['MCP'],
        operationId: 'mcp_insert',
        'x-api-key-scope': 'insert',
        'x-mcp-tools': [
          {
            name: 'create_task',
            description: 'Create a task',
            inputSchema: {
              type: 'object',
              properties: { task: { type: 'string' }, title: { type: 'string' } },
              required: ['task'],
            },
          },
        ],
        responses: {},
      },
    },
  },
  components: {
    schemas: {
      CreateTaskInput: {
        type: 'object',
        properties: {
          title: {
            anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }],
            description: 'Short title shown on the card.',
          },
          task: { type: 'string', minLength: 1, maxLength: 5000, description: 'The task text.' },
          priority: {
            anyOf: [
              { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
              { type: 'null' },
            ],
          },
          due_date: {
            anyOf: [
              {
                anyOf: [
                  { type: 'string', format: 'date' },
                  { type: 'string', format: 'date-time' },
                ],
              },
              { type: 'null' },
            ],
            description: 'ISO date.',
          },
          updates: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          tags: { type: ['array', 'null'], items: { type: 'string' } },
        },
        required: ['task'],
      },
    },
    responses: {
      KeyRefused: { description: 'Unknown or revoked key.' },
    },
  },
};

test('operations group by tag, in the order the document declares its tags', () => {
  const groups = operationsByTag(doc);
  assert.deepEqual(
    groups.map(g => g.tag),
    ['Insert', 'MCP', 'Legacy']
  );
  assert.deepEqual(
    groups[0].ops.map(o => `${o.method} ${o.path}`),
    ['post /api/insert/tasks', 'get /api/insert/board']
  );
});

test('fields resolve the $ref, list required first, and read zod nullable unions', () => {
  const fields = schemaFields(
    doc,
    doc.paths['/api/insert/tasks'].post!.requestBody!.content['application/json'].schema
  );
  assert.equal(fields[0].name, 'task', 'required fields come first');
  assert.equal(fields[0].required, true);
  assert.deepEqual(fields[0].constraints, ['min 1 chars', 'max 5000 chars']);

  const byName = Object.fromEntries(fields.map(f => [f.name, f]));
  assert.equal(byName.title.type, 'string | null');
  assert.equal(byName.title.description, 'Short title shown on the card.');
  assert.deepEqual(byName.title.constraints, ['max 2000 chars']);
  assert.equal(byName.priority.type, '"low" | "medium" | "high" | "urgent" | null');
  assert.equal(byName.due_date.type, 'string (date) | string (date-time) | null');
  assert.equal(byName.tags.type, 'string[] | null');
});

test('only genuinely structured fields offer the raw JSON Schema', () => {
  const fields = schemaFields(doc, { $ref: '#/components/schemas/CreateTaskInput' });
  const nested = fields.filter(f => f.nested).map(f => f.name);
  // A union of scalars (due_date) is not structure; an object is.
  assert.deepEqual(nested, ['updates']);
});

test('a self-referencing $ref cannot hang the renderer', () => {
  const loop: OpenApiDocument = {
    ...doc,
    components: { schemas: { A: { $ref: '#/components/schemas/A' } } },
  };
  assert.equal(typeLabel(loop, { $ref: '#/components/schemas/A' }), 'any');
});

test('curl snippets are valid shell even when the example contains a quote', () => {
  const [insert] = operationsByTag(doc);
  const create = insert.ops[0];
  const curl = curlFor('https://team.example', create, firstExample(create.op, 'minimal'));
  assert.match(curl, /^curl -X POST 'https:\/\/team\.example\/api\/insert\/tasks'/);
  assert.match(curl, /-H 'Authorization: Bearer <insert-key>'/);
  // O'Brien → the POSIX '\'' dance, never a bare quote that ends the string.
  assert.ok(curl.includes(`-d '{"task":"Call O'\\''Brien"}'`), curl);
  assert.ok(!curl.includes('text/event-stream'), 'REST calls do not ask for SSE');
});

test('MCP snippets ask for the event stream the transport requires', () => {
  const mcp = operationsByTag(doc)[1].ops[0];
  const tool = mcp.op['x-mcp-tools']![0];
  const body = toolCallBody(doc, tool);
  assert.deepEqual(body.params, { name: 'create_task', arguments: { task: '<task>' } });
  const curl = curlFor('https://team.example', mcp, body);
  assert.match(curl, /-H 'Accept: application\/json, text\/event-stream'/);
});

test('response refs resolve, and the download points at this instance', () => {
  const refused = resolveResponse(doc, { $ref: '#/components/responses/KeyRefused' });
  assert.equal(refused.description, 'Unknown or revoked key.');
  assert.deepEqual(withServer(doc, 'https://team.example').servers, [
    { url: 'https://team.example' },
  ]);
  assert.deepEqual(doc.servers, [{ url: '/' }], 'the loaded document is not mutated');
});

test('MCP install commands pair each endpoint with its scope and supplied key', () => {
  for (const scope of ['insert', 'management', 'admin'] as const) {
    const entry: DocOperation = {
      path: `/api/mcp/${scope}`,
      method: 'post',
      op: { ...doc.paths['/api/mcp/insert'].post!, 'x-api-key-scope': scope },
    };
    const key = `test-${scope}-key`;
    const commands = mcpSetupCommands('https://team.example', entry, key);
    const capture = `() { printf '%s\\0' "$@"; }`;
    const claudeArgs = execFileSync('sh', ['-c', `claude ${capture}\n${commands.claude}`])
      .toString()
      .split('\0');
    assert.deepEqual(claudeArgs, [
      'mcp',
      'add',
      '--transport',
      'http',
      '--scope',
      'user',
      `pulsar-${scope}`,
      `https://team.example/api/mcp/${scope}`,
      '--header',
      `Authorization: Bearer ${key}`,
      '',
    ]);
    if (scope === 'admin') {
      assert.equal(commands.envVar, undefined);
      assert.equal(
        commands.codex,
        '[mcp_servers.pulsar-admin]\n' +
          'url = "https://team.example/api/mcp/admin"\n' +
          'http_headers = { Authorization = "Bearer test-admin-key" }'
      );
    } else {
      const codexArgs = execFileSync('sh', [
        '-c',
        `codex ${capture}\n${commands.codex}\nprintf '%s' "$${commands.envVar}"`,
      ])
        .toString()
        .split('\0');
      assert.deepEqual(codexArgs, [
        'mcp',
        'add',
        `pulsar-${scope}`,
        '--url',
        `https://team.example/api/mcp/${scope}`,
        '--bearer-token-env-var',
        `PULSAR_${scope.toUpperCase()}_API_KEY`,
        key,
      ]);
    }
    const placeholders = mcpSetupCommands('https://team.example', entry);
    assert.ok(placeholders.codex.includes(`<${scope}-key>`));
    assert.ok(placeholders.claude.includes(`<${scope}-key>`));
  }
});

test('admin snippets use the latest supplied personal key after rotation', () => {
  const entry: DocOperation = {
    path: '/api/mcp/admin',
    method: 'post',
    op: { ...doc.paths['/api/mcp/insert'].post!, 'x-api-key-scope': 'admin' },
  };
  for (const key of ['swarm_sk_original', 'swarm_sk_rotated']) {
    const commands = mcpSetupCommands('https://team.example', entry, key);
    const curl = curlFor('https://team.example', entry, { method: 'tools/list' }, key);
    for (const snippet of [commands.codex, commands.claude, curl]) {
      assert.ok(snippet.includes(`Bearer ${key}`));
      assert.doesNotMatch(snippet, /PULSAR_ADMIN_API_KEY|<admin-key>/);
      if (key.endsWith('rotated')) assert.doesNotMatch(snippet, /swarm_sk_original/);
    }
  }
  const commands = mcpSetupCommands('https://team.example', entry);
  assert.match(commands.codex, /Bearer <admin-key>/);
  assert.doesNotMatch(commands.codex, /PULSAR_ADMIN_API_KEY|swarm_sk_/);
});

test('MCP install commands preserve shell metacharacters without executing them', () => {
  const entry = operationsByTag(doc)[1].ops[0];
  const key = "test-'$(printf injected)`printf injected`-$HOME-\nkey";
  const commands = mcpSetupCommands('https://team.example', entry, key);
  const token = execFileSync('sh', [
    '-c',
    `codex() { :; }\n${commands.codex}\nprintf '%s' "$${commands.envVar}"`,
  ]).toString();
  assert.equal(token, key);
  const header = execFileSync('sh', [
    '-c',
    `claude() { for arg do last="$arg"; done; printf '%s' "$last"; }\n${commands.claude}`,
  ]).toString();
  assert.equal(header, `Authorization: Bearer ${key}`);
  assert.ok(!JSON.stringify(withServer(doc, 'https://team.example')).includes(key));
});
