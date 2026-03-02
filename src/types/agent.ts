export type Agent = {
  id: string;
  name: string;
  description?: string;
  templateId?: string;
  provider?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type CreateAgentPayload = {
  name: string;
  description?: string;
  templateId?: string;
  provider?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
};