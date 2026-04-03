/**
 * transitionProcessor.js — DEPRECATED backward-compatibility shim.
 *
 * All workflow transition logic has been refactored into:
 *   - services/workflow/taskStateMachine.js  (pure state logic)
 *   - services/workflow/agentSelector.js     (agent lookup + locking)
 *   - services/workflow/actionExecutor.js    (action execution per mode)
 *   - services/workflow/workflowEngine.js    (orchestration)
 *
 * This file re-exports the key symbols so existing imports don't break.
 * New code should import from '../workflow/index.js' instead.
 */

export { stripToolCalls } from './workflow/actionExecutor.js';
export { processColumnEntry as processTransition } from './workflow/workflowEngine.js';