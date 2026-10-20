// ── Mistral-compatible conversations answered by an agent ───────────────────
//
// /api/llm/v1/conversations (routes/llmApi.ts) is the subset of Mistral's
// Conversations API a Mistral client sends: `instructions` + `inputs`, and
// optionally the built-in `web_search` tool. The turn itself is the one of
// /v1/chat/completions (runAgentCompletion: the answer file, else the chat
// reply); only the request and the response are shaped differently.
//
// With web_search, the pages listed in the answer are captured server-side
// from the agent's Web Browser tool calls (services/webCapture.ts) — never
// read from what the agent wrote.

import crypto from 'node:crypto';
import { z } from 'zod';
import {
  LlmRequestError,
  estimateTokens,
  type ChatCompletionRequest,
  type CompletionResult,
} from './llmCompletion.js';
import type { ConversationToolEntry } from './webCapture.js';

type ChatMessage = ChatCompletionRequest['messages'][number];

/** The one built-in tool this API knows. */
export const WEB_SEARCH_TOOL = 'web_search';

/** Seconds a client is told to wait (Retry-After) when the agent is busy or disabled. */
export const CONVERSATION_RETRY_AFTER_S = 30;

// ── Request ─────────────────────────────────────────────────────────────────

// Content parts are read like chat-completions ones (text, image_url); other
// chunk types are accepted and ignored.
const inputContentSchema = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string() })),
  z.null(),
]);

/** One entry of `inputs` — Mistral's `message.input` (object/type optional). */
const inputEntrySchema = z.looseObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: inputContentSchema.optional(),
});

/**
 * A role-less entry — `tool.execution`, `function.call`… — as a stateless
 * client replays the previous `outputs`: accepted and skipped.
 */
const otherEntrySchema = z.looseObject({ type: z.string(), role: z.never().optional() });

/**
 * The Mistral conversation body. `completion_args` and `store` are accepted
 * for compatibility and ignored: the agent's own LLM configuration decides
 * the sampling, and nothing is persisted (every request is a new
 * conversation).
 */
export const conversationRequestSchema = z.looseObject({
  model: z.string().min(1).max(200).describe('Name or id of the agent that answers.'),
  instructions: z
    .string()
    .nullable()
    .optional()
    .describe('System instructions, passed to the agent like a system message.'),
  inputs: z
    .union([
      z.string().min(1),
      z
        .array(z.union([inputEntrySchema, otherEntrySchema]))
        .min(1)
        .max(500)
        .refine(entries => entries.some(e => e.role !== undefined), {
          message: 'At least one entry needs a role',
        }),
    ])
    .describe(
      'The user message, or the conversation as `{ role, content }` entries (role-less entries such as `tool.execution` are skipped).'
    ),
  tools: z
    .array(z.looseObject({ type: z.string() }))
    .max(32)
    .nullable()
    .optional()
    .describe('Only `{ "type": "web_search" }` is supported.'),
  completion_args: z.unknown().optional().describe('Accepted and ignored.'),
  store: z.unknown().optional().describe('Accepted and ignored: nothing is stored.'),
  stream: z.boolean().optional().describe('Only `false` is supported.'),
});

export type ConversationRequest = z.infer<typeof conversationRequestSchema>;

/**
 * What the request asks beyond a plain turn: whether it wants web_search.
 * Throws 400 on what this API does not serve — streaming, or a tool other
 * than web_search.
 */
export function conversationFeatures(body: ConversationRequest): { webSearch: boolean } {
  if (body.stream === true) {
    throw new LlmRequestError(
      400,
      'stream: true is not supported on /v1/conversations — send stream: false',
      'stream_not_supported'
    );
  }
  const tools = body.tools || [];
  const unsupported = tools.find(t => t.type !== WEB_SEARCH_TOOL);
  if (unsupported) {
    throw new LlmRequestError(
      400,
      `The tool type "${unsupported.type}" is not supported — only "${WEB_SEARCH_TOOL}" is`,
      'tool_not_supported'
    );
  }
  return { webSearch: tools.length > 0 };
}

/**
 * The conversation as chat messages: `instructions` as a system message, a
 * string `inputs` as one user message, a list as its messages (role-less
 * entries skipped).
 */
export function conversationMessages(body: ConversationRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  if (typeof body.inputs === 'string') {
    messages.push({ role: 'user', content: body.inputs });
  } else {
    for (const entry of body.inputs) {
      if (entry.role === undefined) continue;
      const { role, content } = entry as z.infer<typeof inputEntrySchema>;
      messages.push({ role, content: content ?? null });
    }
  }
  return messages;
}

// ── Response ────────────────────────────────────────────────────────────────

/** A fresh conversation id — nothing is stored, so never reused. */
export function newConversationId(): string {
  return `conv_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * The `conversation.response` object: the web tool executions first (empty
 * without web_search), then the answer as the `message.output` entry.
 */
export function conversationResponseBody(
  conversationId: string,
  result: CompletionResult,
  toolEntries: ConversationToolEntry[]
) {
  const completionTokens = estimateTokens(result.content);
  return {
    object: 'conversation.response',
    conversation_id: conversationId,
    outputs: [
      ...toolEntries,
      {
        object: 'entry',
        type: 'message.output',
        role: 'assistant',
        content: result.content,
      },
    ],
    usage: {
      prompt_tokens: result.promptTokens,
      completion_tokens: completionTokens,
      total_tokens: result.promptTokens + completionTokens,
    },
  };
}
