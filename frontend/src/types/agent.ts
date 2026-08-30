// ── Agent, status projections, conversation ─────────────────────────────────
//
// The agents table stores the whole agent as an opaque `data JSONB NOT NULL`
// blob (api/src/services/database/baseSchema.ts:58-65): only id, owner_id,
// board_id, created_at and updated_at are real columns. SQL therefore gives no
// nullability guarantee for any field except boardId.
//
// WHAT IS ACTUALLY GUARANTEED ON THE WIRE, end to end:
//
//   getAllAgents returns `row.data` RAW, patching only boardId from the column
//   (api/src/services/database/agents.ts:10-17)
//     → loadFromDatabase backfills exactly thirteen keys — status, currentTask,
//       currentThinking, actionLogs, skills, mcpServers, mcpAuth, credentials,
//       isVoice, voice, ttsEnabled, projectContexts, runnerSessions, plus
//       projectChangedAt when it is `undefined`
//       (api/src/services/agentManager/index.ts:446-470)
//     → _sanitize adds mcpAuth, credentials and tasks, and provider/model/
//       supportsImages when llmConfigId resolves; EVERYTHING ELSE is the
//       `...rest` spread of the stored blob
//       (api/src/services/agentManager/index.ts:671-702).
//
// So for any key outside that list, presence rests entirely on create() having
// written it (api/src/services/agentManager/crud.ts:74-126) — and api/src itself
// does not trust that: it reads `agent.name ||` (status.ts:27), `agent.role ||`
// (:192), `agent.description ||` (:193), `agent.createdAt ||` (index.ts:465,
// status.ts:220), `agent.conversationHistory ||` (chat.ts:686), `agent.metrics ||`
// (status.ts:103) and `agent.enabled !== false` (status.ts:201). Those keys are
// therefore declared OPTIONAL on Agent below, and the comment on each one names
// the guard that proves it. The previous version of this file asserted the gap in
// this header and then declared all ten required — the two cannot both be true.
//
// Agent and AgentStatus are DIFFERENT shapes, not subsets of one another: they
// disagree on the fallback for `role`, and on whether provider/model is an
// optional key or a nullable value. Do not share one type between them.

import type { TaskStatus } from './board';
import type { LlmProvider } from './config';

/** Closed union. setStatus is only ever called with 'busy'/'idle', and
 *  _failChat's finalStatus is typed 'error' | 'idle'. */
export type AgentStatusValue = 'idle' | 'busy' | 'error';

/**
 * z.enum at api/src/schemas/agents.ts:98. 'coder' is a DEPRECATED alias for
 * 'claudecode', kept only for already-stored agents. null (see Agent.runner)
 * means "Auto", which the settings UI resolves client-side before saving.
 *
 * Note RUNNER_LABELS in AgentCard.tsx is missing an entry for 'aider'.
 */
export type AgentRunner =
  'sandbox' | 'claudecode' | 'coder' | 'openclaw' | 'hermes' | 'opencode' | 'aider' | 'codex';

/** z.enum(['realtime','external']) at api/src/schemas/agents.ts:36. */
export type AgentVoiceMode = 'realtime' | 'external';

/**
 * Union of every literal passed to addActionLog across api/src. RULE 1: api/src is
 * the only writer.
 *
 * 'warning' IS emitted, three times, all on the chat retry paths:
 * api/src/services/agentManager/chat.ts:416 (context limit exceeded — compacting),
 * :483 (connection lost, retrying) and :527 (error after tool execution — not
 * retrying). Do not drop it from this union, and do not delete the renderer's
 * warning branch.
 *
 * 'info' had the mirror-image problem — emitted by the API (chat.ts and
 * conversation.ts:159, the Reload Context path) but absent from ActionLogsTab's
 * style map, so those rows fell through the `|| typeConfig.idle` fallback and
 * rendered as 'Idle'. The map now carries all five; keep it that way.
 */
export type AgentActionLogType = 'busy' | 'idle' | 'error' | 'info' | 'warning';

/** 'text' at agentFeatures.ts:154, 'url' at :172, both written `as const`. */
export type AgentRagDocumentType = 'text' | 'url' | (string & {});

/**
 * Closed union: the only pushes into conversationHistory are the user entry
 * (chat.ts:206), the assistant entry (chat.ts:265) and the compaction summary
 * (also 'assistant'). The 'system' message at chat.ts:192 goes into the LLM
 * payload only, never into history.
 */
export type ConversationRole = 'user' | 'assistant';

/**
 * Optional discriminator on a conversation entry — the key is written only when
 * a messageMeta was supplied, so a plain user/assistant turn has NO `type` at
 * all.
 *
 * 'delegation-task' is READ by the API and by ChatMessage but NO producer writes
 * it any more; that render branch is reachable only through the
 * `content.startsWith('[TASK from ')` string fallback.
 */
export type ConversationMessageType =
  | 'tool-result'
  | 'nudge'
  | 'ask-question'
  | 'ask-result'
  | 'workflow-action'
  | 'compaction-summary'
  | 'delegation-task';

/**
 * Per-agent task tallies rendered on the agent card and embedded in AgentStatus.
 * Produced by api/src/services/agentManager/status.ts:78.
 */
export interface AgentTaskCounts {
  waiting: number;
  active: number;
  done: number;
  error: number;
  total: number;
}

/**
 * Lifetime counters kept on the agent object, surfaced on both Agent and
 * AgentStatus. Produced by api/src/services/agentManager/crud.ts:96.
 */
export interface AgentMetrics {
  totalMessages: number;
  /** Raised to the token_usage_log floor by _applyTokenFloor so CLI-runner spend
   *  shows up. */
  totalTokensIn: number;
  totalTokensOut: number;
  /** ISO 8601; null until the first completed turn. */
  lastActiveAt: string | null;
  errors: number;
}

/**
 * One document attached to the agent's retrieval context (pasted text or fetched
 * URL). Produced by api/src/services/agentManager/agentFeatures.ts:150.
 */
export interface AgentRagDocument {
  id: string;
  name: string;
  /** Truncated at 200k chars for URL documents. */
  content: string;
  type: AgentRagDocumentType;
  /** ISO 8601. */
  addedAt: string;
  /** Key only written for type:'url' documents. */
  url?: string;
  /** ISO 8601; only for type:'url', refreshed by refreshRagUrlDocument. */
  lastFetched?: string;
}

/**
 * One entry of the agent's activity timeline.
 * Produced by api/src/services/agentManager/actionLogs.ts:26.
 */
export interface AgentActionLog {
  id: string;
  type: AgentActionLogType;
  message: string;
  /** The errorDetail argument, default null. */
  error: string | null;
  /** Seeded null, back-filled asynchronously with the agent's active task id. */
  taskId: string | null;
  /** First 200 chars of the linked task's text. */
  taskTitle: string | null;
  /** ISO 8601. */
  timestamp: string;
  /** OPTIONAL: written onto the PREVIOUS entry when the next one is appended, so
   *  the newest log never has it. */
  durationMs?: number;
}

/**
 * An image attached to a chat turn or returned by a tool, inlined as base64.
 * Produced by api/src/services/agentManager/chat.ts:220.
 */
export interface ChatImage {
  /** MIME type, used to build the data: URI. */
  mediaType: string;
  /** base64 payload, deliberately kept in history for display. */
  data: string;
  /** CLIENT-ONLY: read as `img.preview || data:...` for locally-pending
   *  attachments. The API never sends it. */
  preview?: string;
}

/**
 * One tool invocation summary attached to a type:'tool-result' message.
 * Produced by api/src/services/agentManager/chat.ts:1460.
 */
export interface MessageToolResult {
  tool: string;
  args: string[];
  success: boolean;
  /** `r.result || undefined` — a falsy result drops the key entirely rather than
   *  sending null. */
  result?: string;
  /** `r.success ? undefined : r.error` — key absent on success. */
  error?: string;
  /** true for @report_error escalations. */
  isErrorReport: boolean;
  /** `r.images || undefined` — key absent when the tool returned no image. */
  images?: ChatImage[];
}

/**
 * One entry of agent.conversationHistory — what the chat surface renders, and
 * what GET /agents/:id/history and the two history-mutation routes return as an
 * array. Produced by api/src/services/agentManager/chat.ts:205.
 */
export interface ConversationMessage {
  role: ConversationRole;
  /** ContextTab defensively handles a non-string content; no producer emits one. */
  content: string;
  /** ISO 8601. Required here — contrast AgentLastMessage.timestamp, which is
   *  normalised to `string | null`. */
  timestamp: string;
  type?: ConversationMessageType;
  /** Only on type:'tool-result' entries. */
  toolResults?: MessageToolResult[];
  /** Name of the delegating/asking agent; set for type:'ask-question'. */
  fromAgent?: string;
  /** Key written only when the user attached images to that turn. */
  images?: ChatImage[];
  /** Assistant entries only, and only when > 0 — an instant reply has no key. */
  durationMs?: number;
  /** Assistant entries only, and only when > 0. */
  outputTokens?: number;
  /** Copied from messageMeta, but NO caller in api/src ever supplies it and no
   *  consumer reads it. Element shape is unknowable from the code, hence
   *  `unknown[]` rather than `any[]`. */
  delegationResults?: unknown[];
  /** CLIENT-ONLY optimistic tag: never produced by the API, stripped on ack or
   *  on rollback (AgentDetail.tsx:221-257). Declared here because the chat state
   *  holds locally-pending entries in the same array. */
  _pendingMessageId?: string;
}

/** Redacted presence marker for a per-agent MCP server bearer token — RESPONSE
 *  shape only. ASYMMETRIC: the PUT body is AgentMcpAuthUpdate, not this. */
export interface AgentMcpAuthRef {
  hasApiKey: boolean;
}

/**
 * REQUEST counterpart of AgentMcpAuthRef: one entry of the `mcpAuth` map in a
 * PUT /agents/:id body. Shape from the zod record at api/src/schemas/agents.ts:20-27
 * (`z.record(z.string(), z.object({ apiKey: z.string().max(500).optional() }))`).
 */
export interface AgentMcpAuthInput {
  /** Plaintext bearer token, max 500 chars. */
  apiKey?: string;
}

/** The whole `mcpAuth` field of a PUT /agents/:id body, keyed by MCP server id. */
export type AgentMcpAuthUpdate = Record<string, AgentMcpAuthInput>;

/** Redacted presence marker for a per-agent secret exposed to the runner —
 *  RESPONSE shape only. ASYMMETRIC: the PUT body is AgentCredentialsUpdate. */
export interface AgentCredentialRef {
  hasValue: boolean;
}

/**
 * REQUEST counterpart of AgentCredentialRef: the `credentials` field of a
 * PUT /agents/:id body — a flat name → plaintext-value map, where '' DELETES the
 * credential. This is what PermissionsTab actually sends, one key at a time:
 * `api.updateAgent(agent.id, { credentials: { [name]: value } })`
 * (PermissionsTab.tsx:400) and `{ [name]: '' }` to remove (:410).
 */
export type AgentCredentialsUpdate = Record<string, string>;

/** Linux-user grants inside AgentPermissions. Shape from api/src/schemas/agents.ts:49. */
export interface AgentPermissionsLinuxUser {
  runAsRoot?: boolean;
}

/** Network grants inside AgentPermissions. */
export interface AgentPermissionsNetwork {
  internetAccess?: boolean;
  allowedDomains?: string[];
}

/** Filesystem grants inside AgentPermissions. */
export interface AgentPermissionsFilesystem {
  readAccess?: boolean;
  writeAccess?: boolean;
  restrictedPaths?: string[];
}

/** Execution grants inside AgentPermissions. */
export interface AgentPermissionsExecution {
  shellAccess?: boolean;
  dangerousSkipPermissions?: boolean;
}

/**
 * Sandbox/runner capability grants for one agent; null on Agent until the user
 * saves the Permissions tab once. Shape from api/src/schemas/agents.ts:49.
 *
 * The four sections are named interfaces rather than inline anonymous objects so
 * a consumer can type a single section — PermissionsTab edits them one at a time —
 * and so this file stays consistent with every other sub-shape in the module.
 */
export interface AgentPermissions {
  linuxUser?: AgentPermissionsLinuxUser;
  network?: AgentPermissionsNetwork;
  filesystem?: AgentPermissionsFilesystem;
  execution?: AgentPermissionsExecution;
}

/** One pattern-to-action guardrail rule. Shape from api/src/schemas/agents.ts:83. */
export interface AgentToolHookRule {
  /** Builtin ids, or 'custom-<timestamp>' for user rules. */
  id: string;
  name: string;
  enabled: boolean;
  /** Regex SOURCE string, not a RegExp. */
  pattern: string;
  action: 'block' | 'warn';
  /** The UI offers run_command / write_file / append_file / mcp_call, but the
   *  schema is an open string array. */
  tools: string[];
  description?: string;
}

/** Per-agent guardrails that block or warn on matching tool invocations.
 *  Shape from api/src/schemas/agents.ts:78. */
export interface AgentToolHooks {
  enabled?: boolean;
  rules?: AgentToolHookRule[];
}

/**
 * Snapshot of an agent's conversation + runner sessions, parked while it works on
 * another project. Produced by api/src/services/agentManager/conversation.ts:255.
 */
export interface AgentProjectContext {
  conversationHistory: ConversationMessage[];
  /** Copied verbatim from agent._compactionArmed, so the key exists but may hold
   *  undefined. */
  _compactionArmed?: boolean;
  /** sessionKey → runner session uuid. */
  runnerSessions: Record<string, string>;
  /** ISO 8601. */
  savedAt: string;
}

/**
 * The full agent record as it leaves the API — GET /agents, GET /agents/:id and
 * the socket agents:list / agent:created / agent:updated payloads. This is the
 * output of AgentManager._sanitize (api/src/services/agentManager/index.ts:671).
 */
export interface Agent {
  id: string;
  batchId: string | null;
  /** 1-based member index; set on convertToBatch. */
  batchIndex: number | null;
  /** OPTIONAL, not nullable: create() always writes it (crud.ts:77) but nothing
   *  downstream re-defaults it, and status.ts:27 reads `agent.name ||`. */
  name?: string;
  /** OPTIONAL, same reason — status.ts:192 reads `agent.role || 'worker'`.
   *  RULE 3 (see index.ts) on the value space: z.string().max(100) with no lookup
   *  map, so a plain string. Template-seeded values include
   *  'leader'|'developer'|'architect'|'qa'|… plus free-text voice roles like
   *  'Voice Swarm Leader'. */
  role?: string;
  /** OPTIONAL, not nullable: defaults to '' at creation, and status.ts:193 reads
   *  `agent.description || ''`. */
  description?: string;
  instructions: string;
  status: AgentStatusValue;
  /** Free text of the task being worked on; cleared to null on idle/error. */
  currentTask: string | null;
  /** Default 0.7, but zod allows an explicit null. */
  temperature: number | null;
  maxTokens: number;
  /** Default 0, meaning "fall back to the llm config's contextSize". */
  contextLength: number;
  /** OPTIONAL: seeded to [] by create() but never re-defaulted by
   *  loadFromDatabase, so a blob written before the feature existed has no key. */
  ragDocuments?: AgentRagDocument[];
  /** Plugin ids. */
  skills: string[];
  /** Recomputed as explicit ∪ plugin-provided on every skill assign/remove. */
  mcpServers: string[];
  /** The key is only created the first time a plugin is assigned or removed —
   *  absent on a freshly created agent. */
  pluginMcpServers?: string[];
  /** RESPONSE shape only ({ hasApiKey } per server id). The PUT body expects
   *  Record<string, { apiKey?: string }> — see AgentMcpAuthInput/AgentMcpAuthUpdate. */
  mcpAuth: Record<string, AgentMcpAuthRef>;
  /** OPTIONAL: not re-defaulted by loadFromDatabase, so a legacy blob without the
   *  key yields undefined — which is exactly why api/src itself reads
   *  `agent.conversationHistory || []` (chat.ts:686, status.ts:165,
   *  tools/handlers.ts:643, workflow/actionExecutor.ts:738). */
  conversationHistory?: ConversationMessage[];
  /** sessionKey → runner session uuid. */
  runnerSessions: Record<string, string>;
  /** Capped at the last 200 entries. */
  actionLogs: AgentActionLog[];
  currentThinking: string;
  /** OPTIONAL: `agent.metrics || {}` at status.ts:103 and
   *  routes/internalTokenUsage.ts:67, and every field read through `?.` at
   *  status.ts:214-218. Contrast AgentStatus.metrics, which is rebuilt field by
   *  field and is therefore guaranteed. */
  metrics?: AgentMetrics;
  handoffTargets: string[];
  /** Repo full name / project name. NOTE this field carries a git 'owner/repo'
   *  in practice, while Task.project carries a DB project NAME — the same string
   *  field spans two namespaces. */
  project: string | null;
  /** ISO 8601; backfilled on load from updatedAt/createdAt. */
  projectChangedAt: string | null;
  /** Keyed by project name. */
  projectContexts: Record<string, AgentProjectContext>;
  /** The key only appears once a project change has been started; cleared to
   *  false in the finally block. The consumer compares it with === true. */
  projectSwitching?: boolean;
  /** OPTIONAL: `agent.enabled !== false` (status.ts:201) is the API's own way of
   *  saying the key may be missing — an absent key means enabled. Never write a
   *  truthiness test against it. */
  enabled?: boolean;
  isLeader: boolean;
  isVoice: boolean;
  isReasoning: boolean;
  /** OpenAI realtime voice id, default 'alloy'; zod is an open string. */
  voice: string;
  /** null for non-voice agents. */
  voiceMode: AgentVoiceMode | null;
  ttsVoiceId: string | null;
  ttsEnabled: boolean;
  /** The AGENT_TEMPLATES id the agent was seeded from. */
  template: string | null;
  /** USD per 1e6 tokens. */
  costPerInputToken: number | null;
  costPerOutputToken: number | null;
  /** null means the runner uses its built-in model; joined against
   *  GET /llm-configs. */
  llmConfigId: string | null;
  ownerId: string | null;
  /** The board_id COLUMN wins over the JSON copy on read. null = "visible to
   *  everyone". This is the ONE field the SQL schema guarantees. */
  boardId: string | null;
  /** null until the user saves the Permissions tab once. */
  permissions: AgentPermissions | null;
  /** RESPONSE shape only ({ hasValue } per credential name). The PUT body expects
   *  Record<string, string> where '' deletes — see AgentCredentialsUpdate. */
  credentials: Record<string, AgentCredentialRef>;
  /** null = "Auto". */
  runner: AgentRunner | null;
  toolHooks: AgentToolHooks | null;
  /** OPTIONAL: hex, random from a fixed palette at creation, never re-defaulted. */
  color?: string;
  /** OPTIONAL: emoji, default '🤖' at creation, never re-defaulted. */
  icon?: string;
  /** OPTIONAL, ISO 8601: `agent.updatedAt || agent.createdAt || null`
   *  (index.ts:465) and `agent.createdAt || null` (status.ts:220) are the API's
   *  own guards. */
  createdAt?: string;
  /** OPTIONAL, ISO 8601, refreshed on every update. Guarded by the API at the
   *  same two sites as createdAt, and the first of them tests THIS field first:
   *  `agent.updatedAt || agent.createdAt || null` (index.ts:465) and
   *  `agent.updatedAt || null` (status.ts:221). */
  updatedAt?: string;
  /** Always present — _sanitize defaults it to all-zeros before the first stats
   *  enrichment. */
  tasks: AgentTaskCounts;
  /** OPTIONAL, not nullable: the key is only written when llmConfigId is set AND
   *  resolves to a known config (`sanitized.provider = config.provider`,
   *  index.ts:697). ABSENT for runner-default agents — which is the normal case
   *  for claudecode/codex, and why the unguarded `{agent.provider}/{agent.model}`
   *  renders 'undefined/undefined'.
   *
   *  Same value, copied from the same line, as LlmConfig.provider — so it carries
   *  the same type, including the '' a config with no provider stores. */
  provider?: LlmProvider;
  /** Same condition as provider. */
  model?: string;
  /** Same condition as provider. */
  supportsImages?: boolean;
  /** LEGACY and REST-only. No current writer puts apiKey on the agent object,
   *  but routes/agents.ts:33-39 still masks it for GET /agents — and the socket
   *  path does not mask it at all. */
  apiKey?: string;
  /** Internal compaction latch that leaks through _sanitize's `...rest` spread.
   *  Absent until the first compaction check; no consumer reads it. */
  _compactionArmed?: boolean;
}

/**
 * Compact task row embedded in AgentStatus.activeTasks.
 * Produced by api/src/services/agentManager/status.ts:176.
 */
export interface AgentStatusActiveTask {
  id: string;
  text: string;
  /** A board workflow column id — the same value space as Task.status. */
  status: TaskStatus;
  /** ISO 8601 from the started_at column. */
  startedAt: string | null;
}

/**
 * The lightweight status projection returned by GET /agents/statuses,
 * /agents/by-project/:project, /leader-tools/all-statuses and the swarm-status
 * agents array. A DIFFERENT shape from Agent, not a subset of it.
 * Produced by api/src/services/agentManager/status.ts:188.
 *
 * No frontend code consumes it today — the agents list arrives over the socket
 * plus GET /agents. The two SINGLE-agent status routes
 * (GET /agents/:id/status and /leader-tools/agent-status) used to miss the
 * `await` on the async getAgentStatus and serialize a Promise as `{}`, which
 * made this shape unreachable through them; both now await it, so it is real.
 */
export interface AgentStatus {
  id: string;
  /** POSSIBLY UNDEFINED, unlike every sibling here. The key is always written,
   *  but `name: agent.name` (status.ts:191) is an UNGUARDED read — contrast its
   *  two immediate neighbours, `agent.role || 'worker'` (:192) and
   *  `agent.description || ''` (:193). Since Agent.name is optional for the
   *  reasons documented there, this projection carries that through. */
  name: string | undefined;
  status: AgentStatusValue;
  /** Defaulted to 'worker' HERE — a value no Agent ever carries, since create()
   *  defaults Agent.role to 'general'. The two projections disagree. */
  role: string;
  /** '' fallback, never null. */
  description: string;
  project: string | null;
  projectChangedAt: string | null;
  /** null unless BOTH project and projectChangedAt are set. */
  projectDurationMs: number | null;
  /** Falls back to the text of the first active task. */
  currentTask: string | null;
  activeTasks: AgentStatusActiveTask[];
  /** NULLABLE here, whereas on Agent the same information is an OPTIONAL key.
   *  Do not share one type. Same LlmConfig value as Agent.provider, but written
   *  `resolvedLlm.provider || null` (status.ts:199), so the '' that LlmProvider
   *  admits is normalised away to null on this projection. */
  provider: LlmProvider | null;
  model: string | null;
  /** Always true in practice — getAllStatuses filters out disabled agents. */
  enabled: boolean;
  isLeader: boolean;
  runner: AgentRunner | null;
  /** Closed two-value union built from executionManager.hasEnvironment. */
  sandbox: 'running' | 'not running';
  tasks: AgentTaskCounts;
  /** conversationHistory length — Agent has no equivalent scalar. */
  messages: number;
  /** Rebuilt field by field with zero/null defaults, so unlike Agent.metrics
   *  every sub-field is guaranteed present. */
  metrics: AgentMetrics;
  /** NULLABLE here (`|| null`, status.ts:220-221) while on Agent the same two
   *  fields are OPTIONAL — the absent-key and the explicit-null encodings of the
   *  same missing value, one per projection. */
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Payload of the socket 'agent:status' event — a status-change ping, not a full
 * agent. Produced by api/src/services/agentManager/status.ts:391.
 * The frontend destructures only id and status.
 */
export interface AgentStatusEvent {
  id: string;
  name: string;
  status: AgentStatusValue;
  /** 'worker' fallback, same divergence from Agent.role as AgentStatus.role. */
  role: string;
  project: string | null;
  currentTask: string | null;
  isLeader: boolean;
}

/**
 * One message inside the getLastMessages envelope — a NORMALIZED projection of
 * ConversationMessage, not the same shape.
 * Produced by api/src/services/agentManager/getters.ts:48.
 */
export interface AgentLastMessage {
  /** Absolute index in the full conversationHistory, so it stays valid for
   *  DELETE /agents/:id/history/after/:index. */
  index: number;
  role: ConversationRole;
  content: string;
  /** NULLABLE here — `m.timestamp || null` normalizes a missing key into an
   *  explicit null, unlike ConversationMessage where the key is always written. */
  timestamp: string | null;
  /** NULLABLE, not optional — `m.type || null` (getters.ts:52) turns the absent
   *  key into null. The exact inverse of ConversationMessage.type.
   *
   *  NOT narrowed with `Exclude<…, 'delegation-task'>`: the producer is a raw
   *  passthrough over agent.conversationHistory, which is PERSISTED JSONB that
   *  survives restarts. "No producer writes it any more" is a statement about new
   *  writes, not about what is already stored — a legacy row still puts the value
   *  on the wire, and a type that excludes it would make the ChatMessage branch
   *  that renders it unreachable-by-type while it is live at runtime. */
  type: ConversationMessageType | null;
}

/**
 * Envelope returned by GET /leader-tools/last-messages.
 * Produced by api/src/services/agentManager/getters.ts:56.
 */
export interface AgentLastMessages {
  agentId: string;
  agentName: string;
  project: string | null;
  status: AgentStatusValue;
  /** Full history length, not the returned slice. */
  totalMessages: number;
  returned: number;
  /** Clamped to 1..50; NaN becomes 1. */
  limit: number;
  messages: AgentLastMessage[];
}
