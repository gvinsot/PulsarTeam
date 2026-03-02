// ─── LLM Providers ─────────────────────────────────────────────────────────
// Unified interface for multiple LLM providers (OpenAI, Claude, Gemini, etc.)

import Anthropic from '@anthropic-ai/sdk';
import { claudeRateLimiter } from './rateLimiter.js';

// ─── OpenAI-Compatible Provider ─────────────────────────────────────────────
export class OpenAICompatibleProvider {
  constructor(config = {}) {
    this.baseURL = config.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.model = config.model || 'gpt-4';
    this.name = config.name || 'openai';
  }

  async sendMessage(messages, options = {}) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048, tools } = options;
    
    const formattedMessages = [];
    if (systemPrompt) {
      formattedMessages.push({ role: 'system', content: systemPrompt });
    }
    formattedMessages.push(...messages);

    const body = {
      model: options.model || this.model,
      messages: formattedMessages,
      temperature,
      max_tokens: maxTokens,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      }));
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    const choice = data.choices[0];
    
    // Handle tool calls
    if (choice.message.tool_calls) {
      return {
        content: choice.message.content || '',
        toolCalls: choice.message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })),
        usage: data.usage,
        provider: this.name,
      };
    }

    return {
      content: choice.message.content,
      usage: data.usage,
      provider: this.name,
    };
  }

  async sendMessageStream(messages, options = {}, onChunk) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048 } = options;
    
    const formattedMessages = [];
    if (systemPrompt) {
      formattedMessages.push({ role: 'system', content: systemPrompt });
    }
    formattedMessages.push(...messages);

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || this.model,
        messages: formattedMessages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            if (onChunk) onChunk(delta);
          }
        } catch (e) {
          // Skip malformed chunks
        }
      }
    }

    return { content: fullContent, provider: this.name };
  }
}


// ─── Ollama Provider ────────────────────────────────────────────────────────
export class OllamaProvider {
  constructor(config = {}) {
    this.baseURL = config.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = config.model || 'llama2';
    this.name = 'ollama';
  }

  async sendMessage(messages, options = {}) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048 } = options;
    
    const formattedMessages = [];
    if (systemPrompt) {
      formattedMessages.push({ role: 'system', content: systemPrompt });
    }
    formattedMessages.push(...messages);

    const response = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model || this.model,
        messages: formattedMessages,
        options: {
          temperature,
          num_predict: maxTokens,
        },
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    return {
      content: data.message.content,
      usage: {
        prompt_tokens: data.prompt_eval_count || 0,
        completion_tokens: data.eval_count || 0,
      },
      provider: 'ollama',
    };
  }

  async sendMessageStream(messages, options = {}, onChunk) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048 } = options;
    
    const formattedMessages = [];
    if (systemPrompt) {
      formattedMessages.push({ role: 'system', content: systemPrompt });
    }
    formattedMessages.push(...messages);

    const response = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model || this.model,
        messages: formattedMessages,
        options: {
          temperature,
          num_predict: maxTokens,
        },
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${error}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullContent += parsed.message.content;
            if (onChunk) onChunk(parsed.message.content);
          }
        } catch (e) {
          // Skip malformed lines
        }
      }
    }

    return { content: fullContent, provider: 'ollama' };
  }
}


// ─── Claude Provider ────────────────────────────────────────────────────────
export class ClaudeProvider {
  constructor(config = {}) {
    this.client = new Anthropic({ apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY });
    this.model = model || 'claude-sonnet-4-20250514';
    this.name = 'claude';
  }

  async sendMessage(messages, options = {}) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048, tools } = options;

    // Separate system messages and format for Claude API
    const claudeMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const params = {
      model: options.model || this.model,
      max_tokens: maxTokens,
      messages: claudeMessages,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    if (tools && tools.length > 0) {
      params.tools = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters || { type: 'object', properties: {} }
      }));
    }

    // ── Rate-limited Claude API call ──────────────────────────────────────
    const response = await claudeRateLimiter.schedule(async () => {
      const status = claudeRateLimiter.getStatus();
      console.log(
        `[ClaudeProvider] Sending request. ` +
        `Rate limiter: ${status.requestsInWindow}/${status.maxRequestsPerMinute} req/min, ` +
        `queue: ${status.queueDepth}`
      );
      return this.client.messages.create(params);
    });

    // Handle tool use responses
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      return {
        content: response.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n') || '',
        toolCalls: toolUseBlocks.map(b => ({
          id: b.id,
          name: b.name,
          arguments: b.input,
        })),
        usage: {
          prompt_tokens: response.usage?.input_tokens,
          completion_tokens: response.usage?.output_tokens,
        },
        provider: 'claude',
      };
    }

    return {
      content: response.content[0].text,
      usage: {
        prompt_tokens: response.usage?.input_tokens,
        completion_tokens: response.usage?.output_tokens,
      },
      provider: 'claude',
    };
  }

  async sendMessageStream(messages, options = {}, onChunk) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048 } = options;

    const claudeMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const params = {
      model: options.model || this.model,
      max_tokens: maxTokens,
      messages: claudeMessages,
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    // ── Rate-limited Claude streaming API call ───────────────────────────
    const stream = await claudeRateLimiter.schedule(async () => {
      const status = claudeRateLimiter.getStatus();
      console.log(
        `[ClaudeProvider] Sending stream request. ` +
        `Rate limiter: ${status.requestsInWindow}/${status.maxRequestsPerMinute} req/min, ` +
        `queue: ${status.queueDepth}`
      );
      return this.client.messages.stream(params);
    });

    let fullContent = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        if (onChunk) onChunk(event.delta.text);
      }
    }

    return { content: fullContent, provider: 'claude' };
  }
}


// ─── Google Gemini Provider ─────────────────────────────────────────────────
export class GeminiProvider {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    this.model = config.model || 'gemini-pro';
    this.baseURL = 'https://generativelanguage.googleapis.com/v1beta';
    this.name = 'gemini';
  }

  async sendMessage(messages, options = {}) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048 } = options;

    // Convert to Gemini format
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };

    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const model = options.model || this.model;
    const response = await fetch(
      `${this.baseURL}/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    const content = data.candidates[0]?.content?.parts[0]?.text || '';

    return {
      content,
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
      provider: 'gemini',
    };
  }

  async sendMessageStream(messages, options = {}, onChunk) {
    const { systemPrompt, temperature = 0.7, maxTokens = 2048 } = options;

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };

    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const model = options.model || this.model;
    const response = await fetch(
      `${this.baseURL}/models/${model}:streamGenerateContent?key=${this.apiKey}&alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${error}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);

        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            fullContent += text;
            if (onChunk) onChunk(text);
          }
        } catch (e) {
          // Skip malformed chunks
        }
      }
    }

    return { content: fullContent, provider: 'gemini' };
  }
}


// ─── DeepSeek Provider ──────────────────────────────────────────────────────
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super({
      baseURL: config.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY,
      model: config.model || 'deepseek-chat',
      name: 'deepseek',
    });
  }
}


// ─── OpenRouter Provider ────────────────────────────────────────────────────
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super({
      baseURL: config.baseURL || 'https://openrouter.ai/api/v1',
      apiKey: config.apiKey || process.env.OPENROUTER_API_KEY,
      model: config.model || 'anthropic/claude-3.5-sonnet',
      name: 'openrouter',
    });
  }
}


// ─── Groq Provider ──────────────────────────────────────────────────────────
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super({
      baseURL: config.baseURL || 'https://api.groq.com/openai/v1',
      apiKey: config.apiKey || process.env.GROQ_API_KEY,
      model: config.model || 'llama-3.3-70b-versatile',
      name: 'groq',
    });
  }
}


// ─── Together AI Provider ───────────────────────────────────────────────────
export class TogetherProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super({
      baseURL: config.baseURL || 'https://api.together.xyz/v1',
      apiKey: config.apiKey || process.env.TOGETHER_API_KEY,
      model: config.model || 'meta-llama/Llama-3-70b-chat-hf',
      name: 'together',
    });
  }
}


// ─── Mistral Provider ───────────────────────────────────────────────────────
export class MistralProvider extends OpenAICompatibleProvider {
  constructor(config = {}) {
    super({
      baseURL: config.baseURL || 'https://api.mistral.ai/v1',
      apiKey: config.apiKey || process.env.MISTRAL_API_KEY,
      model: config.model || 'mistral-large-latest',
      name: 'mistral',
    });
  }
}


// ─── Provider Factory ───────────────────────────────────────────────────────
export function createProvider(type, config = {}) {
  switch (type) {
    case 'openai':
      return new OpenAICompatibleProvider(config);
    case 'claude':
      return new ClaudeProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'deepseek':
      return new DeepSeekProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    case 'groq':
      return new GroqProvider(config);
    case 'together':
      return new TogetherProvider(config);
    case 'mistral':
      return new MistralProvider(config);
    case 'custom':
      return new OpenAICompatibleProvider(config);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

export function getAvailableProviders() {
  const providers = [];
  
  if (process.env.OPENAI_API_KEY) {
    providers.push({ type: 'openai', name: 'OpenAI', models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo', 'gpt-4o', 'gpt-4o-mini'] });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({ type: 'claude', name: 'Claude', models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'] });
  }
  if (process.env.GOOGLE_API_KEY) {
    providers.push({ type: 'gemini', name: 'Gemini', models: ['gemini-pro', 'gemini-1.5-pro', 'gemini-1.5-flash'] });
  }
  if (process.env.DEEPSEEK_API_KEY) {
    providers.push({ type: 'deepseek', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-coder'] });
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({ type: 'openrouter', name: 'OpenRouter', models: ['anthropic/claude-3.5-sonnet', 'google/gemini-pro', 'meta-llama/llama-3-70b'] });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({ type: 'groq', name: 'Groq', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] });
  }
  if (process.env.TOGETHER_API_KEY) {
    providers.push({ type: 'together', name: 'Together AI', models: ['meta-llama/Llama-3-70b-chat-hf'] });
  }
  if (process.env.MISTRAL_API_KEY) {
    providers.push({ type: 'mistral', name: 'Mistral', models: ['mistral-large-latest', 'mistral-medium-latest'] });
  }
  
  // Ollama is always available (local)
  providers.push({ type: 'ollama', name: 'Ollama (Local)', models: ['llama2', 'codellama', 'mistral'] });
  
  return providers;
}