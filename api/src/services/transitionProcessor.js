/**
 * TransitionProcessor – handles workflow column transitions with trigger actions.
 *
 * When a todo moves from one column to another, the target column may have
 * a trigger (e.g. "on_enter: run_prompt") that should be executed.
 *
 * This module:
 *  1. Validates the transition is allowed by the workflow config
 *  2. Executes any trigger associated with the target column
 *  3. Handles errors gracefully and reports them back
 */

// ── Transition queue to avoid race conditions ───────────────────────────────
const _transitionQueue = [];
let _processing = false;
const MAX_RETRIES = 3;
const _deadLetterQueue = [];

/**
 * Queue a transition for processing.
 * Returns a promise that resolves when the transition is complete.
 */
export function queueTransition(params) {
  return new Promise((resolve, reject) => {
    _transitionQueue.push({ params, resolve, reject, retries: 0 });
    _processNextTransition();
  });
}

/**
 * Get dead-letter queue contents for debugging.
 */
export function getDeadLetterQueue() {
  return [..._deadLetterQueue];
}

async function _processNextTransition() {
  if (_processing) return;
  if (_transitionQueue.length === 0) return;

  _processing = true;
  const item = _transitionQueue.shift();
  const { params, resolve, reject, retries } = item;

  try {
    const result = await processTransition(params);
    resolve(result);
  } catch (err) {
    if (retries < MAX_RETRIES) {
      // Retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, retries), 10000);
      console.warn(`[Workflow] Transition failed (attempt ${retries + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`, err.message);
      setTimeout(() => {
        _transitionQueue.push({ params, resolve, reject, retries: retries + 1 });
        _processNextTransition();
      }, delay);
    } else {
      // Max retries exceeded – move to dead-letter queue
      console.error(`[Workflow] Transition permanently failed after ${MAX_RETRIES} retries:`, err.message);
      _deadLetterQueue.push({
        params: { agentId: params.agentId, todoId: params.todoId, fromColumn: params.fromColumn, toColumn: params.toColumn, by: params.by },
        error: err.message,
        failedAt: new Date().toISOString(),
      });
      // Keep dead-letter queue bounded
      if (_deadLetterQueue.length > 50) _deadLetterQueue.shift();
      reject(err);
    }
  } finally {
    _processing = false;
    // Process next in queue
    if (_transitionQueue.length > 0) {
      setImmediate(_processNextTransition);
    }
  }
}

/**
 * Process a single transition.
 *
 * @param {object} params
 * @param {string} params.agentId – agent that owns the todo
 * @param {string} params.todoId – the todo being moved
 * @param {string} params.fromColumn – current column name
 * @param {string} params.toColumn – target column name
 * @param {string} params.by – who initiated (agentId or 'user')
 * @param {object} params.agentManager – AgentManager instance
 * @param {object} params.io – Socket.IO instance
 */
export async function processTransition({
  agentId,
  todoId,
  fromColumn,
  toColumn,
  by,
  agentManager,
  io,
}) {
  if (!agentManager) {
    console.error('[Workflow] No agentManager provided');
    return { success: false, error: 'No agentManager' };
  }

  const agent = agentManager.agents?.find(a => a.id === agentId);
  if (!agent) {
    console.error(`[Workflow] Agent ${agentId} not found`);
    return { success: false, error: 'Agent not found' };
  }

  const todo = (agent.todoList || []).find(t => t.id === todoId);
  if (!todo) {
    console.error(`[Workflow] Todo ${todoId} not found on agent ${agent.name}`);
    return { success: false, error: 'Todo not found' };
  }

  const wf = agentManager.configManager?.getWorkflowConfig?.(agentManager.projectId);
  if (!wf?.columns) {
    console.error('[Workflow] No workflow config found');
    return { success: false, error: 'No workflow config' };
  }

  const targetCol = wf.columns.find(c => c.name === toColumn || c.id === toColumn);
  if (!targetCol) {
    console.error(`[Workflow] Target column "${toColumn}" not found`);
    return { success: false, error: `Column "${toColumn}" not found` };
  }

  console.log(`[Workflow] Transitioning "${todo.text}" from ${fromColumn} → ${toColumn} (by ${by})`);

  // ── Update the todo status ──────────────────────────────────────────────
  const previousStatus = todo.status || fromColumn;
  todo.status = toColumn;
  todo.updatedAt = new Date().toISOString();
  todo.lastTransition = { from: fromColumn, to: toColumn, by, at: todo.updatedAt };

  agentManager.configManager.updateAgent(agentId, { todoList: agent.todoList });
  if (typeof agentManager._emitUpdate === 'function') {
    agentManager._emitUpdate(agent);
  }

  // ── Jira sync ─────────────────────────────────────────────────────────────
  try {
    const { onTodoStatusChanged } = await import('./jiraSync.js');
    await onTodoStatusChanged(todo, toColumn);
  } catch (err) {
    console.warn(`[Workflow] Jira sync failed for ${todo.jiraKey || todoId}:`, err.message);
  }

  // ── Execute column trigger ────────────────────────────────────────────────
  const trigger = targetCol.trigger || targetCol.onEnter;
  if (trigger) {
    try {
      await executeTrigger({
        trigger,
        agent,
        todo,
        toColumn,
        fromColumn,
        agentManager,
        io,
      });
    } catch (err) {
      console.error(`[Workflow] Trigger failed for column "${toColumn}":`, err.message);
      // Don't revert the status change – the todo is already in the new column
    }
  }

  // ── Handle special status transitions ─────────────────────────────────────
  if (toColumn === 'done' || targetCol.isFinal) {
    todo.completedAt = new Date().toISOString();
    agentManager.configManager.updateAgent(agentId, { todoList: agent.todoList });

    // If this agent has a leader, notify them
    if (agent.leaderId) {
      try {
        await notifyLeader({
          agent,
          todo,
          fromColumn,
          toColumn,
          agentManager,
          io,
        });
      } catch (err) {
        console.warn(`[Workflow] Leader notification failed:`, err.message);
      }
    }
  }

  // ── Track metrics ─────────────────────────────────────────────────────────
  if (!agent.metrics) agent.metrics = {};
  if (!agent.metrics.transitions) agent.metrics.transitions = [];
  agent.metrics.transitions.push({
    todoId,
    from: fromColumn,
    to: toColumn,
    by,
    at: new Date().toISOString(),
  });

  // Keep only last 100 transitions
  if (agent.metrics.transitions.length > 100) {
    agent.metrics.transitions = agent.metrics.transitions.slice(-100);
  }

  agentManager._saveState();

  return { success: true, todo, previousStatus };
}


// ── Trigger execution ─────────────────────────────────────────────────────
async function executeTrigger({ trigger, agent, todo, toColumn, fromColumn, agentManager, io }) {
  const triggerType = typeof trigger === 'string' ? trigger : trigger?.type;
  const triggerConfig = typeof trigger === 'object' ? trigger : {};

  if (!triggerType) {
    console.warn('[Workflow] Trigger has no type, skipping');
    return;
  }

  console.log(`[Workflow] Executing trigger "${triggerType}" for column "${toColumn}"`);

  switch (triggerType) {
    case 'run_prompt':
    case 'prompt': {
      const prompt = triggerConfig.prompt || triggerConfig.message ||
        `Task "${todo.text}" has moved to column "${toColumn}". Please process it accordingly.`;

      // Send as a message to the agent
      await agentManager.handleUserMessage(agent.id, prompt, {
        source: 'workflow',
        triggerColumn: toColumn,
        todoId: todo.id,
      });
      break;
    }

    case 'assign': {
      // Assign the todo to a specific agent
      const targetAgentId = triggerConfig.agentId || triggerConfig.target;
      if (targetAgentId) {
        todo.assignee = targetAgentId;
        agentManager.configManager.updateAgent(agent.id, { todoList: agent.todoList });
        console.log(`[Workflow] Assigned todo to agent ${targetAgentId}`);
      }
      break;
    }

    case 'notify': {
      // Emit a notification event
      if (io) {
        io.emit('workflow:notification', {
          type: 'transition',
          agentId: agent.id,
          agentName: agent.name,
          todoId: todo.id,
          todoText: todo.text,
          from: fromColumn,
          to: toColumn,
          message: triggerConfig.message || `Task moved to ${toColumn}`,
        });
      }
      break;
    }

    case 'auto_advance': {
      // Automatically move to the next column after a delay
      const delay = triggerConfig.delay || 0;
      const nextCol = triggerConfig.nextColumn;
      if (nextCol) {
        setTimeout(() => {
          queueTransition({
            agentId: agent.id,
            todoId: todo.id,
            fromColumn: toColumn,
            toColumn: nextCol,
            by: 'system',
            agentManager,
            io,
          });
        }, delay);
      }
      break;
    }

    case 'webhook': {
      // Call an external webhook
      const url = triggerConfig.url;
      if (url) {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'transition',
              agentId: agent.id,
              todoId: todo.id,
              from: fromColumn,
              to: toColumn,
            }),
          });
        } catch (err) {
          console.error(`[Workflow] Webhook failed:`, err.message);
        }
      }
      break;
    }

    default:
      console.warn(`[Workflow] Unknown trigger type: ${triggerType}`);
  }
}


// ── Leader notification ─────────────────────────────────────────────────────
async function notifyLeader({ agent, todo, fromColumn, toColumn, agentManager, io }) {
  const leader = agentManager.agents?.find(a => a.id === agent.leaderId);
  if (!leader) return;

  const message = `Task completed: "${todo.text}" moved from ${fromColumn} → ${toColumn} by ${agent.name}.`;

  // Send notification to leader via socket
  if (io) {
    io.emit('leader:notification', {
      leaderId: leader.id,
      agentId: agent.id,
      agentName: agent.name,
      todoId: todo.id,
      todoText: todo.text,
      fromColumn,
      toColumn,
      message,
    });
  }

  // Optionally send as a message to the leader agent
  try {
    await agentManager.handleUserMessage(leader.id, message, {
      source: 'workflow',
      type: 'task_completed',
      agentId: agent.id,
      todoId: todo.id,
    });
  } catch (err) {
    console.warn(`[Workflow] Failed to message leader:`, err.message);
  }
}