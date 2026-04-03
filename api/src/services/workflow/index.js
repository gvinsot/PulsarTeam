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
  isTerminalStatus,
  isValidTransition,
  columnExists,
  getFirstColumn,
  evaluateCondition,
  evaluateAllConditions,
  getOnEnterTransitions,
  getConditionalTransitions,
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
  isAgentBusy,
} from './agentSelector.js';

// Action execution
export { executeAction, stripToolCalls } from './actionExecutor.js';

// Orchestration — main entry points
export { processColumnEntry, recheckPendingTransitions } from './workflowEngine.js';
