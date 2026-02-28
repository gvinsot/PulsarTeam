import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ─── Ollama Provider ────────────────────────────────────────────────────────
// Retry helper for Ollama fetch calls — handles transient 'fetch failed'
// or HTTP 503 when Ollama is busy with another request.
const OLLAMA_MAX_RETRIES = 4;
const OLLAMA_BASE_DELAY_MS = 2000;
// Timeout for an individual Ollama request (5 minutes).  If the GPU hangs or
// prompt evaluation takes too long, we abort rather than wait forever.
const OLLAMA_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} maxRetries
 * @param {AbortSignal|null} externalSignal — caller-provided signal (e.g. user stop)
 */
async function ollamaFetchWithRetry(url, options, maxRetries = OLLAMA_MAX_RETRIES, externalSignal = null) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Combine the caller's abort signal with a per-request timeout so:
    //  • the user can cancel at any time
    //  • a hung GPU doesn't block forever
    const timeoutSignal = AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS);
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

  // Strip control tokens that some models leak in their output
  _cleanResponse(text) {
    return text
      .replace(/<\|im_start\|>.*?(?:<\|im_end\|>|$)/gs, '')
      .replace(/<\|(?:end|start|channel|message|assistant|user|system)\|>/g, '')
      .replace(/<\|im_start\|[^>]*>/g, '')
      .replace(/<\|eot_id\|>/g, '')
      .replace(/<\|end_header_id\|>/g, '')
      .replace(/<\|start_header_id\|>.*?\n*/g, '')
      .replace(/<end_of_turn>/g, '')
      .replace(/<start_of_turn>.*?\n*/g, '')
      .trim();
  }

  async chat(messages, options = {}) {
    const ollamaOpts = {
      temperature: options.temperature ?? 0.7,
      num_predict: options.maxTokens ?? 4096,
    };
    // Limit the context window so Ollama doesn't allocate a giant KV cache
    // that saturates the GPU. Default to 8192 if not explicitly configured.
    if (options.contextLength) {
      ollamaOpts.num_ctx = options.contextLength;
    } else {
      ollamaOpts.num_ctx = 8192;
    }

    const body = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'system' : m.role,
        content: m.content
      })),
      stream: false,
      options: ollamaOpts
    };

    const res = await ollamaFetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, OLLAMA_MAX_RETRIES, options.signal || null);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return {
      content: this._cleanResponse(data.message?.content || ''),
      model: this.model,
      provider: 'ollama',
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0
      }
    };
  }

  async *chatStream(messages, options = {}) {
    const ollamaOpts = {
      temperature: options.temperature ?? 0.7,
      num_predict: options.maxTokens ?? 4096,
    };
    if (options.contextLength) {
      ollamaOpts.num_ctx = options.contextLength;
    } else {
      ollamaOpts.num_ctx = 8192;
    }

    const body = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'system' : m.role,
        content: m.content
      })),
      stream: true,
      options: ollamaOpts
    };

    const res = await ollamaFetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, OLLAMA_MAX_RETRIES, options.signal || null);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Buffer to detect and strip control tokens from streamed chunks
    let tokenBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            tokenBuffer += data.message.content;
            // Flush tokenBuffer but hold back if it ends with '<' (possible start of control token)
            const lastAngle = tokenBuffer.lastIndexOf('<');
            let toEmit;
            if (lastAngle >= 0 && !tokenBuffer.includes('>', lastAngle)) {
              // Potential incomplete control token — hold it
              toEmit = tokenBuffer.slice(0, lastAngle);
              tokenBuffer = tokenBuffer.slice(lastAngle);
            } else {
              toEmit = this._cleanResponse(tokenBuffer);
              tokenBuffer = '';
            }
            if (toEmit) {
              yield { type: 'text', text: toEmit };
            }
          }
          if (data.done) {
            // Flush remaining buffer
            if (tokenBuffer) {
              const cleaned = this._cleanResponse(tokenBuffer);
              if (cleaned) yield { type: 'text', text: cleaned };
              tokenBuffer = '';
            }
            yield {
              type: 'done',
              usage: {
                inputTokens: data.prompt_eval_count || 0,
                outputTokens: data.eval_count || 0
              }
            };
          }
        } catch (e) {
          // skip malformed lines
        }
      }
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
      temperature: options.temperature ?? 0.7,
      messages: sanitized,
    };
    if (systemMsg) params.system = systemMsg.content;

    const response = await this.client.messages.create(params);

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
      temperature: options.temperature ?? 0.7,
      messages: sanitized,
      stream: true,
    };
    if (systemMsg) params.system = systemMsg.content;

    const stream = this.client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      type: 'done',
      usage: {
        inputTokens: finalMessage.usage?.input_tokens || 0,
        outputTokens: finalMessage.usage?.output_tokens || 0
      }
    };
  }

  async ping() {
    try {
      // Simple validation - try a minimal request
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      });
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
        result[result.length - 1].content += '\n' + msg.content;
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

  _mapMessages(messages) {
    return messages.map(m => ({
      role: this.isReasoningModel && m.role === 'system' ? 'developer' : m.role,
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
    const params = {
      model: this.model,
      messages: this._mapMessages(messages),
      max_completion_tokens: options.maxTokens || 4096,
    };
    if (!this.isReasoningModel) {
      params.temperature = options.temperature ?? 0.7;
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
    if (!this.isReasoningModel) {
      params.temperature = options.temperature ?? 0.7;
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
    }).join('\n\n') + '\n\nAssistant:';

    const response = await this.client.completions.create({
      model: this.model,
      prompt,
      temperature: options.temperature ?? 0.7,
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
        this.useResponsesAPI = true;
        yield* this._responsesChatStream(messages, options);
      } else {
        throw err;
      }
    }
  }

  async *_chatCompletionStream(messages, options = {}) {
    const params = {
      model: this.model,
      messages: this._mapMessages(messages),
      max_completion_tokens: options.maxTokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (!this.isReasoningModel) {
      params.temperature = options.temperature ?? 0.7;
    }

    const stream = await this.client.chat.completions.create(params);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }

      // Final chunk with usage
      if (chunk.usage) {
        yield {
          type: 'done',
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
    if (!this.isReasoningModel) {
      params.temperature = options.temperature ?? 0.7;
    }

    const stream = await this.client.responses.create(params);

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text', text: event.delta };
      }
      if (event.type === 'response.completed') {
        yield {
          type: 'done',
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
    }).join('\n\n') + '\n\nAssistant:';

    const stream = await this.client.completions.create({
      model: this.model,
      prompt,
      temperature: options.temperature ?? 0.7,
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
  constructor(baseUrl, model, apiKey) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.client = new OpenAI({
      apiKey: apiKey || 'dummy',  // vLLM may not require an API key
      baseURL: `${this.baseUrl}/v1`,
    });
  }

  async chat(messages, options = {}) {
    const params = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens || 4096,
    };

    const response = await this.client.chat.completions.create(params);

    return {
      content: response.choices[0]?.message?.content || '',
      model: this.model,
      provider: 'vllm',
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
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
    };

    const stream = await this.client.chat.completions.create(params);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }

      if (chunk.usage) {
        yield {
          type: 'done',
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
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
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
        config.endpoint || process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        config.model
      );
    case 'claude':
      return new ClaudeProvider(
        config.apiKey || process.env.ANTHROPIC_API_KEY,
        config.model
      );
    case 'openai':
      return new OpenAIProvider(
        config.apiKey || process.env.OPENAI_API_KEY,
        config.model
      );
    case 'vllm':
      return new VLLMProvider(
        config.endpoint || process.env.VLLM_BASE_URL || 'http://localhost:8000',
        config.model,
        config.apiKey || process.env.VLLM_API_KEY || ''
      );
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
