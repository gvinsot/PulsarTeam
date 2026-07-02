// ─── Action Logs & Execution Log ────────────────────────────────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent, saveTaskToDb, getTaskById, getTasksByAssignee } from '../database.js';

/** @this {import('./index.js').AgentManager} */
export const actionLogsMethods = {

  async addActionLog(this: any, agentId: string, type: string, message: string, errorDetail: any = null): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const now = new Date();

    if (agent.actionLogs.length > 0) {
      const lastLog = agent.actionLogs[agent.actionLogs.length - 1];
      if (!lastLog.durationMs) {
        lastLog.durationMs = now.getTime() - new Date(lastLog.timestamp).getTime();
      }
    }

    const entry: any = {
      id: uuidv4(),
      type,
      message,
      error: errorDetail,
      taskId: null,
      taskTitle: null,
      timestamp: now.toISOString()
    };

    agent.actionLogs.push(entry);
    if (agent.actionLogs.length > 200) {
      agent.actionLogs = agent.actionLogs.slice(-200);
    }

    // Push + persist + emit synchronously (before the first await) so callers
    // that don't await — e.g. setStatus, which flushes right after — observe the
    // entry immediately.
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));

    // Best-effort: attach the agent's current active task (assignee = agent, or
    // its own unassigned task). DB-sourced now that there is no in-memory store;
    // patch the entry + re-emit only when one is found.
    try {
      const active = (await getTasksByAssignee(agentId)).find((t: any) => this._isActiveTaskStatus(t.status));
      if (active && !entry.taskId) {
        entry.taskId = active.id;
        entry.taskTitle = active.text?.slice(0, 200) || null;
        saveAgent(agent);
        this._emit('agent:updated', this._sanitize(agent));
      }
    } catch { /* best-effort task linkage */ }

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

  async _saveExecutionLog(this: any, creatorAgentId: string, taskId: string, executorId: string, startMsgIdx: number, startedAt: string, success: boolean = true, actionMode: string = 'decide'): Promise<void> {
    const executor = this.agents.get(executorId);
    const creatorAgent = this.agents.get(creatorAgentId);
    if (!executor || !creatorAgent) return;

    const task = await getTaskById(taskId);
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

    await saveTaskToDb({ ...task, agentId: creatorAgentId });
    this._emit('task:updated', { agentId: creatorAgentId, task: { ...task, agentId: creatorAgentId } });
  },
};
