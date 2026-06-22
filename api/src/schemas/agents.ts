import { z } from 'zod';

// Schema for creating a new agent
export const createAgentSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  endpoint: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  instructions: z.string().max(50000).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(1000000).optional(),
  contextLength: z.number().int().min(0).optional(),
  todoList: z.array(z.any()).optional(),
  ragDocuments: z.array(z.any()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  mcpAuth: z.record(z.string(), z.object({
    apiKey: z.string().max(500).optional(),
  })).optional(),
  handoffTargets: z.array(z.string()).optional(),
  project: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  isLeader: z.boolean().optional(),
  isVoice: z.boolean().optional(),
  isReasoning: z.boolean().optional(),
  voice: z.string().max(100).optional(),
  // 'realtime' = OpenAI Realtime API (default), 'external' = browser → STT → LLM → TTS pipeline
  voiceMode: z.enum(['realtime', 'external']).optional(),
  ttsVoiceId: z.string().max(200).optional(),
  // When true, assistant replies in the regular text chat are spoken aloud
  // using the global TTS service (if configured in Admin Settings).
  ttsEnabled: z.boolean().optional(),
  template: z.string().max(200).nullable().optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(50).optional(),
  costPerInputToken: z.number().min(0).nullable().optional(),
  costPerOutputToken: z.number().min(0).nullable().optional(),
  copyApiKeyFromAgent: z.string().uuid().optional(),
  llmConfigId: z.string().max(200).nullable().optional(),
  boardId: z.string().uuid().nullable().optional(),
  permissions: z.object({
    linuxUser: z.object({
      runAsRoot: z.boolean().optional(),
    }).optional(),
    network: z.object({
      internetAccess: z.boolean().optional(),
      allowedDomains: z.array(z.string().max(200)).optional(),
    }).optional(),
    filesystem: z.object({
      readAccess: z.boolean().optional(),
      writeAccess: z.boolean().optional(),
      restrictedPaths: z.array(z.string().max(500)).optional(),
    }).optional(),
    execution: z.object({
      shellAccess: z.boolean().optional(),
      dangerousSkipPermissions: z.boolean().optional(),
    }).optional(),
  }).optional(),
  credentials: z.record(z.string().max(100), z.string().max(2000)).optional(),
  toolHooks: z.object({
    enabled: z.boolean().optional(),
    rules: z.array(z.object({
      id: z.string().max(100),
      name: z.string().max(200),
      enabled: z.boolean(),
      pattern: z.string().max(2000),
      action: z.enum(['block', 'warn']),
      tools: z.array(z.string().max(50)),
      description: z.string().max(500).optional(),
    })).optional(),
  }).optional(),
  // 'coder' is a deprecated alias for 'claudecode' (kept for backward compat with stored agents)
  runner: z.enum(['sandbox', 'claudecode', 'coder', 'openclaw', 'hermes', 'opencode', 'aider', 'codex']).optional(),
  // Batch creation: when batchSize > 1, the server creates that many agents
  // sharing the same configuration and a common batchId. Names are auto
  // suffixed `#1`, `#2`, … so each agent stays uniquely identifiable.
  batchSize: z.number().int().min(1).max(50).optional(),
});

// Schema for updating an agent (all fields optional)
export const updateAgentSchema = createAgentSchema.partial().extend({
  ownerId: z.string().uuid().nullable().optional(),
  boardId: z.string().uuid().nullable().optional(),
});

export const convertAgentToBatchSchema = z.object({
  batchSize: z.number().int().min(2).max(50),
});
