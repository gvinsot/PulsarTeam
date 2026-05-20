// Barrel re-export — all imports from './database.js' continue to work unchanged.
// The actual implementations live in ./database/*.js for better modularity.

export { getPool, isDatabaseConnected } from './database/connection.js';
export { initDatabase } from './database/schema.js';
export { getAllAgents, getAgentById, saveAgent, deleteAgentFromDb, setAgentOwner, getAgentsByOwner, setAgentBoard, getAgentsByBoard } from './database/agents.js';
export { getAllSkills, saveSkill, deleteSkillFromDb } from './database/skills.js';
export { getAllAgentSkills, searchAgentSkills, getAgentSkillById, saveAgentSkill, deleteAgentSkillFromDb } from './database/agentSkills.js';
export { getAllMcpServers, saveMcpServer, deleteMcpServerFromDb } from './database/mcpServers.js';
export {
  getAllProjects, getProjectById, getProjectByName, createProject, updateProject, deleteProject,
  getBoardsForProject, setBoardProject,
} from './database/projects.js';
export type { Project } from './database/projects.js';
export {
  getReposForBoard, getReposForProject, getAccessibleBoardRepos,
} from './database/boardRepos.js';
export type { DerivedRepo } from './database/boardRepos.js';
export {
  getStoragesForBoard, getStoragesForProject,
} from './database/boardStorages.js';
export type { DerivedStorage } from './database/boardStorages.js';
export { getSetting, getSettingAsync, setSetting, loadSettingsCache } from './database/settings.js';
export {
  recordTokenUsage, getTokenUsageSummary, getTokenUsageSummaryAsync,
  getTokenUsageByAgent, getTokenUsageTimeline, getDailyTokenUsage,
  refreshTokenSummaryCache,
} from './database/tokenUsage.js';
export {
  getAllUsers, getUserById, getUserByUsername, createUser, updateUser, deleteUser,
  getUserByGoogleId, createGoogleUser, linkGoogleId,
  getUserByMicrosoftId, createMicrosoftUser, linkMicrosoftId,
  getUserByGitHubId, createGitHubUser, linkGitHubId,
  countUsers, updateLastSeen, acceptTerms, completeTutorial,
} from './database/users.js';
export { getAllLlmConfigs, getLlmConfig, saveLlmConfig, deleteLlmConfig } from './database/llmConfigs.js';
export {
  getAllBoards, getBoardsByUser, getBoardById, createBoard, updateBoard, deleteBoard,
  getDefaultBoard, ensureDefaultBoard,
} from './database/boards.js';
export {
  getBoardShares, getBoardShare, createBoardShare, updateBoardShare, deleteBoardShare,
  getSharedBoardsForUser, logBoardAudit, getBoardAuditLogs,
} from './database/boardSharing.js';
export {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken,
  deleteOAuthTokensByScope, getOAuthTokensByScope, resolveAccessToken,
  loadOAuthTokens, getOAuthTokenCache,
} from './database/oauthTokens.js';
export type { OAuthProvider, ScopeType, OAuthTokenRecord } from './database/oauthTokens.js';
export {
  rowToTask,
  getTasksByAgent, getAllTasks, getTaskById, saveTaskToDb,
  deleteTaskFromDb, hardDeleteTaskFromDb, restoreTaskFromDb,
  getDeletedTasks, getDeletedTaskById, deleteTasksByAgent,
  getTasksForResume, clearTaskExecutionFlags, updateTaskExecutionStatus,
  clearActionRunningForAgent, clearAllStaleActionRunning,
  getActiveTasksByAgent, getTasksByBoard, getBoardWithMostTasksForProject,
  getTasksByAssignee, getActiveTaskForExecutor, hasActiveTask,
  countActiveTasksForAgent, getRecurringTasks, getTaskByJiraKey,
  updateTaskFields, getTasksByStatusAndBoard, searchTasks,
} from './database/tasks.js';
