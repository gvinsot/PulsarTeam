import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { claudeRateLimiter } from './rateLimiter.js';

// Helper: returns { temperature } object if temperature is set, or empty object to omit it
function tempParam(options) {
  return options.temperature != null ? { temperature: options.temperature } : {};
}

// ─── Ollama Provider ────────────────────────────────────────────────────────
// Retry helper for Ollama fetch calls — handles transient 'fetch failed'
// or HTTP 503 when Ollama is busy with another request.
const OLLAMA_MAX_RETRIES = 4;
const OLLAMA_BASE_DELAY_MS = 2000;
// Timeout for the initial Ollama fetch (connect + first byte).  Prompt eval
// on large contexts can take a while, so be generous here.
const OLLAMA_CONNECT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
// Idle timeout between SSE chunks during streaming.  If no data arrives for
// this long, the stream is considered dead (GPU hang, OOM, etc.).
const OLLAMA_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} maxRetries
 * @param {AbortSignal|null} externalSignal — caller-provided signal (e.g. user stop)
 */
async function ollamaFetchWithRetry(url, options, maxRetries = OLLAMA_MAX_RETRIES, externalSignal = null) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Use a connect timeout for the initial fetch (generous for large prompt eval).
    // This only covers getting the response headers — streaming body is handled
    // separately with an idle-per-chunk timeout in chatStream.
    const timeoutSignal = AbortSignal.timeout(OLLAMA_CONNECT_TIMEOUT_MS);
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;

    try {
      const res = await fetch(url, { ...options, signal: combinedSignal });
      // Ollama returns 503 when busy — retry
      if (res.status === 503 && attempt < maxRetries) {
        const delay = OLLAMA_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`⚠️  [Ollama] 503 busy — retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      // If the caller explicitly aborted, propagate immediately (no retry)
      if (externalSignal?.aborted) throw err;
      // Transient network / timeout errors — retry
      if (attempt < maxRetries) {
        const delay = OLLAMA_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`⚠️  [Ollama] ${err.message} — retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}
export class OllamaProvider {
  constructor(baseUrl, model) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
  }

  // Use Ollama's OpenAI-compatible endpoint to leverage tool_choice: "none"
  // which prevents models from generating tool calls that the harmony parser
  // would intercept and block.

  /**
   * Pull the model from Ollama if it's not already available locally.
   * Called automatically on 404 errors.
   */
  async _pullModel() {
    if (this._pulling) return this._pulling;
    console.log(`📥 [Ollama] Model "${this.model}" not found locally — pulling...`);
    this._pulling = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, stream: false })
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Pull failed (${res.status}): ${text}`);
        }
        await res.json();
        console.log(`✅ [Ollama] Model "${this.model}" pulled successfully`);
      } catch (err) {
        console.error(`❌ [Ollama] Failed to pull model "${this.model}": ${err.message}`);
        throw err;
      } finally {
        this._pulling = null;
      }
    })();
    return this._pulling;
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'system' : m.role,
        content: m.content
      })),
      ...tempParam(options),
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
      tool_choice: 'none',
    };
    // Pass num_ctx via Ollama-specific extension
    if (options.contextLength) {
      body.options = { num_ctx: options.contextLength };
    } else {
      body.options = { num_ctx: 8192 };
    }

    let res = await ollamaFetchWithRetry(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, OLLAMA_MAX_RETRIES, options.signal || null);

    // Auto-pull model on 404 and retry
    if (res.status === 404) {
      await this._pullModel();
      res = await ollamaFetchWithRetry(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, OLLAMA_MAX_RETRIES, options.signal || null);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      model: this.model,
      provider: 'ollama',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0
      }
    };
  }

  async *chatStream(messages, options = {}) {
    const body = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'system' : m.role,
        content: m.content
      })),
      ...tempParam(options),
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      tool_choice: 'none',
    };
    if (options.contextLength) {
      body.options = { num_ctx: options.contextLength };
    } else {
      body.options = { num_ctx: 8192 };
    }

    let res = await ollamaFetchWithRetry(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, OLLAMA_MAX_RETRIES, options.signal || null);

    // Auto-pull model on 404 and retry
    if (res.status === 404) {
      await this._pullModel();
      res = await ollamaFetchWithRetry(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, OLLAMA_MAX_RETRIES, options.signal || null);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finishReason = null;

    // Per-chunk idle timeout: if no data arrives for OLLAMA_STREAM_IDLE_TIMEOUT_MS,
    // we consider the stream dead.  The timer resets on every chunk received.
    let idleTimer = null;
    let idleReject = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (idleReject) idleReject(new Error('Ollama stream idle timeout — no data received for 5 minutes'));
      }, OLLAMA_STREAM_IDLE_TIMEOUT_MS);
    };
    const clearIdleTimer = () => { if (idleTimer) clearTimeout(idleTimer); };

    try {
      while (true) {
        // Race reader.read() against the idle timeout
        resetIdleTimer();
        const readPromise = reader.read();
        const idlePromise = new Promise((_, reject) => { idleReject = reject; });
        const { done, value } = await Promise.race([readPromise, idlePromise]);
        if (done) break;

        // Also check user abort
        if (options.signal?.aborted) {
          throw new Error('Agent stopped by user');
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') {
            yield {
              type: 'done',
              finishReason: finishReason || 'stop',
              usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens
              }
            };
            continue;
          }
          try {
            const data = JSON.parse(payload);
            const choice = data.choices?.[0];
            if (choice?.delta?.content) {
              yield { type: 'text', text: choice.delta.content };
            }
            // Reasoning models: emit thinking tokens separately
            if (choice?.delta?.reasoning_content) {
              yield { type: 'thinking', text: choice.delta.reasoning_content };
            }
            // Capture finish_reason (last chunk usually has it)
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            // Ollama may include usage in the last chunk
            if (data.usage) {
              totalInputTokens = data.usage.prompt_tokens || 0;
              totalOutputTokens = data.usage.completion_tokens || 0;
            }
          } catch (e) {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      clearIdleTimer();
    }
  }

  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── Claude Provider ────────────────────────────────────────────────────────
export class ClaudeProvider {
  constructor(apiKey, model) {
    this.client = new Anthropic({ apiKey });
    this.model = model || 'claude-sonnet-4-20250514';
    this.rateLimiter = claudeRateLimiter;
  }

  async chat(messages, options = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }));

    // Ensure messages alternate correctly
    const sanitized = this._sanitizeMessages(chatMessages);

    const params = {
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      ...tempParam(options),
      messages: sanitized,
    };
    if (systemMsg) params.system = systemMsg.content;

    const response = await this.rateLimiter.schedule(() => this.client.messages.create(params));

    return {
      content: response.content.map(c => c.text).join(''),
      model: this.model,
      provider: 'claude',
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0
      }
    };
  }

  async *chatStream(messages, options = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    }));

    const sanitized = this._sanitizeMessages(chatMessages);

    const params = {
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      ...tempParam(options),
      messages: sanitized,
      stream: true,
    };
    if (systemMsg) params.system = systemMsg.content;

    const streamOpts = {};
    if (options.signal) streamOpts.signal = options.signal;

    const stream = this.client.messages.stream(params, streamOpts);

    for await (const event of stream) {
      if (options.signal?.aborted) {
        stream.abort();
        throw new Error('Agent stopped by user');
      }
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta' && event.delta?.thinking) {
          yield { type: 'thinking', text: event.delta.thinking };
        } else if (event.delta?.text) {
          yield { type: 'text', text: event.delta.text };
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      type: 'done',
      finishReason: finalMessage.stop_reason === 'max_tokens' ? 'length' : 'stop',
      usage: {
        inputTokens: finalMessage.usage?.input_tokens || 0,
        outputTokens: finalMessage.usage?.output_tokens || 0
      }
    };
  }

  async ping() {
    try {
      // Simple validation - try a minimal request
      const response = await this.rateLimiter.schedule(() => this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      }));
      return !!response;
    } catch {
      return false;
    }
  }

  _sanitizeMessages(messages) {
    if (messages.length === 0) return [{ role: 'user', content: 'Hello' }];

    const result = [];
    let lastRole = null;

    for (const msg of messages) {
      if (msg.role === lastRole) {
        // Merge consecutive same-role messages
        result[result.length - 1].content += '\\n' + msg.content;
      } else {
        result.push({ ...msg });
        lastRole = msg.role;
      }
    }

    // Ensure first message is from user
    if (result[0]?.role !== 'user') {
      result.unshift({ role: 'user', content: '(continue)' });
    }

    return result;
  }
}

// ─── OpenAI Provider ────────────────────────────────────────────────────────
// Completion-only models (legacy, use /v1/completions endpoint)
const OPENAI_COMPLETION_MODELS = [
  'gpt-3.5-turbo-instruct', 'davinci-002', 'babbage-002',
  'text-davinci-003', 'text-davinci-002', 'text-curie-001', 'text-babbage-001', 'text-ada-001'
];

// Reasoning models: no temperature support, use 'developer' role instead of 'system'
const OPENAI_REASONING_PREFIXES = ['o1', 'o3', 'o4'];

function isOpenAIReasoningModel(model) {
  return OPENAI_REASONING_PREFIXES.some(p => model.startsWith(p));
}

export class OpenAIProvider {
  constructor(apiKey, model) {
    this.client = new OpenAI({ apiKey });
    this.model = model || 'gpt-4o';
    this.isCompletionModel = OPENAI_COMPLETION_MODELS.some(m => this.model.startsWith(m));
    this.isReasoningModel = isOpenAIReasoningModel(this.model);
    // Set to true on 404 to permanently switch to the Responses API for this instance
    this.useResponsesAPI = false;
  }

  _isReasoning(options = {}) {
    return this.isReasoningModel || options.isReasoning || false;
  }

  _mapMessages(messages, options = {}) {
    const reasoning = this._isReasoning(options);
    return messages.map(m => ({
      role: reasoning && m.role === 'system' ? 'developer' : m.role,
      content: m.content
    }));
  }

  async chat(messages, options = {}) {
    if (this.isCompletionModel) {
      return this._completionChat(messages, options);
    }
    if (this.useResponsesAPI) {
      return this._responsesChat(messages, options);
    }
    try {
      return await this._chatCompletion(messages, options);
    } catch (err) {
      if (err.status === 404) {
        this.useResponsesAPI = true;
        return this._responsesChat(messages, options);
      }
      throw err;
    }
  }

  async _chatCompletion(messages, options = {}) {
    const reasoning = this._isReasoning(options);
    const params = {
      model: this.model,
      messages: this._mapMessages(messages, options),
      max_completion_tokens: options.maxTokens || 4096,
    };
    if (!reasoning && options.temperature != null) {
      params.temperature = options.temperature;
    }

    const response = await this.client.chat.completions.create(params);

    return {
      content: response.choices[0]?.message?.content || '',
      model: this.model,
      provider: 'openai',
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0
      }
    };
  }

  async _responsesChat(messages, options = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const input = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    const params = {
      model: this.model,
      input,
      max_output_tokens: options.maxTokens || 4096,
    };
    if (systemMsg) {
      params.instructions = systemMsg.content;
    }
    if (!this._isReasoning(options)) {
      if (options.temperature != null) params.temperature = options.temperature;
    }

    const response = await this.client.responses.create(params);

    return {
      content: response.output_text || '',
      model: this.model,
      provider: 'openai',
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0
      }
    };
  }

  async _completionChat(messages, options = {}) {
    // Convert messages to a single prompt for completion models
    const prompt = messages.map(m => {
      if (m.role === 'system') return `System: ${m.content}`;
      if (m.role === 'user') return `Human: ${m.content}`;
      return `Assistant: ${m.content}`;
    }).join('\\n\\n') + '\\n\\nAssistant:';

    const response = await this.client.completions.create({
      model: this.model,
      prompt,
      ...tempParam(options),
      max_tokens: options.maxTokens || 4096,
    });

    return {
      content: response.choices[0]?.text?.trim() || '',
      model: this.model,
      provider: 'openai',
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0
      }
    };
  }

  async *chatStream(messages, options = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    console.log(`🔌 [OpenAI] chatStream model=${this.model} | messages=${messages.length} | systemPrompt=${systemMsg ? systemMsg.content.length + ' chars' : 'NONE'} | useResponsesAPI=${this.useResponsesAPI} | isReasoning=${this._isReasoning(options)}`);
    if (this.isCompletionModel) {
      yield* this._completionStream(messages, options);
      return;
    }
    if (this.useResponsesAPI) {
      yield* this._responsesChatStream(messages, options);
      return;
    }
    try {
      yield* this._chatCompletionStream(messages, options);
    } catch (err) {
      if (err.status === 404) {
        console.log(`🔌 [OpenAI] Chat Completions 404 for ${this.model} — switching to Responses API`);
        this.useResponsesAPI = true;
        yield* this._responsesChatStream(messages, options);
      } else {
        throw err;
      }
    }
  }

  async *_chatCompletionStream(messages, options = {}) {
    const reasoning = this._isReasoning(options);
    const params = {
      model: this.model,
      messages: this._mapMessages(messages, options),
      max_completion_tokens: options.maxTokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (!reasoning) {
      if (options.temperature != null) params.temperature = options.temperature;
    }

    const requestOpts = {};
    if (options.signal) requestOpts.signal = options.signal;

    const stream = await this.client.chat.completions.create(params, requestOpts);

    let gptFinishReason = null;
    for await (const chunk of stream) {
      if (options.signal?.aborted) throw new Error('Agent stopped by user');
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }
      // Reasoning models (o1/o3/o4): emit thinking tokens
      if (delta?.reasoning_content) {
        yield { type: 'thinking', text: delta.reasoning_content };
      }
      if (choice?.finish_reason) {
        gptFinishReason = choice.finish_reason;
      }

      // Final chunk with usage
      if (chunk.usage) {
        yield {
          type: 'done',
          finishReason: gptFinishReason || 'stop',
          usage: {
            inputTokens: chunk.usage.prompt_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || 0
          }
        };
      }
    }
  }

  async *_responsesChatStream(messages, options = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const input = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    const params = {
      model: this.model,
      input,
      max_output_tokens: options.maxTokens || 4096,
      stream: true,
    };
    if (systemMsg) {
      params.instructions = systemMsg.content;
    }
    if (!this._isReasoning(options)) {
      if (options.temperature != null) params.temperature = options.temperature;
    }

    const requestOpts = {};
    if (options.signal) requestOpts.signal = options.signal;

    const stream = await this.client.responses.create(params, requestOpts);

    for await (const event of stream) {
      if (options.signal?.aborted) throw new Error('Agent stopped by user');
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text', text: event.delta };
      }
      // Reasoning models: emit thinking tokens from reasoning summary
      if (event.type === 'response.reasoning_summary_text.delta') {
        yield { type: 'thinking', text: event.delta };
      }
      if (event.type === 'response.completed') {
        const status = event.response?.status;
        yield {
          type: 'done',
          finishReason: status === 'incomplete' ? 'length' : 'stop',
          usage: {
            inputTokens: event.response?.usage?.input_tokens || 0,
            outputTokens: event.response?.usage?.output_tokens || 0
          }
        };
      }
    }
  }

  async *_completionStream(messages, options = {}) {
    // Convert messages to a single prompt for completion models
    const prompt = messages.map(m => {
      if (m.role === 'system') return `System: ${m.content}`;
      if (m.role === 'user') return `Human: ${m.content}`;
      return `Assistant: ${m.content}`;
    }).join('\\n\\n') + '\\n\\nAssistant:';

    const stream = await this.client.completions.create({
      model: this.model,
      prompt,
      ...tempParam(options),
      max_tokens: options.maxTokens || 4096,
      stream: true,
    });

    let totalTokens = 0;
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.text;
      if (text) {
        yield { type: 'text', text };
        totalTokens++;
      }
    }

    yield {
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: totalTokens }
    };
  }

  async ping() {
    try {
      if (this.isCompletionModel) {
        const response = await this.client.completions.create({
          model: this.model,
          prompt: 'ping',
          max_tokens: 5,
        });
        return !!response;
      }
      if (this.useResponsesAPI) {
        const response = await this.client.responses.create({
          model: this.model,
          input: 'ping',
          max_output_tokens: 5,
        });
        return !!response;
      }
      const params = {
        model: this.model,
        max_completion_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      };
      if (!this.isReasoningModel) {
        params.temperature = 0;
      }
      const response = await this.client.chat.completions.create(params);
      return !!response;
    } catch (err) {
      if (err.status === 404 && !this.useResponsesAPI) {
        this.useResponsesAPI = true;
        try {
          const response = await this.client.responses.create({
            model: this.model,
            input: 'ping',
            max_output_tokens: 5,
          });
          return !!response;
        } catch {
          return false;
        }
      }
      return false;
    }
  }
}

// ─── vLLM Provider (OpenAI-compatible) ──────────────────────────────────────
export class VLLMProvider {
  constructor(baseUrl, model, apiKey, agentId = null, ownerId = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.agentId = agentId;
    this.ownerId = ownerId;
    const clientOpts = {
      apiKey: apiKey || 'dummy',
      baseURL: `${this.baseUrl}/v1`,
    };
    const headers = {};
    if (agentId) headers['X-Agent-Id'] = agentId;
    if (ownerId) headers['X-Owner-Id'] = ownerId;
    if (Object.keys(headers).length) clientOpts.defaultHeaders = headers;
    this.client = new OpenAI(clientOpts);
  }

  async chat(messages, options = {}) {
    const params = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      ...tempParam(options),
      max_tokens: options.maxTokens || 4096,
    };

    const requestOpts = {};
    if (options.taskId) requestOpts.headers = { 'X-Task-Id': options.taskId };

    const response = await this.client.chat.completions.create(params, requestOpts);

    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;
    const totalTokens = response.usage?.total_tokens || 0;
    const usage = {
      inputTokens: promptTokens || totalTokens,
      outputTokens: completionTokens
    };
    // Forward cost_usd extension (e.g. from coder-service / Claude Paid Plan)
    if (response.usage?.cost_usd != null) {
      usage.costUsd = response.usage.cost_usd;
    }

    return {
      content: response.choices[0]?.message?.content || '',
      model: this.model,
      provider: 'vllm',
      usage
    };
  }

  async *chatStream(messages, options = {}) {
    const params = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      ...tempParam(options),
      max_tokens: options.maxTokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
    };

    const requestOpts = {};
    if (options.signal) requestOpts.signal = options.signal;
    if (options.taskId) requestOpts.headers = { ...requestOpts.headers, 'X-Task-Id': options.taskId };

    const stream = await this.client.chat.completions.create(params, requestOpts);
    let vllmFinishReason = null;

    for await (const chunk of stream) {
      if (options.signal?.aborted) throw new Error('Agent stopped by user');
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        yield { type: 'text', text: choice.delta.content };
      }
      // Reasoning models: emit thinking tokens separately
      if (choice?.delta?.reasoning_content) {
        yield { type: 'thinking', text: choice.delta.reasoning_content };
      }
      if (choice?.finish_reason) {
        vllmFinishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        const promptTokens = chunk.usage.prompt_tokens || 0;
        const completionTokens = chunk.usage.completion_tokens || 0;
        const totalTokens = chunk.usage.total_tokens || 0;
        // coder-service now sends proper prompt_tokens (input) and completion_tokens (output).
        // Fallback to total_tokens if prompt_tokens is missing (legacy compatibility).
        const usage = {
          inputTokens: promptTokens || totalTokens,
          outputTokens: completionTokens
        };
        // Forward cost_usd extension (e.g. from coder-service / Claude Paid Plan)
        if (chunk.usage.cost_usd != null) {
          usage.costUsd = chunk.usage.cost_usd;
        }
        yield {
          type: 'done',
          finishReason: vllmFinishReason || 'stop',
          usage
        };
      }
    }
  }

  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── Mistral AI Provider ────────────────────────────────────────────────────
export class MistralProvider {
  constructor(apiKey, model) {
    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: 'https://api.mistral.ai/v1',
    });
    this.model = model || 'mistral-large-latest';
  }

  async chat(messages, options = {}) {
    const params = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      ...tempParam(options),
      max_tokens: options.maxTokens || 4096,
    };

    const response = await this.client.chat.completions.create(params);

    return {
      content: response.choices[0]?.message?.content || '',
      model: this.model,
      provider: 'mistral',
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0
      }
    };
  }

  async *chatStream(messages, options = {}) {
    const params = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      ...tempParam(options),
      max_tokens: options.maxTokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
    };

    const requestOpts = {};
    if (options.signal) requestOpts.signal = options.signal;

    const stream = await this.client.chat.completions.create(params, requestOpts);
    let finishReason = null;

    for await (const chunk of stream) {
      if (options.signal?.aborted) throw new Error('Agent stopped by user');
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        yield { type: 'text', text: choice.delta.content };
      }
      // Reasoning models: emit thinking tokens separately
      if (choice?.delta?.reasoning_content) {
        yield { type: 'thinking', text: choice.delta.reasoning_content };
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        yield {
          type: 'done',
          finishReason: finishReason || 'stop',
          usage: {
            inputTokens: chunk.usage.prompt_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || 0
          }
        };
      }
    }
  }

  async ping() {
    try {
      const response = await this.client.models.list();
      return !!response;
    } catch {
      return false;
    }
  }
}

// ─── Provider Factory ───────────────────────────────────────────────────────
export function createProvider(config) {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider(
        config.endpoint || 'http://localhost:11434',
        config.model
      );
    case 'claude':
      return new ClaudeProvider(
        config.apiKey,
        config.model
      );
    case 'openai':
      return new OpenAIProvider(
        config.apiKey,
        config.model
      );
    case 'vllm':
      return new VLLMProvider(
        config.endpoint || 'http://localhost:8000',
        config.model,
        config.apiKey || ''
      );
    case 'claude-paid':
      return new VLLMProvider(
        'http://coder-service:8000',
        config.model || 'claude-sonnet-4-20250514',
        process.env.CODER_API_KEY || '',
        config.agentId || null,
        config.ownerId || null
      );
    case 'mistral':
      return new MistralProvider(
        config.apiKey,
        config.model
      );
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
// ── Logging Wrapper ──────────────────────────────────────────────────────────
// Wraps any provider to log calls, responses, tokens, and duration.

class LoggingProvider {
  constructor(provider, config) {
    this._provider = provider;
    this._providerName = config.provider || 'unknown';
    this._model = config.model || 'unknown';
    this._agentName = config.name || config.agentName || null;
  }

  _prefix() {
    const agent = this._agentName ? ` agent="${this._agentName}"` : '';
    return `📊 [LLM]${agent} ${this._providerName}/${this._model}`;
  }

  async chat(messages, options = {}) {
    const start = Date.now();
    const msgCount = messages.length;
    const inputChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    console.log(`${this._prefix()} chat start | messages=${msgCount} inputChars=${inputChars}`);

    try {
      const result = await this._provider.chat(messages, options);
      const duration = Date.now() - start;
      const outputChars = result.content?.length || 0;
      const usage = result.usage || {};
      console.log(
        `${this._prefix()} chat done | ${duration}ms` +
        ` | tokens: in=${usage.prompt_tokens || '?'} out=${usage.completion_tokens || '?'} total=${usage.total_tokens || '?'}` +
        ` | chars: in=${inputChars} out=${outputChars}`
      );
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      console.error(`${this._prefix()} chat ERROR | ${duration}ms | ${err.message}`);
      throw err;
    }
  }

  async *stream(messages, options = {}) {
    const start = Date.now();
    const msgCount = messages.length;
    const inputChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    console.log(`${this._prefix()} stream start | messages=${msgCount} inputChars=${inputChars}`);

    let outputChars = 0;
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let chunkCount = 0;

    try {
      for await (const chunk of this._provider.stream(messages, options)) {
        chunkCount++;

        // Accumulate usage from chunks
        if (chunk?.usage) {
          totalUsage.prompt_tokens += chunk.usage.prompt_tokens || 0;
          totalUsage.completion_tokens += chunk.usage.completion_tokens || 0;
          totalUsage.total_tokens += chunk.usage.total_tokens || 0;
        }

        // Count output chars
        if (chunk?.content) outputChars += chunk.content.length;
        if (chunk?.thinking) outputChars += chunk.thinking.length;

        yield chunk;
      }

      const duration = Date.now() - start;
      console.log(
        `${this._prefix()} stream done | ${duration}ms | chunks=${chunkCount}` +
        ` | tokens: in=${totalUsage.prompt_tokens || '?'} out=${totalUsage.completion_tokens || '?'} total=${totalUsage.total_tokens || '?'}` +
        ` | chars: in=${inputChars} out=${outputChars}`
      );
    } catch (err) {
      const duration = Date.now() - start;
      if (!err.message?.includes('abort')) {
        console.error(`${this._prefix()} stream ERROR | ${duration}ms | chunks=${chunkCount} | ${err.message}`);
      }
      throw err;
    }
  }
}

export function createLoggingProvider(config) {
  const provider = createProvider(config);
  return new LoggingProvider(provider, config);
}
