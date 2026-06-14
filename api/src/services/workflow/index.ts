/**
 * Workflow module — public API.
 *
 * Usage:
 *   import { processColumnEntry, recheckPendingTransitions } from '../workflow/index.js';
 *   import { isActiveStatus, getWorkflowManagedStatuses } from '../workflow/index.js';
 *   import { stripToolCalls } from '../workflow/index.js';
 */

// State machine — pure logic, no I/O
export {
  isActiveStatus,
  isValidTransition,
  columnExists,
  evaluateCondition,
  evaluateAllConditions,
  getMatchingTransitions,
  getWorkflowManagedStatuses,
  Trigger,
  ActionType,
  AgentMode,
} from './taskStateMachine.js';

// Agent selection + locking
export {
  findAgentByRole,
  findAgentForAssignment,
  acquireLock,
  releaseLock,
  markAgentBusy,
  clearAgentBusy,
} from './agentSelector.js';

// Action execution
export { executeAction, stripToolCalls } from './actionExecutor.js';

// Error helpers — guarantee tasks stay visible on the board after a failure
export { markTaskError, isUserStopError } from './taskErrors.js';

// Orchestration — main entry points
export { processColumnEntry, recheckPendingTransitions } from './workflowEngine.js';
