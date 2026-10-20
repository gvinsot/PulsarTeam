import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { asyncHandler } from '../lib/asyncHandler.js';
import { checkAgentAccess } from '../lib/agentAccess.js';
import { getUserBoardIdSet } from '../lib/boardAccess.js';
import { formatZodError } from '../lib/validate.js';
import { errorMessage } from '../lib/errors.js';
import type { AgentManager } from '../services/agentManager/index.js';
import { getBoardById } from '../services/database.js';
import { isCliRunner } from '../services/runners.js';
import { startWebCapture, toConversationToolEntries } from '../services/webCapture.js';
import {
  CONVERSATION_RETRY_AFTER_S,
  conversationFeatures,
  conversationMessages,
  conversationRequestSchema,
  conversationResponseBody,
  newConversationId,
} from '../services/llmConversation.js';
import {
  LLM_KEY_RATE_LIMIT_PER_MINUTE,
  LlmRequestError,
  chatCompletionBody,
  chatCompletionChunk,
  chatCompletionRequestSchema,
  parseResponseFormat,
  runAgentCompletion,
  type CompletionAgent,
  type CompletionOptions,
  type CompletionRunner,
} from '../services/llmCompletion.js';

/**
 * /api/llm/v1 — an OpenAI-compatible endpoint answered by an agent.
 *
 *   GET  /api/llm/v1/models            — the agents the key may address
 *   POST /api/llm/v1/chat/completions  — one agent turn, OpenAI-shaped answer
 *   POST /api/llm/v1/conversations     — one agent turn, Mistral-shaped answer
 *                                        (optionally with the pages it consulted)
 *
 * Mounted behind `requireApiKeyScope('llm')` (src/index.ts), which resolves
 * the key's owner live. `model` names the agent (name or id); it must be one
 * the owner can EDIT — the level POST /api/agents/:id/chat demands — and that
 * is re-checked on every request, so unsharing a board stops the key there.
 *
 * Point any OpenAI SDK at `<origin>/api/llm/v1` with the key as `api_key`
 * (a Mistral SDK at `<origin>/api/llm`: it adds `/v1/…` itself).
 */
export function llmApiRoutes(agentManager: AgentManager) {
  const router = express.Router();

  // Keyed on the API key, not the IP — see routes/insertApi.ts.
  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: LLM_KEY_RATE_LIMIT_PER_MINUTE,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: req => `llm-key:${req.apiKey?.id ?? 'unknown'}`,
      message: new LlmRequestError(
        429,
        'Too many requests for this API key, please slow down.',
        'rate_limit_exceeded'
      ).toJSON(),
    })
  );

  /** Every agent the key's owner can edit, i.e. may chat with. */
  async function addressableAgents(req: express.Request): Promise<CompletionAgent[]> {
    const user = req.user!;
    const boardIds = await getUserBoardIdSet(user.userId);
    const visible = agentManager._agentsForUser(user.userId, user.role, boardIds);
    const allowed: CompletionAgent[] = [];
    for (const agent of visible) {
      if ((await checkAgentAccess(agent, user, 'edit')).ok) allowed.push(agent);
    }
    return allowed;
  }

  /** Resolve `model` to an agent: exact id first, then case-insensitive name. */
  async function resolveAgent(req: express.Request, model: string): Promise<CompletionAgent> {
    const agents = await addressableAgents(req);
    const wanted = model.trim();
    const byId = agents.find(a => a.id === wanted);
    if (byId) return byId;
    const byName = agents.filter(a => (a.name || '').toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new LlmRequestError(
        400,
        `Several agents are named "${model}" — use the agent id as model`,
        'model_ambiguous'
      );
    }
    // Same answer whether the agent does not exist or is not the owner's:
    // never an oracle on other tenants' agent ids.
    throw new LlmRequestError(404, `The model "${model}" does not exist`, 'model_not_found');
  }

  /**
   * Aborts when the client hangs up before the response is complete. 'close'
   * also fires after a normal end, hence the writableFinished check.
   */
  function clientGoneSignal(res: express.Response): AbortSignal {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller.signal;
  }

  function asLlmError(err: unknown): LlmRequestError {
    if (err instanceof LlmRequestError) return err;
    console.error('LLM API error:', errorMessage(err));
    return new LlmRequestError(500, errorMessage(err) || 'Internal error', 'internal_error');
  }

  /** Answers the error; returns its "<status> <code>" for the request log. */
  function sendError(res: express.Response, err: unknown): string {
    const e = asLlmError(err);
    res.status(e.status).json(e.toJSON());
    return `${e.status} ${e.code}`;
  }

  router.get(
    '/v1/models',
    asyncHandler(async (req, res) => {
      const agents = await addressableAgents(req);
      res.json({
        object: 'list',
        data: agents.map(a => ({
          id: a.name,
          object: 'model',
          created: 0,
          owned_by: 'pulsarteam',
          agent_id: a.id,
        })),
      });
    })
  );

  router.post(
    '/v1/chat/completions',
    asyncHandler(async (req, res) => {
      // One line per request, success included: without it a call that never
      // reached the agent cannot be told from one the agent answered.
      const startedAt = Date.now();
      const trace = { model: '', agent: '', stream: false, outcome: 'unknown' };
      try {
        trace.outcome = await completion(req, res, trace);
      } finally {
        console.log(
          `🔌 [LLM API] key=${req.apiKey?.id ?? '?'} model="${trace.model}"` +
            `${trace.agent ? ` agent=${trace.agent}` : ''} stream=${trace.stream}` +
            ` → ${trace.outcome} in ${Date.now() - startedAt}ms`
        );
      }
    })
  );

  /** Serve one chat completion; returns the outcome for the request log. */
  async function completion(
    req: express.Request,
    res: express.Response,
    trace: { model: string; agent: string; stream: boolean }
  ): Promise<string> {
    const parsed = chatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const details = formatZodError(parsed.error).details;
      return sendError(
        res,
        new LlmRequestError(
          400,
          `Invalid request: ${details.map(d => `${d.path}: ${d.message}`).join('; ')}`,
          'invalid_request'
        )
      );
    }
    const body = parsed.data;
    trace.model = body.model;
    trace.stream = !!body.stream;
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    // Opt-in JSON answer; null (free-form) for text, no field or an unknown type.
    let options: CompletionOptions;
    try {
      options = { responseFormat: parseResponseFormat(body.response_format) };
    } catch (err) {
      return sendError(res, err);
    }

    let agent: CompletionAgent;
    try {
      agent = await resolveAgent(req, body.model);
    } catch (err) {
      return sendError(res, err);
    }
    trace.agent = agent.id;

    const clientGone = clientGoneSignal(res);
    if (!body.stream) {
      try {
        const result = await runAgentCompletion(
          agentManager as unknown as CompletionRunner,
          agent,
          body.messages,
          clientGone,
          options
        );
        res.json(chatCompletionBody(body.model, result, id, created));
        return `200 ${result.source}`;
      } catch (err) {
        if (clientGone.aborted) return 'client_closed';
        return sendError(res, err);
      }
    }

    // Streaming: the answer only exists once the file is written, so it is
    // sent as one content chunk. Headers go out first, with SSE comments as
    // keep-alives, so proxies do not cut a long agent turn.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (data: string) => {
      if (!clientGone.aborted) res.write(data);
    };
    const send = (payload: unknown) => write(`data: ${JSON.stringify(payload)}\n\n`);
    const keepAlive = setInterval(() => write(': keep-alive\n\n'), 15_000);
    try {
      send(chatCompletionChunk(body.model, id, created, { role: 'assistant', content: '' }));
      const result = await runAgentCompletion(
        agentManager as unknown as CompletionRunner,
        agent,
        body.messages,
        clientGone,
        options
      );
      send(chatCompletionChunk(body.model, id, created, { content: result.content }));
      send(chatCompletionChunk(body.model, id, created, {}, 'stop'));
      return `200 ${result.source}`;
    } catch (err) {
      if (clientGone.aborted) return 'client_closed';
      const e = asLlmError(err);
      send(e.toJSON());
      return `${e.status} ${e.code} (in stream)`;
    } finally {
      clearInterval(keepAlive);
      write('data: [DONE]\n\n');
      if (!clientGone.aborted) res.end();
    }
  }

  // ── /v1/conversations — Mistral's Conversations API, the subset a client sends ──

  /** Built-in server id of the Web Browser MCP, the one web_search needs. */
  const WEB_BROWSER_SERVER_ID = 'mcp-browser';

  /**
   * Agents in a web_search conversation right now. A second one for the same
   * agent is refused before it starts a capture: startWebCapture would
   * replace — and stop — the running one's.
   */
  const capturingAgents = new Set<string>();

  /** The agent fields the web_search check reads, beyond CompletionAgent. */
  type PluginFields = CompletionAgent & {
    runner?: string;
    skills?: unknown;
    boardId?: string | null;
    mcpServers?: unknown;
  };

  /**
   * MCP server ids the agent may call: agent plugins ∪ board plugins ∪ direct
   * agent.mcpServers — the native dispatch gate (agentManager/tools/handlers.ts).
   */
  async function enabledMcpServerIds(agent: PluginFields): Promise<Set<string>> {
    const ids = new Set<string>();
    const pluginIds = new Set<string>(Array.isArray(agent.skills) ? agent.skills : []);
    if (agent.boardId) {
      try {
        const board = await getBoardById(agent.boardId);
        if (board && Array.isArray(board.plugins)) {
          for (const id of board.plugins) pluginIds.add(id);
        }
      } catch {
        /* board may not exist */
      }
    }
    for (const sid of pluginIds) {
      const plugin = agentManager.skillManager?.getById(sid) as { mcpServerIds?: unknown } | null;
      if (plugin && Array.isArray(plugin.mcpServerIds)) {
        for (const mid of plugin.mcpServerIds) ids.add(mid);
      }
    }
    if (Array.isArray(agent.mcpServers)) for (const mid of agent.mcpServers) ids.add(mid);
    return ids;
  }

  /**
   * Why `agent` cannot serve a web_search conversation; null when it can. A
   * CLI agent browses with its own tools too (WebSearch, WebFetch), which the
   * capture cannot see: the pages listed would be incomplete.
   */
  async function webSearchRefusal(agent: CompletionAgent): Promise<LlmRequestError | null> {
    const fields = agent as PluginFields;
    if (isCliRunner(fields) || agentManager.isTerminalDriven(agent.id)) {
      return new LlmRequestError(
        400,
        `Agent "${agent.name}" runs a CLI, whose own web tools escape the capture of the pages it consults: web_search is not supported for it`,
        'web_search_unsupported_for_agent'
      );
    }
    if (!(await enabledMcpServerIds(fields)).has(WEB_BROWSER_SERVER_ID)) {
      return new LlmRequestError(
        400,
        `Agent "${agent.name}" has no Web Browser MCP server: add the Web Browser plugin to the agent or its board to use web_search`,
        'web_search_unsupported_for_agent'
      );
    }
    return null;
  }

  /** sendError, plus Retry-After on a busy or disabled agent. */
  function sendConversationError(res: express.Response, err: unknown): string {
    const e = asLlmError(err);
    if (e.status === 409 && (e.code === 'agent_busy' || e.code === 'agent_disabled')) {
      res.setHeader('Retry-After', String(CONVERSATION_RETRY_AFTER_S));
    }
    return sendError(res, e);
  }

  router.post(
    '/v1/conversations',
    asyncHandler(async (req, res) => {
      const startedAt = Date.now();
      const trace = { model: '', agent: '', webSearch: false, outcome: 'unknown' };
      try {
        trace.outcome = await conversation(req, res, trace);
      } finally {
        console.log(
          `🔌 [LLM API] conversations key=${req.apiKey?.id ?? '?'} model="${trace.model}"` +
            `${trace.agent ? ` agent=${trace.agent}` : ''} web_search=${trace.webSearch}` +
            ` → ${trace.outcome} in ${Date.now() - startedAt}ms`
        );
      }
    })
  );

  /** Serve one conversation request; returns the outcome for the request log. */
  async function conversation(
    req: express.Request,
    res: express.Response,
    trace: { model: string; agent: string; webSearch: boolean }
  ): Promise<string> {
    const parsed = conversationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const details = formatZodError(parsed.error).details;
      return sendError(
        res,
        new LlmRequestError(
          400,
          `Invalid request: ${details.map(d => `${d.path}: ${d.message}`).join('; ')}`,
          'invalid_request'
        )
      );
    }
    const body = parsed.data;
    trace.model = body.model;
    let webSearch: boolean;
    try {
      ({ webSearch } = conversationFeatures(body));
    } catch (err) {
      return sendError(res, err);
    }
    trace.webSearch = webSearch;

    let agent: CompletionAgent;
    try {
      agent = await resolveAgent(req, body.model);
    } catch (err) {
      return sendError(res, err);
    }
    trace.agent = agent.id;

    // Refused before any turn starts.
    if (webSearch) {
      const refusal = await webSearchRefusal(agent);
      if (refusal) return sendError(res, refusal);
      if (capturingAgents.has(agent.id)) {
        return sendConversationError(
          res,
          new LlmRequestError(409, `Agent "${agent.name}" is busy. Retry later.`, 'agent_busy')
        );
      }
    }

    const conversationId = newConversationId();
    const clientGone = clientGoneSignal(res);
    // Started right before the turn, stopped as soon as the turn settles —
    // the agent may then browse for other work — and in the finally whatever
    // happens.
    const capture = webSearch ? startWebCapture(agent.id) : null;
    if (capture) capturingAgents.add(agent.id);
    try {
      const result = await runAgentCompletion(
        agentManager as unknown as CompletionRunner,
        agent,
        conversationMessages(body),
        clientGone,
        { webSearch, onTurnSettled: capture ? () => capture.stop() : undefined }
      );
      const entries = capture ? toConversationToolEntries(capture.stop()) : [];
      res.json(conversationResponseBody(conversationId, result, entries));
      const pages = entries.reduce((n, e) => n + e.info.result.length, 0);
      return `200 ${result.source}${capture ? ` tools=${entries.length} pages=${pages}` : ''}`;
    } catch (err) {
      if (clientGone.aborted) return 'client_closed';
      return sendConversationError(res, err);
    } finally {
      if (capture) {
        capture.stop();
        capturingAgents.delete(agent.id);
      }
    }
  }

  return router;
}
