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
import vm from 'node:vm';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { errorMessage } from '../lib/errors.js';
import { closeLlmAnswer, llmAnswerFile, openLlmAnswer, takeLlmAnswer } from './llmAnswers.js';

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
  // Read leniently by parseResponseFormat: a value it does not know is
  // ignored, as before the field was read — never a 400 here.
  response_format: z
    .unknown()
    .optional()
    .describe('`json_object` or `json_schema`: the answer is a JSON document.'),
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

/** How the agent hands its answer back: a file it writes, or a tool it calls. */
export type AnswerDelivery = { file: string } | { requestId: string };

const FORMAT_RULE =
  'Give it in exactly the format the request asks for (plain text, Markdown, JSON, TOML, code…): when a raw format is asked for, give it raw — no Markdown code fence around it.';

/**
 * What a conversation with the web_search tool adds before the delivery part:
 * the pages it reports are the ones the agent's Web Browser calls return.
 */
const WEB_SEARCH_RULE =
  'Search the web to answer this request: use the search_web tool of your Web Browser MCP server, read the relevant pages among its results with its crawl tool, and base your answer on the pages you consulted.';

/** The rule a `response_format` asking for JSON adds after FORMAT_RULE. */
function jsonFormatRules(format: JsonOutputFormat | null): string[] {
  if (!format) return [];
  const bare = 'with no text before or after it and no Markdown code block around it';
  if (format.schema === null) return [`Your final answer is ONLY a JSON object, ${bare}.`];
  return [
    `Your final answer is ONLY a JSON document conforming to the following JSON schema, ${bare}:`,
    JSON.stringify(format.schema),
  ];
}

function deliveryInstructions(
  delivery: AnswerDelivery,
  format: JsonOutputFormat | null = null
): string {
  if ('requestId' in delivery) {
    return [
      'IMPORTANT — how to deliver your answer:',
      `1. Write your complete final answer, and nothing else, to the file \`${llmAnswerFile(delivery.requestId)}\` (create the parent directory if needed).`,
      `2. Call the \`submit_answer\` tool of the Pulsar Gateway MCP with request_id "${delivery.requestId}" and that file as \`file_path\`.`,
      'The content of that file is returned verbatim to the caller as the assistant message: no preamble, no commentary about your process.',
      FORMAT_RULE,
      ...jsonFormatRules(format),
      'Calling submit_answer is what completes the request — without it the caller gets no answer. If it reports an error, fix it and call it again. Then reply briefly that you are done.',
    ].join('\n');
  }
  return [
    'IMPORTANT — how to deliver your answer:',
    `Write your complete final answer, and nothing else, to the file \`${delivery.file}\` (create the parent directory if needed; overwrite the file if it exists).`,
    'The content of that file is returned verbatim to the caller as the assistant message: no preamble, no notes about the file, no commentary about your process.',
    FORMAT_RULE,
    ...jsonFormatRules(format),
    'Do not commit that file. Once it is written, reply briefly that you are done.',
  ].join('\n');
}

/**
 * Flatten an OpenAI conversation into the one message an agent receives, plus
 * the instruction on how to deliver the final answer.
 *
 * A single user message is passed as-is (the common case reads naturally);
 * anything longer is rendered as a labelled transcript ending on the turn to
 * answer. `format` (response_format) adds the JSON rule to the delivery part;
 * without it the prompt is exactly the free-form one. `webSearch` (a
 * conversation with the web_search tool) adds WEB_SEARCH_RULE before it.
 */
export function buildAgentPrompt(
  messages: ChatMessage[],
  delivery: AnswerDelivery,
  format: JsonOutputFormat | null = null,
  webSearch = false
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
  if (webSearch) parts.push(WEB_SEARCH_RULE);
  parts.push(deliveryInstructions(delivery, format));

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

// ── Structured output (response_format) ────────────────────────────────────
//
// `response_format: { type: 'json_object' }` or `{ type: 'json_schema',
// json_schema: { name, schema, strict } }` asks for a JSON answer. The agent
// is told so in its prompt, and its answer is checked after the turn: code
// fence stripped, parsed, validated against the schema. A wrong one is handed
// back to the agent once, quoting the error; still wrong → 502
// invalid_json_output. `text`, no field, or a type not known here: the
// free-form answer, prompt and result unchanged.
//
// The schema is the caller's, and its `pattern`s run on V8's backtracking
// regex engine against an answer the caller can steer: compiling and
// validating run under a time limit (runBounded), so a pathological schema or
// pattern costs a bounded slice of the event loop, never minutes of it.

/** The JSON answer a request asked for with `response_format`. */
export interface JsonOutputFormat {
  /** The JSON schema the answer conforms to (json_schema), or null (json_object). */
  schema: Record<string, unknown> | boolean | null;
  /** json_schema.strict: an answer off the schema is refused, not returned. */
  strict: boolean;
  /** `schema` compiled; null without one. */
  validate: ValidateFunction | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Longest response_format JSON schema accepted, serialized. */
const MAX_JSON_SCHEMA_CHARS = 64_000;

/** Time limits of compiling a schema and of validating one answer against it. */
const SCHEMA_COMPILE_TIMEOUT_MS = 1000;
const SCHEMA_VALIDATE_TIMEOUT_MS = 250;

const boundedContext = vm.createContext({});
const boundedCall = new vm.Script('run()');

/**
 * `fn()`, interrupted after `timeoutMs` — V8 terminates the execution, a
 * backtracking regex included — with an ERR_SCRIPT_EXECUTION_TIMEOUT error.
 */
function runBounded<T>(fn: () => T, timeoutMs: number): T {
  boundedContext.run = fn;
  try {
    return boundedCall.runInContext(boundedContext, { timeout: timeoutMs }) as T;
  } finally {
    boundedContext.run = undefined;
  }
}

function isTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

/**
 * The JSON answer `response_format` asks for, or null for a free-form one:
 * `text`, absent, or anything this API does not know — ignored, as before the
 * field was read. A json_schema without a schema is a json_object. Throws
 * 400 on a schema that does not compile: better than a turn that cannot be
 * checked.
 */
export function parseResponseFormat(raw: unknown): JsonOutputFormat | null {
  if (!isPlainObject(raw)) return null;
  if (raw.type === 'json_object') return { schema: null, strict: false, validate: null };
  if (raw.type !== 'json_schema') return null;
  const spec = isPlainObject(raw.json_schema) ? raw.json_schema : {};
  const strict = spec.strict === true;
  if (spec.schema == null) return { schema: null, strict, validate: null };

  const invalid = (why: string) =>
    new LlmRequestError(
      400,
      `Invalid response_format.json_schema.schema: ${why}`,
      'invalid_request'
    );
  if (!isPlainObject(spec.schema) && typeof spec.schema !== 'boolean') {
    throw invalid('not a JSON schema');
  }
  if (JSON.stringify(spec.schema).length > MAX_JSON_SCHEMA_CHARS) {
    throw invalid(`longer than ${MAX_JSON_SCHEMA_CHARS} characters`);
  }
  // The dialect marker is dropped: callers send draft-07 as often as
  // 2020-12, and the keywords they use are read alike. A fresh Ajv per
  // request: its cache never grows, and a schema `$id` cannot collide.
  const compiled = isPlainObject(spec.schema) ? { ...spec.schema } : spec.schema;
  if (isPlainObject(compiled)) delete compiled.$schema;
  let validate: ValidateFunction;
  try {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    validate = runBounded(() => ajv.compile(compiled), SCHEMA_COMPILE_TIMEOUT_MS);
  } catch (err) {
    throw invalid(isTimeout(err) ? 'too complex to compile' : errorMessage(err));
  }
  // An $async schema validates through a promise, out of the time limit.
  if ((validate as { $async?: unknown }).$async) {
    throw invalid('$async schemas are not supported');
  }
  return { schema: spec.schema, strict, validate };
}

/**
 * The answer without the code fence (```json … ```) wrapping it whole. No
 * regex over the whole answer: the text is the agent's, steerable by the
 * caller, and a backtracking one would block the event loop.
 */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length < 6 || !trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return trimmed;
  }
  const inner = trimmed.slice(3, -3);
  // The info string (json, ts…): one anchored character class, linear.
  const info = /^[\w.+-]*/.exec(inner)?.[0] ?? '';
  return inner.slice(info.length).trim();
}

/** Longest error quoted back to the agent or the caller. */
const MAX_JSON_ERROR_CHARS = 2000;

export interface JsonOutputCheck {
  /** The answer, code fence stripped — what is returned. */
  text: string;
  /** Why it is not the JSON asked for; null when it is. */
  error: string | null;
  /** It is JSON, only off the schema. */
  offSchema: boolean;
}

/** Check an answer against the JSON `format` asked for. */
export function checkJsonOutput(content: string, format: JsonOutputFormat): JsonOutputCheck {
  const text = stripCodeFence(content);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { text, error: `it is not valid JSON (${errorMessage(err)})`, offSchema: false };
  }
  if (format.schema === null && !isPlainObject(value)) {
    return { text, error: 'it is not a JSON object', offSchema: false };
  }
  const validate = format.validate;
  let valid = true;
  try {
    valid = !validate || runBounded(() => validate(value) === true, SCHEMA_VALIDATE_TIMEOUT_MS);
  } catch (err) {
    if (!isTimeout(err)) throw err;
    return {
      text,
      error: `it could not be checked against the JSON schema within ${SCHEMA_VALIDATE_TIMEOUT_MS} ms`,
      offSchema: true,
    };
  }
  if (validate && !valid) {
    const errors = (validate.errors || [])
      .map(e => `${e.instancePath || '/'} ${e.message || 'is invalid'}`)
      .join('; ');
    return {
      text,
      error: `it does not conform to the JSON schema: ${errors}`.slice(0, MAX_JSON_ERROR_CHARS),
      offSchema: true,
    };
  }
  return { text, error: null, offSchema: false };
}

/**
 * The follow-up turn handing a wrong answer back to the agent, quoting the
 * error, with the same delivery and JSON rules as the first turn.
 */
export function buildCorrectionPrompt(
  error: string,
  delivery: AnswerDelivery,
  format: JsonOutputFormat
): string {
  return [
    `Your answer to the request received through the OpenAI-compatible API of PulsarTeam was rejected: ${error.slice(0, MAX_JSON_ERROR_CHARS)}`,
    'Give the corrected final answer.',
    deliveryInstructions(delivery, format),
  ].join('\n\n');
}

/**
 * Hold the answer of a turn to the JSON `format`: a wrong one gets ONE
 * correction turn (`retry`, in the same mode as the first), then 502
 * invalid_json_output. A non-strict schema only steers: JSON off the schema
 * is returned rather than refused.
 */
async function checkedJsonOutput(
  agent: CompletionAgent,
  first: CompletionResult,
  format: JsonOutputFormat,
  retry: (error: string) => Promise<CompletionResult>
): Promise<CompletionResult> {
  const firstCheck = checkJsonOutput(first.content, format);
  if (!firstCheck.error) return { ...first, content: firstCheck.text };
  const accepted = (check: JsonOutputCheck) => !check.error || (check.offSchema && !format.strict);
  const refuse = (error: string) =>
    new LlmRequestError(
      502,
      `Agent "${agent.name}" did not answer the JSON asked for by response_format: ${error}`,
      'invalid_json_output'
    );

  let second: CompletionResult;
  try {
    second = await retry(firstCheck.error);
  } catch (err) {
    // A correction turn that gives no answer (none, busy, stopped, timed
    // out, failed) leaves the first one standing; only a hang-up ends it all.
    if (err instanceof LlmRequestError && err.code !== 'client_closed') {
      if (accepted(firstCheck)) return { ...first, content: firstCheck.text };
      throw refuse(firstCheck.error);
    }
    throw err;
  }
  const secondCheck = checkJsonOutput(second.content, format);
  if (accepted(secondCheck)) {
    return {
      ...second,
      content: secondCheck.text,
      promptTokens: first.promptTokens + second.promptTokens,
    };
  }
  if (accepted(firstCheck)) return { ...first, content: firstCheck.text };
  throw refuse(secondCheck.error || firstCheck.error);
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
  /** The terminal turn of a CLI agent — see runTerminalCompletion. */
  isTerminalDriven(id: string): boolean;
  startCliTurn(id: string, prompt: string, label: string): Promise<void>;
  isCliTurnActive(id: string, prompt: string): boolean;
  endCliTurn(id: string, prompt: string, opts?: { interrupt?: boolean }): void;
  _checkTerminalAuthError(id: string): Promise<string | null>;
  _isCliQuiet(id: string): Promise<boolean>;
  addActionLog(id: string, type: string, message: string, detail?: string | null): void;
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
  /** Where the content came from: submit_answer (terminal turn), the answer
   * file, or the chat reply fallback (chat path). */
  source: 'tool' | 'file' | 'reply';
  promptTokens: number;
}

/** How often a client hang-up retries the abort until the turn has started. */
const ABORT_RETRY_MS = 500;

/** Longest a terminal turn may take — it can include a /login done by hand. */
export const LLM_TERMINAL_TIMEOUT_MS = (() => {
  const n = Number(process.env.LLM_API_TERMINAL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
})();

/**
 * A CLI quiet this long without having submitted its answer has finished its
 * turn without it — the delay after which the agent itself goes idle again
 * (cliActivity.CLI_ACTIVITY_IDLE_MS).
 */
export const LLM_TERMINAL_QUIET_MS = (() => {
  const n = Number(process.env.LLM_API_TERMINAL_QUIET_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

/** Poll interval of a terminal turn (answer submitted? CLI quiet?). */
const TERMINAL_POLL_MS = 1000;

/** Tunables of a terminal turn, overridden by tests, and the answer format. */
export interface CompletionOptions {
  pollMs?: number;
  timeoutMs?: number;
  quietMs?: number;
  /** The JSON answer response_format asks for (parseResponseFormat); null: free-form. */
  responseFormat?: JsonOutputFormat | null;
  /** Tell the agent to search the web (a conversation with the web_search tool). */
  webSearch?: boolean;
  /**
   * Called each time an agent turn has settled — chat: sendMessage returned
   * or threw; terminal: the turn ended — before the answer is read. The agent
   * may take other work from there on (the web_search capture stops).
   */
  onTurnSettled?: () => void;
}

/**
 * How long a correction turn waits, past the CLI's quiet delay, for the agent
 * to take a new terminal turn: it stays busy until its CLI-activity idle
 * timer fires after the first one.
 */
const CORRECTION_START_GRACE_MS = 60_000;

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Whether the conversation carries inline images (only the chat path takes them). */
function hasInlineImages(messages: ChatMessage[]): boolean {
  const images: PromptImage[] = [];
  for (const m of messages) contentText(m.content, images);
  return images.length > 0;
}

/**
 * A CLI agent's turn, run in its SHARED terminal — the one the UI shows — the
 * way the workflow runs its tasks, instead of a headless CLI nobody sees. The
 * user watches the request being worked on and can step in: run /login when
 * the CLI is not authenticated, answer a question it asks.
 *
 * The agent delivers its answer by calling the Pulsar Gateway's
 * `submit_answer` tool with the request id (services/llmAnswers.ts): that call
 * is the answer and the end of the turn. No file to share: the file-based
 * first version answered "no answer" to an agent that had written its file —
 * the CLI and the API's read did not see the same /tmp.
 *
 * A CLI quiet for LLM_TERMINAL_QUIET_MS without having submitted has finished
 * its turn without it (502 no_answer — the runner never hands back terminal
 * text). Except after an authentication error: the CLI is then quiet because
 * it waits for the user to log in, so the turn keeps waiting. The caller
 * hanging up, a Stop, or the timeout end it too.
 *
 * A JSON answer (response_format) that is wrong gets one correction turn, a
 * new terminal turn with a new request id.
 */
async function runTerminalCompletion(
  runner: CompletionRunner,
  agent: CompletionAgent,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  opts: CompletionOptions
): Promise<CompletionResult> {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const asked = contentText(lastUser?.content, []).replace(/\s+/g, ' ').trim();
  const label = `[LLM API] ${asked}`.slice(0, 200);
  const format = opts.responseFormat ?? null;

  const first = await runTerminalTurn(
    runner,
    agent,
    label,
    signal,
    opts,
    requestId => buildAgentPrompt(messages, { requestId }, format, opts.webSearch === true).prompt
  );
  if (!format) return first;
  return checkedJsonOutput(agent, first, format, error =>
    runTerminalTurn(
      runner,
      agent,
      label,
      signal,
      opts,
      requestId => buildCorrectionPrompt(error, { requestId }, format),
      true
    )
  );
}

/**
 * One terminal turn: `makePrompt` builds the prompt for the request id it is
 * given. `afterTurn` (a correction) waits for the agent to be free again
 * instead of answering 409 at once.
 */
async function runTerminalTurn(
  runner: CompletionRunner,
  agent: CompletionAgent,
  label: string,
  signal: AbortSignal | undefined,
  opts: CompletionOptions,
  makePrompt: (requestId: string) => string,
  afterTurn = false
): Promise<CompletionResult> {
  const clientClosed = () =>
    new LlmRequestError(499, 'The client closed the request', 'client_closed');
  if (signal?.aborted) throw clientClosed();
  const requestId = openLlmAnswer(agent.id);
  try {
    const prompt = makePrompt(requestId);
    const pollMs = opts.pollMs ?? TERMINAL_POLL_MS;
    const quietMs = opts.quietMs ?? LLM_TERMINAL_QUIET_MS;
    const timeoutMs = opts.timeoutMs ?? LLM_TERMINAL_TIMEOUT_MS;

    const startBy = afterTurn
      ? Date.now() + Math.min(timeoutMs, quietMs + CORRECTION_START_GRACE_MS)
      : 0;
    for (;;) {
      try {
        await runner.startCliTurn(agent.id, prompt, label);
        break;
      } catch (err) {
        const msg = errorMessage(err);
        if (/already processing/i.test(msg)) {
          if (Date.now() < startBy) {
            await pause(pollMs, signal);
            if (signal?.aborted) throw clientClosed();
            continue;
          }
          throw new LlmRequestError(
            409,
            `Agent "${agent.name}" is busy. Retry later.`,
            'agent_busy'
          );
        }
        throw new LlmRequestError(502, `Agent "${agent.name}" failed: ${msg}`, 'agent_error');
      }
    }

    const deadline = Date.now() + timeoutMs;
    // Interrupt the CLI on the way out unless it is done (answered, or quiet).
    let interrupt = true;
    let authNoted = false;
    let quietSince: number | null = null;
    try {
      for (;;) {
        const answer = takeLlmAnswer(requestId);
        if (answer !== null) {
          interrupt = false;
          return {
            content: answer.replace(/\s+$/, ''),
            source: 'tool',
            promptTokens: estimateTokens(prompt),
          };
        }
        if (signal?.aborted) throw clientClosed();
        if (!runner.isCliTurnActive(agent.id, prompt)) {
          throw new LlmRequestError(409, `Agent "${agent.name}" was stopped`, 'agent_stopped');
        }
        if (Date.now() > deadline) {
          throw new LlmRequestError(
            504,
            `Agent "${agent.name}" gave no answer within ${Math.round(timeoutMs / 1000)}s`,
            'timeout'
          );
        }

        if (!authNoted) {
          const authError = await runner._checkTerminalAuthError(agent.id);
          if (authError) {
            authNoted = true;
            console.warn(`🔌 [LLM API] "${agent.name}" needs authentication: ${authError}`);
            runner.addActionLog(
              agent.id,
              'warning',
              'LLM API request waiting: the CLI needs authentication. Log in from the agent terminal (e.g. /login), then resubmit the request there (↑ then Enter).',
              authError
            );
          }
        }

        const quiet = !authNoted && (await runner._isCliQuiet(agent.id));
        quietSince = quiet ? (quietSince ?? Date.now()) : null;
        if (quietSince !== null && Date.now() - quietSince >= quietMs) {
          interrupt = false;
          throw new LlmRequestError(
            502,
            `Agent "${agent.name}" finished its turn without submitting its answer — see its terminal`,
            'no_answer'
          );
        }
        await pause(pollMs, signal);
      }
    } finally {
      runner.endCliTurn(agent.id, prompt, { interrupt });
      opts.onTurnSettled?.();
    }
  } finally {
    closeLlmAnswer(requestId);
  }
}

/**
 * Run one agent turn for an OpenAI chat request and return the answer.
 * Refuses (409) an agent that is already working: it would otherwise inject
 * the request into whatever the agent is doing.
 *
 * `signal` is the caller's connection: when it aborts, the turn is ended so
 * the agent does not stay busy — and answer 409 — for a reply nobody reads.
 *
 * A CLI agent answers in its shared terminal (runTerminalCompletion), unless
 * the request carries images: those can only reach the CLI through the chat
 * path.
 *
 * `opts.responseFormat` holds the answer to the JSON asked for, with one
 * correction turn in the same mode (checkedJsonOutput). `opts.webSearch`
 * adds the web search rule to the first turn's prompt.
 */
export async function runAgentCompletion(
  runner: CompletionRunner,
  agent: CompletionAgent,
  messages: ChatMessage[],
  signal?: AbortSignal,
  opts: CompletionOptions = {}
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

  if (runner.isTerminalDriven(agent.id) && !hasInlineImages(messages)) {
    return runTerminalCompletion(runner, agent, messages, signal, opts);
  }

  const format = opts.responseFormat ?? null;
  const first = await runChatTurn(runner, agent, signal, opts, file =>
    buildAgentPrompt(messages, { file }, format, opts.webSearch === true)
  );
  if (!format) return first;
  // The correction is another chat turn: the agent has its first answer in
  // its history.
  return checkedJsonOutput(agent, first, format, error =>
    runChatTurn(runner, agent, signal, opts, file => ({
      prompt: buildCorrectionPrompt(error, { file }, format),
      images: [],
    }))
  );
}

/**
 * One chat turn (sendMessage): `makePrompt` builds the prompt for the answer
 * file it is given; that file, else the reply, is the answer.
 */
async function runChatTurn(
  runner: CompletionRunner,
  agent: CompletionAgent,
  signal: AbortSignal | undefined,
  opts: CompletionOptions,
  makePrompt: (answerPath: string) => { prompt: string; images: PromptImage[] }
): Promise<CompletionResult> {
  const clientClosed = () =>
    new LlmRequestError(499, 'The client closed the request', 'client_closed');
  if (signal?.aborted) throw clientClosed();
  const answerPath = `${LLM_ANSWER_DIR}/${crypto.randomUUID()}.out`;
  const { prompt, images } = makePrompt(answerPath);

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
    opts.onTurnSettled?.();
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
