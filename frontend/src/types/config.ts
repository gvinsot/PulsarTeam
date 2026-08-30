// ── LLM configs, templates, plugins, MCP servers, global settings ───────────
//
// Naming warning carried over from the API: what the UI calls a "plugin" is what
// the API and the DB still call a "skill" (the /api/plugins routes read the
// `skills` table). `Plugin` here is that entity. `AgentSkill` is a DIFFERENT,
// unrelated resource — the agent-authored auto-learn corpus at /api/agent-skills.

/**
 * RULE 2 (see index.ts). The API does NOT validate this field
 * (`req.body.provider || ''`), so '' is genuinely producible and an out-of-union
 * value is storable. Rule 2's second half is met by the shape of the lookup rather
 * than by a proven off-union read: `PROVIDER_LABELS[p] || p.charAt(0).toUpperCase()
 * + p.slice(1)` (LlmConfigModal.tsx:94) falls back to the raw value, though at
 * that line `p` iterates the hardcoded PROVIDER_OPTIONS (:4-14) rather than a
 * value read back from the API. The union is what that only writer offers; the
 * `(string & {})` tail is what is actually storable.
 *
 * The union does NOT match what the server can actually instantiate
 * (api/src/services/llmProviders.ts:1031-1058 handles
 * ollama|claude|openai|vllm|claude-paid|mistral and otherwise throws), so
 * 'anthropic', 'google', 'deepseek' and 'openrouter' throw on the non-agent call
 * sites. Typing them here documents what is storable, not what works.
 *
 * This is also the type of Agent.provider, AgentStatus.provider and
 * CodeGraphLlm.provider: all three are the SAME value, copied from this same
 * LlmConfig row (agentManager/index.ts:697, agentManager/status.ts:199,
 * codeGraphAnalyzer.ts:530).
 */
export type LlmProvider =
  | 'anthropic'
  | 'claude-paid'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'mistral'
  | 'openrouter'
  | 'vllm'
  | 'ollama'
  | ''
  | (string & {});

/**
 * An administrable LLM configuration, shared team-wide and assignable to agents
 * via Agent.llmConfigId. Produced by api/src/routes/llmConfigs.ts:45.
 *
 * There is no `updatedAt`: PUT spreads `...existing` and never stamps one.
 */
export interface LlmConfig {
  id: string;
  /** Defaults to 'Unnamed'. */
  name: string;
  /** Can be '' — the agent LLM picker renders `MyConfig (/)` for a config with
   *  neither provider nor model. */
  provider: LlmProvider;
  /** Can be ''. */
  model: string;
  /** MASKED on read: non-admins get '********' (or '' when unset), admins get the
   *  plaintext. Optional because maskApiKey writes the field verbatim for admins,
   *  so a legacy row without one yields undefined and JSON drops the key.
   *  Sending '********' back on PUT preserves the stored key. */
  apiKey?: string;
  /** '' when unset. */
  endpoint: string;
  isReasoning: boolean;
  /** Optional: always written by POST and PUT, but a row persisted before the
   *  field existed and never PUT since has the key absent. */
  managesContext?: boolean;
  /** Same legacy-row caveat as managesContext. */
  supportsImages?: boolean;
  /** null means "use the model default". */
  temperature: number | null;
  contextSize: number | null;
  maxOutputTokens: number | null;
  /** USD per 1e6 tokens. Independently nullable from costPerOutputToken — a
   *  config with one and not the other renders a truncated '$15/ per 1M'. */
  costPerInputToken: number | null;
  costPerOutputToken: number | null;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * UI-LOCAL, and the REQUEST counterpart of LlmConfig: what LlmConfigsTab holds in
 * its `llmForm` state slot and posts back. That slot is a three-state value —
 * `null` = modal closed, `{}` = creating, `{ id, … }` = editing
 * (LlmConfigsTab.tsx:12) — so the state itself is `LlmConfigDraft | null` and the
 * discriminator is `formData.id` (LlmConfigsTab.tsx:34: `if (formData.id) update
 * else create`).
 *
 * Every field is optional because the modal seeds the form with `{ ...config }`
 * and only assigns a key when the user touches that input (LlmConfigModal.tsx:26),
 * so a freshly-created draft really is `{}` on submit apart from `name`.
 *
 * `id` and `createdAt` are NOT omitted, even though no create/update path reads
 * them: the edit form seeds itself with `useState({ ...config })`
 * (LlmConfigModal.tsx:25), a fresh object literal spread from a full LlmConfig, so
 * excess-property checking would reject the draft the moment it is typed. The
 * route ignores both. The apiKey caveat of LlmConfig applies on the way back too:
 * sending the '********' mask preserves the stored key.
 */
export type LlmConfigDraft = Partial<LlmConfig>;

/**
 * The 14 hardcoded template ids, served verbatim from a module const
 * (api/src/data/templates.ts:3) — an exact, closed union.
 */
export type AgentTemplateId =
  | 'leader'
  | 'developer'
  | 'architect'
  | 'qa-engineer'
  | 'marketing'
  | 'devops'
  | 'data-analyst'
  | 'product-manager'
  | 'voice-leader'
  | 'voice-external'
  | 'security'
  | 'legal-advisor'
  | 'news-reporter'
  | 'compliance-auditor';

/**
 * The role each template seeds onto the agent. NOT the same union as
 * AgentTemplateId, and the two voice roles are human-readable sentences rather
 * than slugs (api/src/data/templates.ts:229 and :272).
 */
export type AgentTemplateRole =
  | 'leader'
  | 'developer'
  | 'architect'
  | 'qa'
  | 'marketing'
  | 'devops'
  | 'data-analyst'
  | 'product-manager'
  | 'Voice Swarm Leader'
  | 'Voice Assistant (External STT/TTS)'
  | 'security'
  | 'legal'
  | 'reporter'
  | 'compliance';

/**
 * A read-only, hardcoded agent preset offered when creating an agent.
 * Produced by api/src/data/templates.ts:1, served verbatim by GET /templates.
 */
export interface AgentTemplate {
  id: AgentTemplateId;
  name: string;
  /** Emoji. */
  icon: string;
  /** Hex string. */
  color: string;
  role: AgentTemplateRole;
  description: string;
  /** Multi-line system prompt. */
  instructions: string;
  /** Only ever literally `true`, and only on 3 templates — the key is ABSENT on
   *  the other 11, never false. */
  isLeader?: true;
  /** Present only on 'voice-leader' and 'voice-external'. */
  isVoice?: true;
  /** Present on exactly ONE template. The 'realtime' value that appears in the
   *  UI is invented client-side and never sent by the API. */
  voiceMode?: 'external';
  /** 0.2 .. 0.8 across the 14 templates. */
  temperature: number;
  /** 128000 everywhere except 'voice-external' (4096). */
  maxTokens: number;
}

/** sanitizeMcp always emits it, and the zod enum pins the union. */
export type McpAuthMode = 'none' | 'bearer';

/**
 * One MCP server as embedded INSIDE a plugin — the per-plugin view, carrying its
 * own auth mode and masked credential. Distinct from the global McpServer
 * registry entry (which has no authMode, but does have status/tools).
 * Produced by api/src/routes/plugins.ts:47.
 */
export interface PluginMcpEntry {
  /** For linked MCPs this is the global McpServer id. */
  id: string;
  /** Defaults to 'Unnamed Server'; 'Linked MCP' when the id resolves to nothing. */
  name: string;
  /** '' when unresolvable. May be an `__internal__*` sentinel rather than a real
   *  URL — see McpServer.url. */
  url: string;
  description: string;
  /** Emoji, defaults to '🔌'. */
  icon: string;
  authMode: McpAuthMode;
  /** NEVER the plaintext key on read — '' or the bullet string. The editor treats
   *  the bullets as "unchanged" and sends them back verbatim; the route swaps the
   *  stored key back in. */
  apiKey: '' | '••••••••';
  /** The only reliable "is a key stored" signal, since apiKey is masked. */
  hasApiKey: boolean;
  /** `mcp.enabled !== false`, so always a real boolean. */
  enabled: boolean;
  /** Free-form per-MCP configuration blob; no key set is enforced anywhere, hence
   *  Record<string, unknown> rather than `any`. */
  userConfig: Record<string, unknown>;
}

/**
 * A "plugin" (the entity the API and DB call a skill): an instruction blob plus a
 * set of linked MCP servers, assignable to agents and optionally shared.
 * Produced by api/src/routes/plugins.ts:57.
 */
export interface Plugin {
  /** uuidv4() for user-created plugins; a stable slug like 'skill-swarm-reader'
   *  for built-ins. The skills table PK is TEXT, not UUID. */
  id: string;
  /** Defaults to 'Unnamed Skill'. */
  name: string;
  description: string;
  /** Free text — the route only caps length. Shipped values: 'devops' |
   *  'general' | 'coding' | 'cloud'. Note 'cloud' has no entry in the frontend's
   *  categoryColors map and silently falls back to the 'general' style. */
  category: string;
  /** Emoji, defaults to '🔧'. */
  icon: string;
  instructions: string;
  /** Forced to {} by sanitizePlugin, so never absent or null. The editor
   *  round-trips it as KEY=VALUE lines, so values are strings in practice — but
   *  nothing enforces that, hence unknown. */
  userConfig: Record<string, unknown>;
  /** Forced to []. Entries are re-resolved live from the MCP manager on every
   *  read, so name/url/description track the registry. */
  mcps: PluginMcpEntry[];
  /** Always mirrors mcps.map(m => m.id). */
  mcpServerIds: string[];
  /** `skill.ownerId ?? null` — explicitly null for built-ins and legacy /
   *  system-owned plugins. */
  ownerId: string | null;
  /** Defaults to `builtin === true`, so built-ins are globally visible. */
  shared: boolean;
  /** normalizeSkill only spreads it and never defaults it, so it CAN be absent on
   *  a hand-written DB row. Consumers coerce with `!!`. */
  builtin?: boolean;
  /** ISO 8601. Absent for a built-in synthesized on the fly because it is not yet
   *  persisted in the map. */
  createdAt?: string;
  /** Same absence case as createdAt. */
  updatedAt?: string;
}

/**
 * UI-LOCAL, and the WRITE counterpart of PluginMcpEntry: one MCP row as it exists
 * inside PluginEditor's draft, before it is posted back.
 *
 * It differs from PluginMcpEntry on exactly the two fields a draft cannot honour:
 *
 *  - `apiKey` is a plain `string`, not `'' | '••••••••'`. That literal union is the
 *    READ contract (sanitizeMcp masks every key on the way out,
 *    api/src/routes/plugins.ts:47-53); the editor's password inputs put the user's
 *    PLAINTEXT key here, and the route swaps the stored one back in when it
 *    receives the bullets verbatim.
 *  - `id` is OPTIONAL. A freshly added, never-saved MCP has none
 *    (PluginEditor's createEmptyMcp), and the server mints one on save
 *    (`mcp.id || uuidv4()`, api/src/services/skillManager.ts:38).
 *
 * `hasApiKey` and `userConfig` are optional for the same "not on a new row" reason.
 * A PluginMcpEntry read off the wire is assignable to this; the reverse is not.
 */
export interface PluginMcpDraft {
  id?: string;
  name: string;
  url: string;
  description: string;
  icon: string;
  authMode: McpAuthMode;
  /** PLAINTEXT while editing; '••••••••' means "keep the stored key". */
  apiKey: string;
  hasApiKey?: boolean;
  enabled: boolean;
  userConfig?: Record<string, unknown>;
}

/**
 * UI-LOCAL. The plugin draft PluginEditor round-trips through its
 * `value`/`onChange` pair, for both the create and the edit form: the writable
 * subset of Plugin, plus the two read-only flags the edit form carries so a
 * panel can tell an owner from a borrower (absent from a create draft, hence
 * optional).
 *
 * `id`, `mcpServerIds`, `createdAt` and `updatedAt` are NOT here: no producer of
 * a draft sets them and the routes ignore them on the way in.
 *
 * WHY THE TYPE PARAMETER. A draft's MCP rows have two lives:
 *
 *   PluginDraft                      — the DEFAULT, and what a form state slot
 *                                      holds: rows seeded straight off the wire,
 *                                      still PluginMcpEntry-shaped.
 *   PluginDraft<PluginMcpDraft>      — the same draft once PluginEditor has been
 *                                      through it: a row may now carry a
 *                                      plaintext apiKey or have no id yet.
 *
 * The second is NOT assignable to the first (a plaintext key is not one of the
 * two masked literals PluginMcpEntry allows), but the first IS assignable to the
 * second, and the second is what `api.createPlugin` / `api.updatePlugin` take —
 * so both lives post back through the same call. That is the write schema's own
 * shape: `id` optional and `apiKey` a free string, api/src/routes/plugins.ts:9,17.
 */
export interface PluginDraft<TMcp extends PluginMcpDraft = PluginMcpEntry> {
  name: string;
  description: string;
  category: string;
  icon: string;
  instructions: string;
  userConfig: Record<string, unknown>;
  mcps: TMcp[];
  shared: boolean;
  ownerId?: string | null;
  builtin?: boolean;
}

/**
 * Exhaustive: 'disconnected' | 'connecting' | 'connected' | 'error'. Every server
 * is forced back to 'disconnected' at boot, so 'connected' is a live,
 * in-memory-only value.
 */
export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * One tool advertised by a connected MCP server.
 * Produced by api/src/services/mcpManager.ts:436.
 */
export interface McpTool {
  name: string;
  /** Coerced to '' when the server sends none. */
  description: string;
  /** JSON Schema, coerced to {}. Free by definition — Record<string, unknown>. */
  inputSchema: Record<string, unknown>;
}

/**
 * A registered MCP server in the global registry, with its live connection status
 * and the tool list discovered at connect time.
 * Produced by api/src/routes/mcpServers.ts:21.
 *
 * NOTE this shape has NO `authMode` — only the plugin-embedded PluginMcpEntry
 * does. BroadcastPanel gates its whole auth block on `mcp.authMode`, which makes
 * the hasApiKey badge dead code for every standalone server.
 */
export interface McpServer {
  /** uuidv4() for user-created, a stable slug ('mcp-gmail', 'mcp-office'…) for
   *  the built-ins. The table PK is TEXT. */
  id: string;
  name: string;
  /** TRANSPORT SHAPE: there is no `transport` field. Either a real http/https URL
   *  (StreamableHTTP with an SSE fallback), or an `__internal__<slug>` SENTINEL
   *  that is not a URL at all and is rewritten server-side to
   *  http://localhost:$PORT<path> with a signed JWT bearer. Auth, when present, is
   *  always `Authorization: Bearer <apiKey>`. */
  url: string;
  description: string;
  /** Emoji, defaults to '🔌'. */
  icon: string;
  /** Masked on every read path; stored encrypted at rest. */
  apiKey: '' | '••••••••';
  /** Added by the sanitizer only — not a stored field. */
  hasApiKey: boolean;
  builtin: boolean;
  /** `config.enabled !== false`. */
  enabled: boolean;
  /** [] until a successful connect; emptied again on connect failure. Never
   *  absent on the wire. */
  tools: McpTool[];
  status: McpServerStatus;
  /** Explicitly null when healthy; the connection error message when
   *  status === 'error'. */
  error: string | null;
  /** NULLABLE: createBuiltinServerEntry sets it to null for a built-in that is
   *  listed but has never been registered/persisted. */
  createdAt: string | null;
  updatedAt: string | null;
}

/** The leaner tool shape the connection probe returns — no inputSchema. */
export interface McpTestTool {
  name: string;
  description: string;
}

/**
 * Response of POST /api/mcp-servers/:id/test — a connection probe that ALWAYS
 * answers HTTP 200 and reports the outcome in the body, so the HTTP status tells
 * you nothing. Produced by api/src/routes/mcpServers.ts:146.
 */
export interface McpTestResult {
  /** The discriminant. */
  success: boolean;
  /** Success branch only. */
  name?: string;
  /** Success branch only. */
  toolCount?: number;
  /** Success branch only. */
  tools?: McpTestTool[];
  /** Failure branch only. The frontend synthesizes the same shape locally when
   *  the request itself throws. */
  error?: string;
}

/**
 * A skill in the agent-authored skill library (the auto-learn corpus). Separate
 * table and separate REST resource from Plugin, and currently agent/MCP-facing
 * only — no frontend component consumes /api/agent-skills today.
 * Produced by api/src/routes/agentSkills.ts:68.
 */
export interface AgentSkill {
  /** `agent-skill-<uuid>`. */
  id: string;
  name: string;
  description: string;
  /** Defaults to 'general'. Typed `string`, NOT the 6-value enum: the REST schema
   *  is z.string().max(100) and can write anything; only the MCP tool pins the
   *  enum. */
  category: string;
  /** Up to 100 000 chars. */
  instructions: string;
  mcpServerIds: string[];
  /** THREE different formats in one field: a username via REST, `agent:<agentId>`
   *  or 'system' via the auto-learn MCP, and the agent's display name via the
   *  inline tool path. */
  createdBy: string;
  /** Hardcoded null on the REST create path; the agent id on the MCP path. */
  createdByAgentId: string | null;
  /** Written as 0 by all three producers and never incremented anywhere in the
   *  repo. */
  useCount: number;
  /** Written as null by all producers and never stamped. */
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** OPTIONAL: only ever added by an update, never present on a freshly created
   *  skill. Same three-format problem as createdBy. */
  lastUpdatedBy?: string;
}

/**
 * The global settings blob from GET /api/settings/general — DEFAULTS merged with
 * every row of the key/value `settings` table.
 * Produced by api/src/services/configManager.ts:38.
 *
 * EVERY value is a TEXT column, so booleans and numbers travel as STRINGS
 * ('true', '10'). The index signature is not laziness: getSettings copies every
 * row of the table into the blob, so keys outside DEFAULTS (notably
 * `budget_config`, which arrives as a raw JSON *string*) really are on the wire.
 * PUT filters the patch back down to Object.keys(DEFAULTS), silently dropping
 * them.
 */
export interface Settings {
  /** Extra rows of the settings table that are not part of DEFAULTS. */
  [key: string]: string | undefined;
  ideasAgent: string;
  /** STRING, not boolean — the default literal is the string 'true'. */
  jiraEnabled: string;
  /** Free text, not an enum: the UI offers $ € £ ¥ CHF plus an arbitrary custom
   *  value. */
  currency: string;
  /** Numeric value carried as a string; parsed server-side. See ReminderConfig,
   *  which exposes the same three settings as real numbers. */
  taskReminderIntervalMinutes: string;
  taskReminderMaxCount: string;
  taskReminderCooldownMinutes: string;
  /** '' = feature off. An LlmConfig.id. */
  codeGraphLlmConfigId: string;
  /** '' = use safe defaults. */
  claudeFallbackLlmConfigId: string;
  /** '' = automatic role selection unavailable. */
  roleRouterLlmConfigId: string;
  sttServiceUrl: string;
  /** NOT masked, unlike LlmConfig.apiKey and McpServer.apiKey: this route has no
   *  sanitizer and no role guard, so the plaintext key is echoed to any
   *  authenticated caller. */
  sttApiKey: string;
  ttsServiceUrl: string;
  /** Same un-masked exposure as sttApiKey. */
  ttsApiKey: string;
  ttsVoiceId: string;
}

/**
 * GET/PUT /api/settings/general/reminders — the numeric, env-aware view of the
 * three taskReminder* settings. Produced by api/src/routes/settings.ts:32.
 *
 * These are NUMBERS here while the very same values are strings in Settings; the
 * route does the parsing and clamping. intervalMs / cooldownMs exist on the
 * internal config object but are deliberately not forwarded.
 */
export interface ReminderConfig {
  /** Clamped to >= 1. The env var wins over the DB. */
  intervalMinutes: number;
  /** Clamped to >= 1, default 12. */
  maxReminders: number;
  /** Clamped to >= 0, default 2. */
  cooldownMinutes: number;
  /** `!!process.env.TASK_REMINDER_INTERVAL_MINUTES`. Read-only signal — the PUT
   *  handler ignores it if sent back. */
  envOverride: boolean;
}
