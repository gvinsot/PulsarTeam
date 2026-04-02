// ─── Workflow: _evaluateCondition, agentHasActiveTask, _checkAutoRefine,
//     _validTransition, _recheckConditionalTransitions ─────────────────────────
import { saveAgent, saveTaskToDb } from '../database.js';
import { processTransition } from '../transitionProcessor.js';
import { getWorkflowForBoard, getAllBoardWorkflows } from '../configManager.js';

/** @this {import('./index.js').AgentManager} */
export const workflowMethods = {

  _evaluateCondition(cond, task) {
    const assigneeAgent = task.assignee ? this.agents.get(task.assignee) : null;
    let fieldValue;
    switch (cond.field) {
      case 'creator_status': case 'owner_status': fieldValue = assigneeAgent?.status || 'none'; break;
      case 'creator_enabled': case 'owner_enabled': fieldValue = assigneeAgent ? (assigneeAgent.enabled !== false ? 'true' : 'false') : 'false'; break;
      case 'assignee_status': fieldValue = assigneeAgent?.status || 'none'; break;
      case 'assignee_enabled': fieldValue = assigneeAgent ? (assigneeAgent.enabled !== false ? 'true' : 'false') : 'false'; break;
      case 'assignee_role': fieldValue = assigneeAgent?.role || ''; break;
      case 'task_has_assignee': fieldValue = task.assignee ? 'true' : 'false'; break;
      case 'idle_agent_available': {
        const role = cond.value;
        const found = [...this.agents.values()].some(a =>
          a.status === 'idle' && a.enabled !== false && (!role || a.role === role)
        );
        fieldValue = found ? 'true' : 'false';
        const result = cond.operator === 'neq' ? !found : found;
        if (result) console.log(`[Workflow] Condition: idle_agent_available role="${role}" project="${task.project}" => true`);
        return result;
      }
      default: fieldValue = '';
    }
    const result = cond.operator === 'neq' ? fieldValue !== cond.value : fieldValue === cond.value;
    if (result) {
      console.log(`[Workflow] Condition: ${cond.field} ${cond.operator} "${cond.value}" => fieldValue="${fieldValue}" result=true (assignee=${task.assignee || 'none'}, agentName=${assigneeAgent?.name || 'N/A'}, agentStatus=${assigneeAgent?.status || 'N/A'})`);
    }
    return result;
  },

  agentHasActiveTask(agentId, excludeTaskId = null) {
    for (const [creatorId, agent] of this.agents) {
      if (!agent.todoList) continue;
      for (const task of agent.todoList) {
        if (!this._isActiveTaskStatus(task.status)) continue;
        if (excludeTaskId && task.id === excludeTaskId) continue;
        if (creatorId === agentId) return true;
        if (task.assignee === agentId) return true;
      }
    }
    return false;
  },

  _validTransition(t) {
    return t && t.from && t.trigger && Array.isArray(t.actions);
  },

  _columnExists(workflow, columnId) {
    if (!workflow?.columns || !Array.isArray(workflow.columns)) return false;
    return workflow.columns.some(c => c.id === columnId);
  },

  _checkAutoRefine(task, { by = null } = {}) {
    console.log(`[Workflow] _checkAutoRefine: status="${task.status}" text="${(task.text || '').slice(0, 60)}" agentId="${task.agentId}" by="${by || 'unknown'}"`);

    if (task.status === 'error') {
      console.log(`[Workflow] _checkAutoRefine: skipping — task is in error status`);
      return;
    }

    getWorkflowForBoard(task.boardId).then(async (workflow) => {
      const creatorAgentForOwner = this.agents.get(task.agentId);
      const boardUserId = workflow.userId || null;
      const taskOwnerId = boardUserId || creatorAgentForOwner?.ownerId || null;

      // Auto-assign by column role
      const currentColumn = workflow.columns?.find(c => c.id === task.status);
      const colIndex = workflow.columns?.findIndex(c => c.id === task.status) ?? -1;
      const isFirstOrLast = colIndex === 0 || colIndex === (workflow.columns?.length || 0) - 1;
      if (currentColumn?.autoAssignRole && !isFirstOrLast) {
        const candidates = Array.from(this.agents.values()).filter(a =>
          a.enabled !== false &&
          a.role === currentColumn.autoAssignRole &&
          (!taskOwnerId || !a.ownerId || a.ownerId === taskOwnerId)
        );
        let autoAgent = null;
        let minTasks = Infinity;
        for (const candidate of candidates) {
          let count = 0;
          for (const [, creator] of this.agents) {
            for (const t of creator.todoList || []) {
              if (t.id === task.id) continue;
              if (t.assignee === candidate.id || (!t.assignee && creator.id === candidate.id)) {
                count++;
              }
            }
          }
          if (count < minTasks) {
            minTasks = count;
            autoAgent = candidate;
          }
        }
        if (autoAgent) {
          console.log(`[Auto-Assign] Task "${(task.text || '').slice(0, 60)}" assigned to "${autoAgent.name}" (${minTasks} tasks in column, role: ${currentColumn.autoAssignRole})`);
          task.assignee = autoAgent.id;
          const creatorAgent = this.agents.get(task.agentId);
          const actualTask = creatorAgent?.todoList?.find(t => t.id === task.id);
          if (actualTask) {
            actualTask.assignee = autoAgent.id;
            saveTaskToDb({ ...actualTask, agentId: task.agentId });
          }
          this.io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task });
        }
      }

      const matchingTransitions = workflow.transitions
        .filter(t => this._validTransition(t))
        .filter(t => t && t.from === task.status);

      const originalStatus = task.status;
      let transitionsRan = 0;

      for (const transition of matchingTransitions) {
        if (task.status !== originalStatus) {
          console.log(`[Workflow] Task moved from "${originalStatus}" to "${task.status}" — stopping remaining transitions`);
          break;
        }

        if (transition.trigger === 'jira_ticket') continue;

        if (transition.trigger === 'condition') {
          const conditions = transition.conditions || [];
          if (conditions.length === 0) continue;
          const allMet = conditions.every(cond => this._evaluateCondition(cond, task));
          if (!allMet) {
            console.log(`[Workflow] Condition not met for transition from="${transition.from}" (${conditions.length} conditions)`);
            continue;
          }
          console.log(`[Workflow] All ${conditions.length} conditions met for transition from="${transition.from}"`);
        }

        const actions = transition.actions || [];
        console.log(`[Workflow] Transition matched: from="${transition.from}" trigger="${transition.trigger}" (${actions.length} action(s))`);
        transitionsRan++;

        // Resume from the last completed action if this is a retry
        const rawIdx = task.completedActionIdx ?? task._completedActionIdx;
        const startActionIdx = (typeof rawIdx === 'number') ? rawIdx + 1 : 0;
        if (startActionIdx > 0) {
          console.log(`[Workflow] Resuming action chain from index ${startActionIdx}/${actions.length} for "${(task.text || '').slice(0, 60)}"`);
        }

        let stopActionChain = false;
        for (let actionIdx = startActionIdx; actionIdx < actions.length; actionIdx++) {
          const action = actions[actionIdx];
          if (action.type === 'assign_agent_individual') {
            // Assign to a specific agent (or unassign if agentId is empty/null)
            const targetAgentId = action.agentId || null;
            const creatorAgent = this.agents.get(task.agentId);
            const actualTask = creatorAgent?.todoList?.find(t => t.id === task.id);
            if (actualTask) {
              const previousAssignee = actualTask.assignee;
              actualTask.assignee = targetAgentId;
              if (!actualTask.history) actualTask.history = [];
              actualTask.history.push({ status: actualTask.status, at: new Date().toISOString(), by: 'workflow', type: 'reassign', assignee: targetAgentId });
              saveTaskToDb({ ...actualTask, agentId: task.agentId });
              task.assignee = targetAgentId;
              this.io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task: actualTask });
              const targetName = targetAgentId ? (this.agents.get(targetAgentId)?.name || targetAgentId) : 'none';
              console.log(`[Workflow] Action: individually assigned "${(task.text || '').slice(0, 60)}" to "${targetName}" (was: ${previousAssignee || 'none'})`);
            }

          } else if (action.type === 'assign_agent') {
            const candidates = Array.from(this.agents.values()).filter(a =>
              a.enabled !== false &&
              (a.role || '').toLowerCase() === (action.role || '').toLowerCase() &&
              (!taskOwnerId || !a.ownerId || a.ownerId === taskOwnerId)
            );
            let agent = null;
            let minTasks = Infinity;
            for (const c of candidates) {
              let count = 0;
              for (const [, creator] of this.agents) {
                for (const t of creator.todoList || []) {
                  if (t.id === task.id) continue;
                  if (t.assignee === c.id || (!t.assignee && creator.id === c.id)) count++;
                }
              }
              if (count < minTasks) { minTasks = count; agent = c; }
            }
            if (agent) {
              task.assignee = agent.id;
              const creatorAgent = this.agents.get(task.agentId);
              const actualTask = creatorAgent?.todoList?.find(t => t.id === task.id);
              if (actualTask) {
                actualTask.assignee = agent.id;
                saveTaskToDb({ ...actualTask, agentId: task.agentId });
              }
              this.io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task });
              console.log(`[Workflow] Action: assigned "${(task.text || '').slice(0, 60)}" to "${agent.name}" (${minTasks} total tasks, role: ${action.role})`);
            } else {
              console.log(`[Workflow] Action: no idle agent with role "${action.role}" — skipping assign`);
            }

          } else if (action.type === 'run_agent') {
            const enrichedTask = {
              ...task,
              _boardUserId: taskOwnerId,
              _transition: {
                agent: action.role || '',
                mode: action.mode || 'execute',
                instructions: action.instructions || '',
                to: action.targetStatus || null,
              }
            };
            console.log(`[Workflow] Action: run_agent mode="${action.mode}" role="${action.role}" target="${action.targetStatus}"`);
            try {
              const result = await processTransition(enrichedTask, this, this.io);
              if (result?.skipped) {
                const actualTaskForFlag = this.agents.get(task.agentId)?.todoList?.find(t => t.id === task.id);
                if (actualTaskForFlag) {
                  actualTaskForFlag._pendingOnEnter = actualTaskForFlag.status;
                  // Save which action index to resume from on retry
                  const resumeIdx = actionIdx > 0 ? actionIdx - 1 : undefined;
                  actualTaskForFlag._completedActionIdx = resumeIdx;
                  actualTaskForFlag.completedActionIdx = resumeIdx;
                  console.log(`[Workflow] Flagged task "${(task.text || '').slice(0, 60)}" for on_enter retry at action ${actionIdx}/${actions.length} (${result.skipped})`);
                  saveTaskToDb({ ...actualTaskForFlag, agentId: task.agentId });
                }
                stopActionChain = true;
                break;
              }
              if (result?.executed) {
                const actualTaskForClear = this.agents.get(task.agentId)?.todoList?.find(t => t.id === task.id);
                if (actualTaskForClear) {
                  // Track completed action index for chain resume
                  actualTaskForClear._completedActionIdx = actionIdx;
                  actualTaskForClear.completedActionIdx = actionIdx;
                  if (actualTaskForClear._pendingOnEnter === originalStatus) {
                    delete actualTaskForClear._pendingOnEnter;
                  }
                  saveTaskToDb({ ...actualTaskForClear, agentId: task.agentId });
                }
              }
              const freshAgent = this.agents.get(task.agentId);
              const freshTask = freshAgent?.todoList?.find(t => t.id === task.id);
              if (freshTask) {
                task.text = freshTask.text;
                task.title = freshTask.title;
                task.status = freshTask.status;
                task.assignee = freshTask.assignee;
              }
            } catch (err) {
              console.error(`[Workflow] Error in run_agent for "${(task.text || '').slice(0, 60)}":`, err.message);
            }
            if (task.status === 'error') {
              console.log(`[Workflow] Task in error after run_agent — stopping action chain`);
              return;
            }
            if (action.mode === 'execute' && task.status !== originalStatus) {
              console.log(`[Workflow] Task moved to "${task.status}" after execute — stopping action chain`);
              stopActionChain = true;
              break;
            }

          } else if (action.type === 'change_status') {
            if (action.target && action.target !== task.status) {
              if (!this._columnExists(workflow, action.target)) {
                console.warn(`[Workflow] Action: change_status SKIPPED — target column "${action.target}" does not exist for "${(task.text || '').slice(0, 60)}"`);
                break;
              }
              // Clean up chain resume index BEFORE change_status — the new column's
              // on_enter transition must start fresh, not resume from this chain's index
              const taskBeforeMove = this.agents.get(task.agentId)?.todoList?.find(t => t.id === task.id);
              if (taskBeforeMove) {
                delete taskBeforeMove._completedActionIdx;
                taskBeforeMove.completedActionIdx = null;
                delete taskBeforeMove._pendingOnEnter;
                saveTaskToDb({ ...taskBeforeMove, agentId: task.agentId });
              }
              console.log(`[Workflow] Action: change_status "${task.status}" -> "${action.target}" for "${(task.text || '').slice(0, 60)}"`);
              const result = this.setTaskStatus(task.agentId, task.id, action.target, { skipAutoRefine: false, by: 'workflow' });
              if (!result) {
                console.warn(`[Workflow] Action: change_status BLOCKED (guard) for "${(task.text || '').slice(0, 60)}"`);
              }
              stopActionChain = true;
              break;
            }
          }
        }

        // Clean up chain resume index when all actions completed or chain stopped normally
        const taskAfterChain = this.agents.get(task.agentId)?.todoList?.find(t => t.id === task.id);
        if (taskAfterChain && (typeof taskAfterChain._completedActionIdx === 'number' || typeof taskAfterChain.completedActionIdx === 'number')) {
          delete taskAfterChain._completedActionIdx;
          taskAfterChain.completedActionIdx = null;
          saveTaskToDb({ ...taskAfterChain, agentId: task.agentId });
        }

        if (stopActionChain) continue;
      }

      if (transitionsRan === 0) {
        console.log(`[Workflow] No matching transition for status="${task.status}" (${matchingTransitions.length} candidates checked)`);
      }
    }).catch(err => {
      console.error(`[Workflow] Failed to load workflow:`, err.message);
    });
  },

  _recheckConditionalTransitions() {
    const LOCK_TTL_MS = 2 * 60 * 1000;
    if (this._conditionProcessing) {
      const now = Date.now();
      for (const [key, timestamp] of this._conditionProcessing) {
        if (now - timestamp > LOCK_TTL_MS) {
          console.warn(`[Workflow] Evicting stale condition lock: ${key} (age: ${Math.round((now - timestamp) / 1000)}s)`);
          this._conditionProcessing.delete(key);
        }
      }
    }

    getAllBoardWorkflows().then(async (boardWorkflows) => {
      const boardTransMap = new Map();
      const boardWorkflowMap = new Map();
      for (const { boardId, workflow } of boardWorkflows) {
        const condTransitions = workflow.transitions
          .filter(t => this._validTransition(t))
          .filter(t => {
            if (!t) return false;
            if (t.trigger === 'condition' && (t.conditions || []).length > 0) return true;
            if (t.trigger === 'on_enter') return true;
            return false;
          });
        if (condTransitions.length > 0) {
          boardTransMap.set(boardId, condTransitions);
          boardWorkflowMap.set(boardId, workflow);
        }
      }

      if (boardTransMap.size === 0) return;

      for (const [agentId, agent] of this.agents) {
        if (!agent.todoList) continue;
        for (const task of agent.todoList) {
          if (task.status === 'error') continue;

          const condTransitions = boardTransMap.get(task.boardId) || (boardTransMap.size === 1 ? [...boardTransMap.values()][0] : []);
          const matching = condTransitions.filter(t => t.from === task.status);
          if (matching.length === 0) continue;

          if (task.assignee && !task._pendingOnEnter) {
            const assigneeAgent = this.agents.get(task.assignee);
            if (assigneeAgent && assigneeAgent.status === 'busy') continue;
          }

          for (const transition of matching) {
            if (transition.trigger === 'on_enter' && task._pendingOnEnter !== task.status) continue;

            const conditions = transition.conditions || [];
            const allMet = conditions.length === 0 || conditions.every(cond =>
              this._evaluateCondition(cond, { ...task, agentId })
            );
            if (!allMet) continue;

            const lockKey = `${agentId}:${task.id}`;
            if (!this._conditionProcessing) this._conditionProcessing = new Map();
            if (this._conditionProcessing.has(lockKey)) continue;
            this._conditionProcessing.set(lockKey, Date.now());

            const isOnEnterRetry = transition.trigger === 'on_enter';

            // For on_enter retries, re-run the full action chain via _checkAutoRefine
            // so that _completedActionIdx is respected and subsequent actions (e.g.
            // change_status) are executed after the skipped action completes.
            if (isOnEnterRetry) {
              console.log(`[Workflow] on_enter retry: re-running full action chain for "${(task.text || '').slice(0, 60)}" in status="${task.status}" (completedActionIdx=${task.completedActionIdx ?? task._completedActionIdx ?? 'none'})`);
              this._checkAutoRefine({ ...task, agentId }, { by: 'on-enter-retry' });
              this._conditionProcessing.delete(lockKey);
              break;
            }

            console.log(`[Workflow] Condition re-check: all conditions met for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`);

            const actions = transition.actions || [];
            let didReturn = false;
            for (const action of actions) {
              if (action.type === 'assign_agent') {
                const boardWf = await getWorkflowForBoard(task.boardId);
                const taskOwnerId = boardWf.userId || agent.ownerId || null;
                const candidates = Array.from(this.agents.values()).filter(a =>
                  a.enabled !== false &&
                  (a.role || '').toLowerCase() === (action.role || '').toLowerCase() &&
                  (!taskOwnerId || !a.ownerId || a.ownerId === taskOwnerId)
                );
                let foundAgent = null;
                let minTasks = Infinity;
                for (const c of candidates) {
                  let count = 0;
                  for (const [, cr] of this.agents) {
                    for (const t of cr.todoList || []) {
                      if (t.id === task.id) continue;
                      if (t.assignee === c.id || (!t.assignee && cr.id === c.id)) count++;
                    }
                  }
                  if (count < minTasks) { minTasks = count; foundAgent = c; }
                }
                if (foundAgent) {
                  const actualTask = agent.todoList.find(t => t.id === task.id);
                  if (actualTask) {
                    actualTask.assignee = foundAgent.id;
                    saveTaskToDb({ ...actualTask, agentId });
                  }
                  this.io?.to(`agent:${agentId}`)?.emit('task:updated', { agentId, task: { ...task, assignee: foundAgent.id } });
                  console.log(`[Workflow] Condition re-check: assigned "${(task.text || '').slice(0, 60)}" to "${foundAgent.name}" (${minTasks} tasks in column, role: ${action.role})`);
                }
              } else if (action.type === 'run_agent') {
                const boardWfForRun = await getWorkflowForBoard(task.boardId);
                const runOwnerId = boardWfForRun.userId || agent.ownerId || null;
                const enrichedTask = {
                  ...task, agentId,
                  _boardUserId: runOwnerId,
                  _transition: {
                    agent: action.role || '',
                    mode: action.mode || 'execute',
                    instructions: action.instructions || '',
                    to: action.targetStatus || null,
                    rejectTarget: action.rejectTarget || null,
                  }
                };
                console.log(`[Workflow] Condition re-check: run_agent mode="${action.mode}" role="${action.role}"`);
                processTransition(enrichedTask, this, this.io)
                  .catch(err => console.error(`[Workflow] Condition re-check error:`, err.message))
                  .finally(() => {
                    this._conditionProcessing.delete(lockKey);
                  });
                didReturn = true;
                break;
              } else if (action.type === 'change_status') {
                if (action.target && action.target !== task.status) {
                  const taskWorkflow = boardWorkflowMap.get(task.boardId) || (boardWorkflowMap.size === 1 ? [...boardWorkflowMap.values()][0] : null);
                  if (!this._columnExists(taskWorkflow, action.target)) {
                    console.warn(`[Workflow] Condition re-check: change_status SKIPPED — target column "${action.target}" does not exist for "${(task.text || '').slice(0, 60)}"`);
                    this._conditionProcessing.delete(lockKey);
                    didReturn = true;
                    break;
                  }
                  console.log(`[Workflow] Condition re-check: change_status "${task.status}" -> "${action.target}" for "${(task.text || '').slice(0, 60)}"`);
                  const result = this.setTaskStatus(agentId, task.id, action.target, { skipAutoRefine: false, by: 'workflow' });
                  if (!result) {
                    console.warn(`[Workflow] Condition re-check: change_status BLOCKED (guard) for "${(task.text || '').slice(0, 60)}"`);
                  }
                  this._conditionProcessing.delete(lockKey);
                  didReturn = true;
                  break;
                }
              }
            }
            if (!didReturn) this._conditionProcessing.delete(lockKey);
            break;
          }
        }
      }
    }).catch(err => {
      console.error(`[Workflow] Condition re-check error:`, err.message);
    });
  },
};