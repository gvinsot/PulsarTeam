import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { asyncHandler } from '../lib/asyncHandler.js';
import { checkAgentAccess } from '../lib/agentAccess.js';
import { getUserBoardIdSet } from '../lib/boardAccess.js';
import { formatZodError } from '../lib/validate.js';
import { errorMessage } from '../lib/errors.js';
import type { AgentManager } from '../services/agentManager/index.js';
import {
  LLM_KEY_RATE_LIMIT_PER_MINUTE,
  LlmRequestError,
  chatCompletionBody,
  chatCompletionChunk,
  chatCompletionRequestSchema,
  runAgentCompletion,
  type CompletionAgent,
  type CompletionRunner,
} from '../services/llmCompletion.js';

/**
 * /api/llm/v1 — an OpenAI-compatible endpoint answered by an agent.
 *
 *   GET  /api/llm/v1/models            — the agents the key may address
 *   POST /api/llm/v1/chat/completions  — one agent turn, OpenAI-shaped answer
 *
 * Mounted behind `requireApiKeyScope('llm')` (src/index.ts), which resolves
 * the key's owner live. `model` names the agent (name or id); it must be one
 * the owner can EDIT — the level POST /api/agents/:id/chat demands — and that
 * is re-checked on every request, so unsharing a board stops the key there.
 *
 * Point any OpenAI SDK at `<origin>/api/llm/v1` with the key as `api_key`.
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

  function sendError(res: express.Response, err: unknown) {
    const e =
      err instanceof LlmRequestError
        ? err
        : new LlmRequestError(500, errorMessage(err) || 'Internal error', 'internal_error');
    if (!(err instanceof LlmRequestError)) console.error('LLM API error:', errorMessage(err));
    res.status(e.status).json(e.toJSON());
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
      const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
      const created = Math.floor(Date.now() / 1000);

      let agent: CompletionAgent;
      try {
        agent = await resolveAgent(req, body.model);
      } catch (err) {
        return sendError(res, err);
      }

      if (!body.stream) {
        try {
          const result = await runAgentCompletion(
            agentManager as unknown as CompletionRunner,
            agent,
            body.messages
          );
          return res.json(chatCompletionBody(body.model, result, id, created));
        } catch (err) {
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
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      try {
        send(chatCompletionChunk(body.model, id, created, { role: 'assistant', content: '' }));
        const result = await runAgentCompletion(
          agentManager as unknown as CompletionRunner,
          agent,
          body.messages
        );
        send(chatCompletionChunk(body.model, id, created, { content: result.content }));
        send(chatCompletionChunk(body.model, id, created, {}, 'stop'));
      } catch (err) {
        const e =
          err instanceof LlmRequestError
            ? err
            : new LlmRequestError(500, errorMessage(err), 'internal_error');
        send(e.toJSON());
      } finally {
        clearInterval(keepAlive);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    })
  );

  return router;
}
