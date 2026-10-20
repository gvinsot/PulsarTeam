// ── OpenAI-compatible completions answered by an agent ──────────────────────
//
// /api/llm/v1/chat/completions (routes/llmApi.ts) lets another service talk to
// one of the key owner's agents as if it were a plain LLM endpoint. The
// request is the classic OpenAI chat-completions body; `model` names the agent
// (its name or id).
//
// An agent's chat reply mixes prose, tool progress and status lines, so it is
// not a clean "completion". The agent is therefore asked to write its FINAL
// answer, and nothing else, into a file of its workspace; that file's content
// is the completion. When the file is missing or empty (a model that ignored
// the instruction, a runner that could not be reached) the agent's chat reply
// is used instead, so the caller still gets an answer.

import crypto from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../lib/errors.js';

/** Calls an `llm` key may make per minute — each one is a full agent turn. */
export const LLM_KEY_RATE_LIMIT_PER_MINUTE = 20;

/** Ceiling on the prompt the conversation is flattened into. */
export const LLM_MAX_PROMPT_CHARS = 200_000;

/** Directory of the agent's workspace the answer files are written to. */
export const LLM_ANSWER_DIR = '/tmp/pulsar-llm-api';

// ── Request ─────────────────────────────────────────────────────────────────

const textPartSchema = z.object({ type: z.literal('text'), text: z.string() });
const imagePartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.union([z.string(), z.object({ url: z.string(), detail: z.string().optional() })]),
});
// Unknown part types (input_audio, file…) are accepted and ignored.
const otherPartSchema = z.looseObject({ type: z.string() });

const contentSchema = z.union([
  z.string(),
  z.array(z.union([textPartSchema, imagePartSchema, otherPartSchema])),
  z.null(),
]);

const messageSchema = z.looseObject({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: contentSchema.optional(),
  name: z.string().optional(),
});

/**
 * The OpenAI chat-completions body. Sampling parameters (temperature, top_p,
 * max_tokens…) are accepted for compatibility and ignored: the agent's own
 * LLM configuration decides them.
 */
export const chatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1).max(200).describe('Name or id of the agent that answers.'),
  messages: z.array(messageSchema).min(1).max(500),
  stream: z.boolean().optional().describe('`true` returns the answer as server-sent events.'),
  user: z.string().max(200).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
type ChatMessage = ChatCompletionRequest['messages'][number];

/** An image handed to `sendMessage`, as the chat UI does. */
export interface PromptImage {
  mediaType: string;
  data: string;
}

/** Text of one message's content; images are collected into `images`. */
function contentText(content: ChatMessage['content'], images: PromptImage[]): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
      texts.push((part as { text: string }).text);
    } else if (part.type === 'image_url') {
      const ref = (part as { image_url: string | { url: string } }).image_url;
      const url = typeof ref === 'string' ? ref : ref?.url;
      // Inline images only: fetching a caller-chosen URL from the server is an
      // SSRF primitive, and the agent has a browser if it needs the web.
      const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s.exec(url || '');
      if (m) images.push({ mediaType: m[1], data: m[2] });
      else if (url) texts.push(`[image: ${url}]`);
    }
  }
  return texts.join('\n');
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  system: 'System',
  developer: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool result',
  function: 'Tool result',
};

/**
 * Flatten an OpenAI conversation into the one message an agent receives, plus
 * the instruction to write the final answer to `answerPath`.
 *
 * A single user message is passed as-is (the common case reads naturally);
 * anything longer is rendered as a labelled transcript ending on the turn to
 * answer.
 */
export function buildAgentPrompt(
  messages: ChatMessage[],
  answerPath: string
): { prompt: string; images: PromptImage[] } {
  const images: PromptImage[] = [];
  const rendered = messages.map(m => ({ role: m.role, text: contentText(m.content, images) }));

  const system = rendered.filter(m => m.role === 'system' || m.role === 'developer');
  const turns = rendered.filter(m => m.role !== 'system' && m.role !== 'developer');

  const parts: string[] = [
    'You are answering a request received through the OpenAI-compatible API of PulsarTeam.',
  ];
  if (system.length) {
    parts.push(`Instructions from the caller:\n${system.map(m => m.text).join('\n\n')}`);
  }
  if (turns.length === 1 && turns[0].role === 'user') {
    parts.push(`Request:\n${turns[0].text}`);
  } else {
    const transcript = turns.map(m => `### ${ROLE_LABEL[m.role]}\n${m.text}`).join('\n\n');
    parts.push(`Conversation so far (answer the last message as the Assistant):\n\n${transcript}`);
  }
  parts.push(
    [
      'IMPORTANT — how to deliver your answer:',
      `Write your complete final answer, and nothing else, to the file \`${answerPath}\` (create the parent directory if needed; overwrite the file if it exists).`,
      'The content of that file is returned verbatim to the caller as the assistant message: no preamble, no notes about the file, no commentary about your process.',
      'Do not commit that file. Once it is written, reply briefly that you are done.',
    ].join('\n')
  );

  let prompt = parts.join('\n\n');
  if (prompt.length > LLM_MAX_PROMPT_CHARS) {
    throw new LlmRequestError(
      400,
      `Conversation too long (${prompt.length} characters, max ${LLM_MAX_PROMPT_CHARS})`,
      'context_length_exceeded'
    );
  }
  prompt = prompt.trim();
  return { prompt, images };
}

// ── Errors, OpenAI-shaped ───────────────────────────────────────────────────

/** An error answered as `{ error: { message, type, code } }`, like OpenAI does. */
export class LlmRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null
  ) {
    super(message);
  }

  get type(): string {
    if (this.status === 400 || this.status === 404) return 'invalid_request_error';
    if (this.status === 401 || this.status === 403) return 'permission_error';
    if (this.status === 409 || this.status === 429) return 'rate_limit_error';
    return 'server_error';
  }

  toJSON() {
    return { error: { message: this.message, type: this.type, param: null, code: this.code } };
  }
}

// ── Running the agent ───────────────────────────────────────────────────────

/** The agent fields this module reads. */
export interface CompletionAgent {
  id: string;
  name: string;
  status?: string;
  enabled?: boolean;
}

/** What the completion needs from AgentManager — a seam for tests. */
export interface CompletionRunner {
  sendMessage(
    id: string,
    message: string,
    streamCallback: (chunk: string) => void,
    delegationDepth?: number,
    messageMeta?: unknown,
    images?: PromptImage[] | null
  ): Promise<unknown>;
  /** End the agent's running chat turn; false when none has started yet. */
  abortChatTurn(id: string, reason?: string): boolean;
  /** The live stream the chat UI renders — what the socket chat feeds too. */
  beginStream(agentId: string, opts?: { userMessage?: string | null }): void;
  appendStreamChunk(agentId: string, chunk: string): void;
  endStream(agentId: string): void;
  errorStream(agentId: string, error: string): void;
  executionManager?: {
    readFile(agentId: string, filePath: string): Promise<string>;
    exec(
      agentId: string,
      command: string,
      options?: { timeout?: number }
    ): Promise<{ stdout: string; stderr: string }>;
  } | null;
}

/** Rough token count (≈4 characters per token) for the `usage` block. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** Strip the reasoning blocks some models leave in their reply. */
function cleanReply(reply: unknown): string {
  const text =
    typeof reply === 'string'
      ? reply
      : reply && typeof (reply as { content?: unknown }).content === 'string'
        ? (reply as { content: string }).content
        : '';
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

export interface CompletionResult {
  content: string;
  /** Where the content came from: the answer file, or the chat reply fallback. */
  source: 'file' | 'reply';
  promptTokens: number;
}

/** How often a client hang-up retries the abort until the turn has started. */
const ABORT_RETRY_MS = 500;

/**
 * Run one agent turn for an OpenAI chat request and return the answer.
 * Refuses (409) an agent that is already working: it would otherwise inject
 * the request into whatever the agent is doing.
 *
 * `signal` is the caller's connection: when it aborts, the turn is ended so
 * the agent does not stay busy — and answer 409 — for a reply nobody reads.
 */
export async function runAgentCompletion(
  runner: CompletionRunner,
  agent: CompletionAgent,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<CompletionResult> {
  const clientClosed = () =>
    new LlmRequestError(499, 'The client closed the request', 'client_closed');
  if (signal?.aborted) throw clientClosed();

  if (agent.enabled === false) {
    throw new LlmRequestError(409, `Agent "${agent.name}" is disabled`, 'agent_disabled');
  }
  if (agent.status && agent.status !== 'idle' && agent.status !== 'error') {
    throw new LlmRequestError(
      409,
      `Agent "${agent.name}" is busy (${agent.status}). Retry later.`,
      'agent_busy'
    );
  }

  const answerPath = `${LLM_ANSWER_DIR}/${crypto.randomUUID()}.md`;
  const { prompt, images } = buildAgentPrompt(messages, answerPath);

  const exec = runner.executionManager;
  // Best-effort cleanup; never fails the request.
  const removeAnswerFile = () =>
    exec?.exec(agent.id, `rm -f '${answerPath}'`, { timeout: 10_000 }).catch(() => {});

  // Only this turn is aborted, and only while it runs: once sendMessage has
  // settled the agent may already be on other work. sendMessage registers its
  // abort controller after a possible project-switch wait, so a hang-up
  // landing before that retries until the turn is there to abort.
  let turnRunning = true;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const abortTurn = () => {
    retryTimer = null;
    if (!turnRunning) return;
    if (!runner.abortChatTurn(agent.id, 'LLM API client disconnected')) {
      retryTimer = setTimeout(abortTurn, ABORT_RETRY_MS);
    }
  };
  signal?.addEventListener('abort', abortTurn, { once: true });

  // The turn streams into the agent's chat in the UI, like a socket chat, so
  // the request is seen being worked on. Opened on the first chunk, not
  // before: a sendMessage refused because another turn holds the agent must
  // not replace — then close — that turn's stream.
  let streaming = false;
  const onChunk = (chunk: string) => {
    if (!streaming) {
      streaming = true;
      runner.beginStream(agent.id, { userMessage: prompt });
    }
    runner.appendStreamChunk(agent.id, chunk);
  };

  let reply: unknown;
  try {
    reply = await runner.sendMessage(
      agent.id,
      prompt,
      onChunk,
      0,
      null,
      images.length ? images : null
    );
    if (streaming) runner.endStream(agent.id);
  } catch (err) {
    if (streaming) runner.errorStream(agent.id, errorMessage(err));
    if (signal?.aborted) {
      removeAnswerFile();
      throw clientClosed();
    }
    const msg = errorMessage(err);
    if (/already processing/i.test(msg)) {
      throw new LlmRequestError(409, `Agent "${agent.name}" is busy. Retry later.`, 'agent_busy');
    }
    throw new LlmRequestError(502, `Agent "${agent.name}" failed: ${msg}`, 'agent_error');
  } finally {
    turnRunning = false;
    if (retryTimer) clearTimeout(retryTimer);
    signal?.removeEventListener('abort', abortTurn);
  }

  if (signal?.aborted) {
    removeAnswerFile();
    throw clientClosed();
  }

  let fileContent = '';
  if (exec) {
    try {
      fileContent = await exec.readFile(agent.id, answerPath);
    } catch {
      // No file: fall back to the reply below.
    }
    removeAnswerFile();
  }

  const fromFile = fileContent.replace(/\s+$/, '');
  if (fromFile.trim()) {
    return { content: fromFile, source: 'file', promptTokens: estimateTokens(prompt) };
  }
  const fromReply = cleanReply(reply);
  if (!fromReply) {
    throw new LlmRequestError(502, `Agent "${agent.name}" returned no answer`, 'empty_answer');
  }
  return { content: fromReply, source: 'reply', promptTokens: estimateTokens(prompt) };
}

// ── Response shapes ─────────────────────────────────────────────────────────

/** `chat.completion` object, OpenAI's non-streaming answer. */
export function chatCompletionBody(
  model: string,
  result: CompletionResult,
  id: string,
  created: number
) {
  const completionTokens = estimateTokens(result.content);
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content, refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: result.promptTokens,
      completion_tokens: completionTokens,
      total_tokens: result.promptTokens + completionTokens,
    },
  };
}

/** One `chat.completion.chunk` server-sent event payload. */
export function chatCompletionChunk(
  model: string,
  id: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}
