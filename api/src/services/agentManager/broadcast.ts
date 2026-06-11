// ─── Broadcast & Handoff ────────────────────────────────────────────────────
import { transferUserFiles } from './helpers.js';

/** @this {import('./index.js').AgentManager} */
export const broadcastMethods = {

  async broadcastMessage(this: any, message: string, streamCallback: any, agentIdFilter: Set<string> | null = null): Promise<any[]> {
    let agents = Array.from(this.agents.values()).filter((a: any) => a.enabled !== false);
    if (agentIdFilter) {
      agents = agents.filter((a: any) => agentIdFilter.has(a.id));
    }
    const results: any[] = [];

    const promises = agents.map(async (agent: any) => {
      try {
        const response = await this.sendMessage(
          agent.id,
          message,
          (chunk: any) => streamCallback && streamCallback(agent.id, chunk)
        );
        results.push({ agentId: agent.id, agentName: agent.name, response, error: null });
      } catch (err: any) {
        results.push({ agentId: agent.id, agentName: agent.name, response: null, error: err.message });
      }
    });

    await Promise.all(promises);
    return results;
  },

  async handoff(this: any, fromId: string, toId: string, context: string, streamCallback: any): Promise<any> {
    const fromAgent = this.agents.get(fromId);
    const toAgent = this.agents.get(toId);
    if (!fromAgent || !toAgent) throw new Error('Agent not found');

    const handoffMessage = `[HANDOFF from ${fromAgent.name}]: ${context}\n\nPrevious conversation context:\n${
      fromAgent.conversationHistory.slice(-10).map((m: any) => `${m.role}: ${m.content}`).join('\n')
    }`;

    this._emit('agent:handoff', {
      from: { id: fromId, name: fromAgent.name, project: fromAgent.project || null },
      to: { id: toId, name: toAgent.name, project: toAgent.project || null },
      context
    });

    const fileTransferResult = await transferUserFiles(fromId, toId);
    let fullMessage = handoffMessage;
    if (!fileTransferResult.success) {
      console.warn(`⚠️ [Handoff] File transfer from ${fromAgent.name} to ${toAgent.name} failed: ${fileTransferResult.message}`);
      fullMessage += `\n\n[WARNING] File transfer failed: ${fileTransferResult.message}`;
    }

    const response = await this.sendMessage(toId, fullMessage, streamCallback);

    return {
      ...response,
      fileTransfer: fileTransferResult
    };
  },
};
