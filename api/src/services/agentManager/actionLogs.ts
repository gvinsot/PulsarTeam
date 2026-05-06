// ─── Action Logs & Execution Log ────────────────────────────────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent, saveTaskToDb } from '../database.js';

/** @this {import('./index.js').AgentManager} */
export const actionLogsMethods = {

  addActionLog(this: any, agentId: string, type: string, message: string, errorDetail: any = null): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const now = new Date();

    if (agent.actionLogs.length > 0) {
      const lastLog = agent.actionLogs[agent.actionLogs.length - 1];
      if (!lastLog.durationMs) {
        lastLog.durationMs = now.getTime() - new Date(lastLog.timestamp).getTime();
      }
    }

    // Find the current active task for this agent
    let taskId: string | null = null;
    let taskTitle: string | null = null;
    const ownTask = this._getAgentTasks(agentId).find((t: any) => this._isActiveTaskStatus(t.status) && (!t.assignee || t.assignee === agentId));
    if (ownTask) {
      taskId = ownTask.id;
      taskTitle = ownTask.text?.slice(0, 200) || null;
    } else {
      for (const [otherId] of this.agents) {
        const delegated = this._getAgentTasks(otherId).find((t: any) => this._isActiveTaskStatus(t.status) && t.assignee === agentId);
        if (delegated) { taskId = delegated.id; taskTitle = delegated.text?.slice(0, 200) || null; break; }
      }
    }

    const entry = {
      id: uuidv4(),
      type,
      message,
      error: errorDetail,
      taskId: taskId || null,
      taskTitle: taskTitle || null,
      timestamp: now.toISOString()
    };

    agent.actionLogs.push(entry);
    if (agent.actionLogs.length > 200) {
      agent.actionLogs = agent.actionLogs.slice(-200);
    }

    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return entry;
  },

  clearActionLogs(this: any, agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.actionLogs = [];
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  _saveExecutionLog(this: any, creatorAgentId: string, taskId: string, executorId: string, startMsgIdx: number, startedAt: string, success: boolean = true, actionMode: string = 'execute'): void {
    const executor = this.agents.get(executorId);
    const creatorAgent = this.agents.get(creatorAgentId);
    if (!executor || !creatorAgent) return;

    const task = this._getAgentTasks(creatorAgentId).find((t: any) => t.id === taskId);
    if (!task) return;

    const rawMessages = executor.conversationHistory.slice(startMsgIdx);

    const executionMessages = rawMessages.map((m: any) => {
      const entry: any = {
        role: m.role,
        content: m.content || '',
        timestamp: m.timestamp,
      };
      if (m.type) entry.type = m.type;
      if (m.toolResults) entry.toolResults = m.toolResults;
      return entry;
    });

    if (!task.history) task.history = [];
    task.history.push({
      type: 'execution',
      mode: actionMode,
      at: new Date().toISOString(),
      by: executor.name,
      startedAt,
      success,
      messages: executionMessages,
    });

    saveTaskToDb({ ...task, agentId: creatorAgentId });
    this._emit('task:updated', { agentId: creatorAgentId, task: { ...task, agentId: creatorAgentId } });
  },
};
