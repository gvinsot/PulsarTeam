// ── Analytics view (GET /api/analytics/*) ───────────────────────────────────
//
// Produced by api/src/routes/analytics.ts over api/src/services/database/analytics.ts.
// Every count is converted to a JS number server-side; dates are ISO strings,
// and `day` fields are date-only 'YYYY-MM-DD' strings from to_char().

/** One slice of a breakdown (type, status, priority, stage, board, message). */
export interface AnalyticsCountBucket {
  key: string;
  count: number;
}

export interface AnalyticsBoardRow {
  board_id: string;
  board_name: string;
  project_id: string | null;
  project_name: string | null;
  owner_username: string | null;
  total_tasks: number;
  open_tasks: number;
  in_error: number;
  created_in_window: number;
  completed_in_window: number;
  agent_count: number;
  /** Token spend of the board's agents within the window. */
  total_cost: number;
  total_tokens: number;
  last_activity: string | null;
}

export interface AnalyticsActivityPoint {
  day: string;
  created: number;
  completed: number;
}

export interface AnalyticsBoardsResponse {
  days: number;
  boards: AnalyticsBoardRow[];
  /** Zero-filled, one point per day of the window. */
  activity: AnalyticsActivityPoint[];
}

export interface AnalyticsTasksResponse {
  days: number;
  /** Tasks created within the window. */
  total: number;
  byType: AnalyticsCountBucket[];
  completedByType: AnalyticsCountBucket[];
  /** Current column of every live task — not windowed. */
  byStatus: AnalyticsCountBucket[];
  byPriority: AnalyticsCountBucket[];
}

export interface AnalyticsErrorTask {
  id: string;
  title: string;
  board_id: string | null;
  board_name: string | null;
  error: string | null;
  error_from_status: string | null;
  task_type: string | null;
  updated_at: string | null;
}

export interface AnalyticsErrorsResponse {
  days: number;
  totalErrorEvents: number;
  tasksWithErrors: number;
  currentErrorCount: number;
  timeline: { day: string; count: number }[];
  byStage: AnalyticsCountBucket[];
  byBoard: AnalyticsCountBucket[];
  byType: AnalyticsCountBucket[];
  /** Normalised messages of the tasks currently in error. */
  topMessages: AnalyticsCountBucket[];
  current: AnalyticsErrorTask[];
}
