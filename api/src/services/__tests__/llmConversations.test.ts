/**
 * POST /api/llm/v1/conversations (routes/llmApi.ts, services/llmConversation.ts)
 * — the Mistral Conversations subset. What must hold:
 *
 *  1. The body is validated; stream: true and tools other than web_search are
 *     refused before any turn, like a CLI agent or an agent without the Web
 *     Browser MCP when web_search is asked.
 *  2. The response is exactly Mistral's conversation.response; with web_search
 *     its tool.execution entries are the pages CAPTURED from the agent's Web
 *     Browser tool calls during the turn — never a URL from its answer.
 *  3. A busy or disabled agent answers 409 with Retry-After; a client hanging
 *     up aborts the turn and ends the capture.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';
import {
  beginWebToolCall,
  browserWebMeta,
  rememberWebMeta,
  trackWebToolCall,
} from '../webCapture.js';

// ── Boundaries: agent visibility and boards ─────────────────────────────────
const BOARDS: Record<string, { id: string; plugins: string[] }> = {
  'board-web': { id: 'board-web', plugins: ['plugin-browser'] },
  'board-plain': { id: 'board-plain', plugins: ['plugin-other'] },
};
const PLUGINS: Record<string, { mcpServerIds: string[] }> = {
  'plugin-browser': { mcpServerIds: ['mcp-browser'] },
  'plugin-other': { mcpServerIds: ['mcp-other'] },
};

mock.module('../../lib/agentAccess.js', {
  namedExports: { checkAgentAccess: async () => ({ ok: true }) },
});
mock.module('../../lib/boardAccess.js', {
  namedExports: { getUserBoardIdSet: async () => new Set<string>() },
});
mock.module('../database.js', {
  namedExports: { getBoardById: async (id: string) => BOARDS[id] ?? null },
});

const { llmApiRoutes } = await import('../../routes/llmApi.js');
const { buildAgentPrompt } = await import('../llmCompletion.js');
const { conversationRequestSchema } = await import('../llmConversation.js');

// ── A fake AgentManager ─────────────────────────────────────────────────────

interface FakeAgent {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  runner: string;
  skills: string[];
  boardId: string | null;
  mcpServers: string[];
}

function agent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    id: 'agent-1',
    name: 'Researcher',
    status: 'idle',
    enabled: true,
    runner: 'sandbox',
    skills: ['plugin-browser'],
    boardId: null,
    mcpServers: [],
    ...overrides,
  };
}

/** What the agent does during its turn; `file` is what it writes to the answer file. */
type Turn = (agentId: string, prompt: string) => Promise<{ file?: string | null; reply?: string }>;

const ANSWER_PATH = /`(\/tmp\/pulsar-llm-api\/[^`]+)`/;

function fakeManager(agents: FakeAgent[], turn: Turn = async () => ({ file: 'The answer.' })) {
  const prompts: string[] = [];
  const aborted: string[] = [];
  const abortWaiters: (() => void)[] = [];
  const files = new Map<string, string>();
  const manager = {
    _agentsForUser: () => agents,
    skillManager: { getById: (id: string) => PLUGINS[id] ?? null },
    async sendMessage(id: string, prompt: string, cb: (chunk: string) => void) {
      prompts.push(prompt);
      cb('Working…');
      const out = await turn(id, prompt);
      const path = ANSWER_PATH.exec(prompt)![1];
      if (out.file != null) files.set(path, out.file);
      return out.reply ?? 'Done.';
    },
    abortChatTurn(id: string) {
      aborted.push(id);
      for (const wake of abortWaiters.splice(0)) wake();
      return true;
    },
    beginStream() {},
    appendStreamChunk() {},
    endStream() {},
    errorStream() {},
    isTerminalDriven: (id: string) => agents.some(a => a.id === id && a.runner === 'claudecode'),
    startCliTurn: async () => {
      throw new Error('not used');
    },
    isCliTurnActive: () => false,
    endCliTurn() {},
    _checkTerminalAuthError: async () => null,
    _isCliQuiet: async () => false,
    addActionLog() {},
    executionManager: {
      async readFile(_id: string, path: string) {
        if (!files.has(path)) throw new Error('No such file');
        return files.get(path)!;
      },
      async exec() {
        return { stdout: '', stderr: '' };
      },
    },
  };
  /** Resolves once the turn is aborted (abortChatTurn). */
  const untilAborted = () => new Promise<void>(resolve => abortWaiters.push(resolve));
  return { manager, prompts, aborted, untilAborted };
}

function routerFor(manager: ReturnType<typeof fakeManager>['manager']) {
  return llmApiRoutes(manager as unknown as Parameters<typeof llmApiRoutes>[0]);
}

/** One Web Browser tool call of `agentId`, through the capture hook as mcpManager makes it. */
async function browserCall(agentId: string, tool: string, args: unknown, response: unknown) {
  const webCall = beginWebToolCall(agentId, 'mcp-browser', tool, args);
  const shaped = { success: true, result: 'text', images: undefined, raw: [] };
  rememberWebMeta(shaped, browserWebMeta(response));
  return trackWebToolCall(webCall, Promise.resolve(shaped));
}

async function post(router: express.Router, body: unknown) {
  const res = await createRouteHarness(router, harnessUser()).post('/v1/conversations', body);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const NODE_RELEASE = 'https://nodejs.org/en/blog/release/v24.0.0';
const NODE_NEWS = 'https://example.com/news/';

// ── Request validation ──────────────────────────────────────────────────────

test('the request schema takes the body a Mistral client sends', () => {
  const full = conversationRequestSchema.safeParse({
    model: 'Researcher',
    instructions: 'Be brief.',
    inputs: [
      { object: 'entry', type: 'message.input', role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: [{ type: 'text', text: 'And now?' }] },
    ],
    tools: [{ type: 'web_search' }],
    completion_args: { temperature: 0.3, max_tokens: 100 },
    store: false,
    stream: false,
    handoff_execution: 'server',
  });
  assert.ok(full.success);
  const bad = [
    { inputs: 'Hi' },
    { model: 'Researcher' },
    { model: 'Researcher', inputs: '' },
    { model: 'Researcher', inputs: [] },
    { model: 'Researcher', inputs: [{ role: 'tool', content: 'x' }] },
    { model: 'Researcher', inputs: [{ type: 'message.input', role: 'tool', content: 'x' }] },
    { model: 'Researcher', inputs: [{ type: 'tool.execution', name: 'web_search' }] },
    { model: 'Researcher', inputs: 'Hi', tools: [{ name: 'no type' }] },
  ];
  for (const body of bad) {
    assert.equal(conversationRequestSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

test('a malformed body is a 400 invalid_request in the OpenAI envelope, before any turn', async () => {
  const fake = fakeManager([agent()]);
  const res = await post(routerFor(fake.manager), { model: 'Researcher' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_request');
  assert.equal(res.body.error.type, 'invalid_request_error');
  assert.equal(res.body.error.param, null);
  assert.match(res.body.error.message, /^Invalid request: inputs/);
  assert.equal(fake.prompts.length, 0);
});

test('stream: true and tools other than web_search are refused before any turn', async () => {
  const fake = fakeManager([agent()]);
  const router = routerFor(fake.manager);
  const stream = await post(router, { model: 'Researcher', inputs: 'Hi', stream: true });
  assert.equal(stream.status, 400);
  assert.equal(stream.body.error.code, 'stream_not_supported');
  for (const tools of [
    [{ type: 'function', function: { name: 'f' } }],
    [{ type: 'web_search' }, { type: 'code_interpreter' }],
    [{ type: 'web_search_premium' }],
  ]) {
    const res = await post(router, { model: 'Researcher', inputs: 'Hi', tools });
    assert.equal(res.status, 400, JSON.stringify(tools));
    assert.equal(res.body.error.code, 'tool_not_supported');
  }
  assert.equal(fake.prompts.length, 0);
});

test('an unknown model answers 404 model_not_found', async () => {
  const fake = fakeManager([agent()]);
  const res = await post(routerFor(fake.manager), { model: 'Nobody', inputs: 'Hi' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'model_not_found');
});

// ── A plain conversation ────────────────────────────────────────────────────

test('without tools the response is exactly one message.output entry', async () => {
  const fake = fakeManager([agent({ skills: [] })], async () => ({ file: '4\n' }));
  const res = await post(routerFor(fake.manager), {
    model: 'researcher',
    instructions: 'Answer with a number.',
    inputs: 'What is 2+2?',
    completion_args: { temperature: 0 },
    store: true,
  });
  assert.equal(res.status, 200);
  const prompt = fake.prompts[0];
  assert.match(res.body.conversation_id, /^conv_[0-9a-f]{32}$/);
  assert.deepEqual(res.body, {
    object: 'conversation.response',
    conversation_id: res.body.conversation_id,
    outputs: [{ object: 'entry', type: 'message.output', role: 'assistant', content: '4' }],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: 1,
      total_tokens: Math.ceil(prompt.length / 4) + 1,
    },
  });
  // instructions as the caller's system message, inputs as the request.
  assert.match(prompt, /Instructions from the caller:\nAnswer with a number\./);
  assert.match(prompt, /Request:\nWhat is 2\+2\?/);
  assert.doesNotMatch(prompt, /search_web/);
});

test('a list of inputs is the conversation; every request is a new conversation id', async () => {
  const fake = fakeManager([agent()]);
  const router = routerFor(fake.manager);
  const body = {
    model: 'agent-1',
    inputs: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: [{ type: 'text', text: 'Bye?' }] },
    ],
  };
  const first = await post(router, body);
  const second = await post(router, body);
  assert.equal(first.status, 200);
  assert.match(fake.prompts[0], /### User\nHello\n\n### Assistant\nHi!\n\n### User\nBye\?/);
  assert.notEqual(first.body.conversation_id, second.body.conversation_id);
});

test('a stateless client replaying the previous outputs: role-less entries are skipped', async () => {
  const fake = fakeManager([agent()]);
  const res = await post(routerFor(fake.manager), {
    model: 'Researcher',
    inputs: [
      { object: 'entry', type: 'message.input', role: 'user', content: 'Node 24?' },
      {
        object: 'entry',
        type: 'tool.execution',
        name: 'web_search',
        arguments: '{"query":"node 24"}',
        info: { result: [{ url: NODE_RELEASE, title: 'Node' }] },
      },
      { object: 'entry', type: 'message.output', role: 'assistant', content: 'It is out.' },
      { object: 'entry', type: 'message.input', role: 'user', content: 'When?' },
    ],
    store: false,
  });
  assert.equal(res.status, 200);
  assert.match(
    fake.prompts[0],
    /### User\nNode 24\?\n\n### Assistant\nIt is out\.\n\n### User\nWhen\?/
  );
  assert.doesNotMatch(fake.prompts[0], /nodejs\.org/);
});

test('the web search rule only enters the prompt when asked', () => {
  const messages = [{ role: 'user' as const, content: 'Hi' }];
  const delivery = { file: '/tmp/pulsar-llm-api/x.out' };
  const plain = buildAgentPrompt(messages, delivery).prompt;
  assert.equal(buildAgentPrompt(messages, delivery, null, false).prompt, plain);
  const web = buildAgentPrompt(messages, delivery, null, true).prompt;
  assert.match(web, /use the search_web tool of your Web Browser MCP server/);
  assert.equal(web.replace(/\n\nSearch the web to answer[^\n]*/, ''), plain);
});

test('an empty answer is a 502 empty_answer', async () => {
  const fake = fakeManager([agent()], async () => ({ file: null, reply: '   ' }));
  const res = await post(routerFor(fake.manager), { model: 'Researcher', inputs: 'Hi' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'empty_answer');
});

// ── web_search ──────────────────────────────────────────────────────────────

test('web_search is refused for a CLI agent or one without the Web Browser MCP', async () => {
  const cases: [string, FakeAgent][] = [
    ['CLI agent', agent({ runner: 'claudecode' })],
    ['no plugin', agent({ skills: [] })],
    ['another plugin', agent({ skills: ['plugin-other'], boardId: 'board-plain' })],
    ['missing board', agent({ skills: [], boardId: 'board-gone' })],
  ];
  for (const [label, a] of cases) {
    const fake = fakeManager([a]);
    const res = await post(routerFor(fake.manager), {
      model: 'Researcher',
      inputs: 'Hi',
      tools: [{ type: 'web_search' }],
    });
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error.code, 'web_search_unsupported_for_agent', label);
    assert.equal(fake.prompts.length, 0, `${label}: no turn started`);
  }
});

test('the Web Browser MCP may come from the board plugins or the agent MCP servers', async () => {
  for (const a of [
    agent({ skills: [], boardId: 'board-web' }),
    agent({ skills: [], mcpServers: ['mcp-browser'] }),
  ]) {
    const fake = fakeManager([a]);
    const res = await post(routerFor(fake.manager), {
      model: 'Researcher',
      inputs: 'Hi',
      tools: [{ type: 'web_search' }],
    });
    assert.equal(res.status, 200);
    assert.match(fake.prompts[0], /use the search_web tool of your Web Browser MCP server/);
  }
});

test('web_search lists the captured pages — never a URL taken from the answer', async () => {
  const answer = 'Node 24 is out. Sources: https://evil.example/fake and https://answer.example/x';
  const fake = fakeManager([agent()], async agentId => {
    await browserCall(
      agentId,
      'search_web',
      { query: 'node 24' },
      {
        content: '# Search Results for: node 24',
        results: [
          { url: NODE_RELEASE, title: 'Node.js 24.0.0' },
          { url: NODE_NEWS, title: 'News' },
        ],
      }
    );
    // A page from the results: already listed by its search.
    await browserCall(agentId, 'crawl', { url: NODE_RELEASE }, { url: NODE_RELEASE, content: 'x' });
    // A URL the model picked up from a page's text: not a consulted page.
    await browserCall(
      agentId,
      'crawl',
      { url: 'https://injected.example/payload' },
      { url: 'https://injected.example/payload', content: 'x' }
    );
    // Another agent's browsing during the turn is not this conversation's.
    await browserCall(
      'agent-other',
      'search_web',
      { query: 'other' },
      { content: 'md', results: [{ url: 'https://other.example/', title: 'Other' }] }
    );
    return { file: answer };
  });

  const res = await post(routerFor(fake.manager), {
    model: 'Researcher',
    instructions: 'Cite your sources.',
    inputs: [{ role: 'user', content: 'What is new in Node.js 24?' }],
    tools: [{ type: 'web_search' }],
    store: false,
    stream: false,
  });
  assert.equal(res.status, 200);
  const promptTokens = Math.ceil(fake.prompts[0].length / 4);
  const completionTokens = Math.ceil(answer.length / 4);
  const execution = (args: unknown, result: { url: string; title: string }[]) => ({
    object: 'entry',
    type: 'tool.execution',
    name: 'web_search',
    arguments: JSON.stringify(args),
    info: { result },
  });
  assert.deepEqual(res.body, {
    object: 'conversation.response',
    conversation_id: res.body.conversation_id,
    outputs: [
      execution({ query: 'node 24' }, [
        { url: NODE_RELEASE, title: 'Node.js 24.0.0' },
        { url: NODE_NEWS, title: 'News' },
      ]),
      // One entry per crawl too, without its arguments: the first one's page
      // is already listed by the search, the injected one is not a page.
      execution({}, []),
      execution({}, []),
      { object: 'entry', type: 'message.output', role: 'assistant', content: answer },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
  // Nowhere in the tool entries — not in a result, not in the arguments.
  const listed = JSON.stringify(res.body.outputs.slice(0, -1));
  for (const host of ['evil.example', 'answer.example', 'injected.example', 'other.example']) {
    assert.ok(!listed.includes(host), `${host} must not be listed`);
  }
  // The capture ended with the turn.
  assert.equal(beginWebToolCall('agent-1', 'mcp-browser', 'search_web', {}), null);
});

test('the capture ends with the turn: browsing while the answer is read is not listed', async () => {
  const fake = fakeManager([agent()], async agentId => {
    await browserCall(
      agentId,
      'search_web',
      { query: 'mine' },
      { content: 'md', results: [{ url: NODE_RELEASE, title: 'Node' }] }
    );
    return { file: 'Done.' };
  });
  // The turn has settled: the agent, idle again, searches for other work.
  const read = fake.manager.executionManager.readFile;
  fake.manager.executionManager.readFile = async (id: string, path: string) => {
    await browserCall(
      id,
      'search_web',
      { query: 'another task' },
      { content: 'md', results: [{ url: 'https://other-task.example/', title: 'Other' }] }
    );
    return read(id, path);
  };
  const res = await post(routerFor(fake.manager), {
    model: 'Researcher',
    inputs: 'Hi',
    tools: [{ type: 'web_search' }],
  });
  assert.equal(res.status, 200);
  const listed = JSON.stringify(res.body.outputs);
  assert.ok(!listed.includes('another task'));
  assert.ok(!listed.includes('other-task.example'));
  assert.deepEqual(res.body.outputs[0].info.result, [{ url: NODE_RELEASE, title: 'Node' }]);
});

// ── Busy, disabled, disconnected ────────────────────────────────────────────

test('a busy or disabled agent answers 409 with Retry-After: 30', async () => {
  for (const [a, code] of [
    [agent({ status: 'busy' }), 'agent_busy'],
    [agent({ enabled: false }), 'agent_disabled'],
  ] as const) {
    const fake = fakeManager([a]);
    const res = await post(routerFor(fake.manager), { model: 'Researcher', inputs: 'Hi' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, code);
    assert.equal(res.headers.get('retry-after'), '30');
  }
  // chat/completions is unchanged: no Retry-After there.
  const fake = fakeManager([agent({ status: 'busy' })]);
  const res = await createRouteHarness(routerFor(fake.manager), harnessUser()).post(
    '/v1/chat/completions',
    { model: 'Researcher', messages: [{ role: 'user', content: 'Hi' }] }
  );
  assert.equal(res.status, 409);
  assert.equal(res.headers.get('retry-after'), null);
});

test('a second web_search conversation never replaces the running one’s capture', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let searched!: () => void;
  const searchedOnce = new Promise<void>(resolve => (searched = resolve));
  const fake = fakeManager([agent()], async agentId => {
    await browserCall(
      agentId,
      'search_web',
      { query: 'q' },
      { content: 'md', results: [{ url: NODE_RELEASE, title: 'Node' }] }
    );
    searched();
    await gate;
    return { file: 'Done.' };
  });
  const router = routerFor(fake.manager);
  const body = { model: 'Researcher', inputs: 'Hi', tools: [{ type: 'web_search' }] };
  const first = post(router, body);
  await searchedOnce;
  const second = await post(router, body);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'agent_busy');
  assert.equal(second.headers.get('retry-after'), '30');
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.outputs[0].info.result, [{ url: NODE_RELEASE, title: 'Node' }]);
  assert.equal(fake.prompts.length, 1);
});

test('a client hanging up aborts the turn and ends the capture', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: unknown) => logs.push(String(line)));
  let started!: () => void;
  const turnStarted = new Promise<void>(resolve => (started = resolve));
  const fake = fakeManager([agent()], async () => {
    started();
    await fake.untilAborted();
    throw new Error('aborted');
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = harnessUser();
    next();
  });
  app.use(routerFor(fake.manager));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address() as { port: number };
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/v1/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'Researcher', inputs: 'Hi', tools: [{ type: 'web_search' }] }),
      signal: controller.signal,
    });
    await turnStarted;
    controller.abort();
    await assert.rejects(request);
    for (let i = 0; i < 100 && !logs.some(l => l.includes('conversations')); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    server.close();
  }
  assert.deepEqual(fake.aborted, ['agent-1']);
  const line = logs.find(l => l.includes('conversations'));
  assert.match(
    line ?? '',
    /^🔌 \[LLM API\] conversations key=\? model="Researcher" agent=agent-1 web_search=true → client_closed in \d+ms$/
  );
  assert.equal(beginWebToolCall('agent-1', 'mcp-browser', 'search_web', {}), null);
});

test('each request logs one line, success included', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: unknown) => logs.push(String(line)));
  const fake = fakeManager([agent()], async agentId => {
    await browserCall(
      agentId,
      'search_web',
      { query: 'q' },
      { content: 'md', results: [{ url: NODE_RELEASE, title: 'Node' }] }
    );
    return { file: 'Done.' };
  });
  const router = routerFor(fake.manager);
  await post(router, { model: 'Researcher', inputs: 'Hi', tools: [{ type: 'web_search' }] });
  await post(router, { model: 'Researcher', inputs: 'Hi' });
  const lines = logs.filter(l => l.startsWith('🔌 [LLM API] conversations'));
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /^🔌 \[LLM API\] conversations key=\? model="Researcher" agent=agent-1 web_search=true → 200 file tools=1 pages=1 in \d+ms$/
  );
  assert.match(lines[1], / web_search=false → 200 file in \d+ms$/);
});
