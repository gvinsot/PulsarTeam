// ── Domain types barrel ─────────────────────────────────────────────────────
//
// The rest of the SPA imports from here and nowhere else:
//
//     import type { Task, Agent, BoardPermission } from '../types';
//
// Every name below is a shape the API actually PRODUCES (or, where marked
// UI-LOCAL, one the frontend produces for itself). Nothing here is inferred from
// what a component hopes to read: where a consumer and a producer disagree, the
// producer wins and the mismatch is documented at the type.
//
// The listing is explicit rather than `export *` so this file doubles as the
// inventory of the module.
//
// ── THE OPEN-VALUE-SPACE RULE ───────────────────────────────────────────────
//
// Several fields carry a value that has a well-known set of literals but no
// database CHECK behind it. There is exactly ONE rule for encoding those. It is
// NORMATIVE — every union added or touched from here on picks one of the three
// and cites its evidence — but it is not yet a description of the whole module:
// the unions named under each rule below have been audited against their
// producers, the rest have not. Auditing one is how you move it into a list.
// Do not invent a fourth encoding.
//
//   RULE 1 — CLOSED UNION (`'a' | 'b'`)
//     By the time the value reaches the browser it CANNOT be anything else.
//     Qualifies when any one of these holds:
//       (a) every write path the API exposes validates it — a zod enum, or a
//           hardcoded module const (UserRole, AgentRunner, BoardPermission,
//           AgentTemplateId);
//       (b) api/src is the only writer and the field is not in the update schema
//           (AgentActionLogType, TaskHistoryEntryType, BoardAuditAction);
//       (c) the producer COERCES every off-set value back into the set
//           (TaskExecutionStatus, CodeGraphLayer, CodeGraphDirection), or the only
//           consumer treats an unrecognised value as inert (the whole board.ts
//           workflow vocabulary — see that file's header).
//     Note that (a) is about SERVER VALIDATION, not about the DDL: UserRole's
//     column is free TEXT with no CHECK and the union is still closed, because
//     no route will write anything else.
//
//   RULE 2 — UNION PLUS TAIL (`'a' | 'b' | (string & {})`)
//     The API only length-caps the client's value, or passes it through
//     unvalidated, AND the frontend keys a lookup map on it with a fallback. The
//     union is the product contract and keeps autocompletion; the tail is what is
//     genuinely storable and therefore genuinely readable.
//     Applies to: TaskStatus, TaskType, TaskPriority, TaskSourceType,
//     TaskRecurrencePeriod, LlmProvider, StoredAgentMode, AgentRagDocumentType.
//
//   RULE 3 — PLAIN `string`
//     No fixed set exists anywhere, or nothing keys on the value.
//     Applies to: Agent.role, Plugin.category, AgentSkill.category,
//     DerivedRepo.provider, TaskSecondaryRepo.provider.
//
// The audited sites name their rule and their evidence in their own doc comment.
// When the evidence changes, move the type between rules — never add a private
// exception.
//
// NOT re-exported on purpose — these already have a home and must not be
// duplicated:
//   RoleAgent, RoleOptions, AUTO_ROLE  → components/tasks/workflowRoles.ts
//   ConnectStatus                      → components/connect/useConnectStatus.ts
//   CredentialField,
//   CredentialProviderConfig           → components/connect/CredentialConnectWidget.tsx
//   OAuthProviderConfig                → components/connect/OAuthConnectWidget.tsx
//   SttConfig, TtsConfig               → lib/externalVoiceClient.ts

// ── task (ReservedTaskStatus / TaskStatus live in board.ts, with the columns
//    that define them) ──────────────────────────────────────────────────────
export type {
  TaskType,
  TaskPriority,
  TaskExecutionStatus,
  TaskSourceType,
  TaskRecurrencePeriod,
  TaskHistoryEntryType,
  TaskCommit,
  TaskSecondaryRepo,
  TaskSource,
  TaskRecurrence,
  TaskExecutionMessage,
  TaskHistoryEntry,
  Task,
  TaskSocketPayload,
  TaskCreatedEvent,
} from './task';

// ── agent ──────────────────────────────────────────────────────────────────
export type {
  AgentStatusValue,
  AgentRunner,
  AgentVoiceMode,
  AgentActionLogType,
  AgentRagDocumentType,
  ConversationRole,
  ConversationMessageType,
  AgentTaskCounts,
  AgentMetrics,
  AgentRagDocument,
  AgentActionLog,
  ChatImage,
  MessageToolResult,
  ConversationMessage,
  AgentMcpAuthRef,
  AgentMcpAuthInput,
  AgentMcpAuthUpdate,
  AgentCredentialRef,
  AgentCredentialsUpdate,
  AgentPermissionsLinuxUser,
  AgentPermissionsNetwork,
  AgentPermissionsFilesystem,
  AgentPermissionsExecution,
  AgentPermissions,
  AgentToolHookRule,
  AgentToolHooks,
  AgentProjectContext,
  Agent,
  AgentStatusActiveTask,
  AgentStatus,
  AgentStatusEvent,
  AgentLastMessage,
  AgentLastMessages,
  OrphanAgent,
  OrphanAgentsResponse,
  OrphanAgentOwnerResult,
} from './agent';

// ── board (also owns the workflow AND the task-status vocabulary) ──────────
export type {
  BoardPermission,
  AgentMode,
  PersistedAgentMode,
  StoredAgentMode,
  WorkflowTrigger,
  WorkflowConditionField,
  WorkflowConditionOperator,
  ReservedTaskStatus,
  TaskStatus,
  BoardWorkflowColumn,
  WorkflowCondition,
  WorkflowActionAssignAgent,
  WorkflowActionAssignAgentIndividual,
  WorkflowActionRunAgent,
  WorkflowActionChangeStatus,
  WorkflowAction,
  WorkflowTransition,
  BoardWorkflow,
  BoardMcpAuthEntry,
  Board,
  BoardListItem,
  AdminBoardListItem,
  BoardWithAccess,
  BoardShare,
  BoardShareMutationResult,
  BoardAuditAction,
  BoardAuditLog,
  BoardPluginsResponse,
  DerivedRepo,
  DerivedStorage,
} from './board';

// ── project (also owns the /agents/tasks/stats/* payloads) ─────────────────
export type {
  Project,
  ProjectListItem,
  ProjectDetail,
  AvailableRepo,
  RepoPickerOption,
  AvailableStorage,
  DurationStats,
  ProjectTaskStats,
  CreatedVsResolvedPoint,
  ResolutionTimePoint,
  OpenOverTimePoint,
  ProjectTimeSeries,
  AgentTimeAgent,
  AgentTimeDay,
  AgentTimeSeries,
  ProjectDailyPoint,
  ProjectTaskSummary,
  ProjectStatsResponse,
  ProjectMutationAck,
} from './project';

// ── user, session, api keys ────────────────────────────────────────────────
export type {
  UserRole,
  UserDirectoryEntry,
  User,
  UserMutationResult,
  SessionPayload,
  SessionUser,
  VerifyResponse,
  ImpersonateResponse,
  AppUser,
  ApiKeyInfo,
  ApiKeyInfoResponse,
  ApiKeyCreated,
  TermsAcceptedResponse,
  TutorialCompletedResponse,
  OAuthProviderStatus,
  OAuthAuthUrlResponse,
} from './user';

// ── config: llm configs, templates, plugins, mcp, settings ─────────────────
export type {
  LlmProvider,
  LlmConfig,
  LlmConfigDraft,
  AgentTemplateId,
  AgentTemplateRole,
  AgentTemplate,
  McpAuthMode,
  PluginMcpEntry,
  PluginMcpDraft,
  Plugin,
  PluginDraft,
  McpServerStatus,
  McpTool,
  McpServer,
  McpTestTool,
  McpTestResult,
  AgentSkill,
  Settings,
  ReminderConfig,
} from './config';

// ── budget ─────────────────────────────────────────────────────────────────
export type {
  BudgetAlertLevel,
  BudgetTimelineGroupBy,
  BudgetConfig,
  BudgetSummaryResponse,
  BudgetByAgentRow,
  BudgetTimelinePoint,
  BudgetDailyPoint,
  BudgetAlert,
  BudgetAlertsResponse,
  BudgetConfigUpdateResponse,
  BudgetConfigErrorDetail,
  BudgetConfigErrorResponse,
} from './budget';

// ── code: github, commit diffs, code graph, code index ─────────────────────
export type {
  GitHubTreeEntryType,
  GitHubContentType,
  CommitFileStatus,
  CodeGraphLayer,
  CodeGraphDirection,
  GitHubActivityCommit,
  GitHubActivityTag,
  GitHubActivityResponse,
  GitHubBranch,
  GitHubTreeEntry,
  GitHubTreeResponse,
  GitHubFileContent,
  CommitDiffStats,
  CommitDiffFile,
  CommitDiff,
  CodeGraphNode,
  CodeGraphEdge,
  CodeGraphStats,
  CodeGraphLlm,
  CodeGraphResponse,
  CodeIndexProjectResponse,
  RepoFileTreeNode,
  RepoExplorerFileState,
  GitHubActivityTarget,
} from './code';

// ── ui ─────────────────────────────────────────────────────────────────────
export type { ToastType, Toast, ShowToastFn } from './ui';
