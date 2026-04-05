// ─── Chat: sendMessage, _cleanMarkdown, _buildSystemPrompt, _assembleMessages,
//     _streamAndContinue, _processPostResponseActions ──
import { createProvider } from '../llmProviders.js';
import { saveAgent, saveTaskToDb } from '../database.js';
import { TOOL_DEFINITIONS } from '../agentTools.js';
import { getProjectGitUrl } from '../githubProjects.js';
import { simplifyMcpSchema } from './helpers.js';
import { AgentManager } from './index.js';

/** @this {AgentManager} */
export const chatMethods = {

  // ─── Chat ───────────────────────────────────────────────────────────
  async sendMessage(id, userMessage, streamCallback, delegationDepth = 0, messageMeta = null) {
    const isTopLevel = delegationDepth === 0 && !messageMeta;
    if (isTopLevel) {
      if (this._chatLocks.has(id)) {
        const agent = this.agents.get(id);
        const lockedMessage = this._chatLocks.get(id);
        if (!agent || agent.status !== 'busy') {
          console.warn(`⚠️ Stale chat lock for agent ${id} (status: ${agent?.status}) — auto-clearing`);
          this._chatLocks.delete(id);
        } else if (lockedMessage === userMessage) {
          return null;
        } else {
          throw new Error('Agent is already processing a message');
        }
      }
      this._chatLocks.set(id, userMessage);
    }

    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);

    const agent = this.agents.get(id);
    if (!agent) {
      if (isTopLevel) this._chatLocks.delete(id);
      throw new Error('Agent not found');
    }

    this.setStatus(id, 'busy');
    // Only reset thinking for top-level or delegation messages, NOT for
    // recursive tool-result / nudge calls — those are continuations of the
    // same thought process and resetting causes the frontend to flash and
    // the LLM to lose its reasoning context.
    if (!messageMeta || messageMeta.type === 'delegation-task') {
      agent.currentThinking = '';
    }

    if (messageMeta?.type === 'delegation-task') {
      agent.currentTask = (userMessage || '').replace(/^\[TASK from [^\]]+\]:\s*/i, '').slice(0, 200) || null;
    } else if (delegationDepth === 0 && !messageMeta) {
      agent.currentTask = (userMessage || '').slice(0, 200) || null;
    }
    this._emit('agent:status', { id, status: 'busy', project: agent.project || null, currentTask: agent.currentTask || null });

    if (this.executionManager && agent.project && !this.executionManager.getFileTree(id)) {
      try {
        // Bind agent to the correct execution provider based on LLM config
        const earlyLlm = this.resolveLlmConfig(agent);
        const providerType = earlyLlm.managesContext ? 'coder' : 'sandbox';
        this.executionManager.bindAgent(id, providerType, { ownerId: agent.ownerId || null });

        const gitUrl = await getProjectGitUrl(agent.project);
        if (gitUrl) {
          // ensureProject handles both sandbox and coder-service cloning
          await this.executionManager.ensureProject(id, agent.project, gitUrl);
          if (!this.executionManager.getFileTree(id)) {
            // Only refresh if the background generation hasn't completed yet
            await this.executionManager.refreshFileTree(id);
          }
        }
      } catch (err) {
        console.warn(`⚠️  [Execution] Early init for file tree failed: ${err.message}`);
      }
    }

    const messages = [];
    const systemContent = await this._buildSystemPrompt(agent, id, delegationDepth);
    messages.push({ role: 'system', content: systemContent });

    const { managesContext, isTaskExecution, activeTaskId } = await this._assembleMessages(agent, messages, systemContent, userMessage, delegationDepth, messageMeta, streamCallback);

    const historyEntry = {
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString()
    };
    if (messageMeta) {
      historyEntry.type = messageMeta.type;
      if (messageMeta.toolResults) historyEntry.toolResults = messageMeta.toolResults;
      if (messageMeta.delegationResults) historyEntry.delegationResults = messageMeta.delegationResults;
      if (messageMeta.fromAgent) historyEntry.fromAgent = messageMeta.fromAgent;
    }
    agent.conversationHistory.push(historyEntry);

    let fullResponse = '';
    let toolsExecuted = false;

    try {
      const llmConfig = this.resolveLlmConfig(agent);
      const streamResult = await this._streamAndContinue(agent, id, messages, llmConfig, streamCallback, abortController, delegationDepth, activeTaskId);
      fullResponse = streamResult.fullResponse;

      agent.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
        timestamp: new Date().toISOString()
      });

      agent.metrics.totalMessages += 1;
      agent.metrics.lastActiveAt = new Date().toISOString();
      agent.currentThinking = '';
      saveAgent(agent);

      const responseForParsing = this._cleanMarkdown(fullResponse);
      toolsExecuted = true;
      const actionResult = await this._processPostResponseActions(agent, id, responseForParsing, fullResponse, streamCallback, delegationDepth, messageMeta);
      if (actionResult.earlyReturn !== null) {
        this.setStatus(id, 'idle');
        return actionResult.earlyReturn;
      }

      this.setStatus(id, 'idle');
      this.abortControllers.delete(id);
      if (isTopLevel) this._chatLocks.delete(id);
      return fullResponse;
    } catch (err) {
      // ── Rate limit: mark task as error and schedule retry ──
      if (err.isRateLimit) {
        const delayMs = Math.max(0, err.retryAt - Date.now());
        console.log(`🕐 [Rate Limit] "${agent.name}": ${err.message} — retry in ${Math.round(delayMs / 60000)}min`);
        if (streamCallback) streamCallback(`\n⏸️ *${err.message}. Task will auto-retry at ${err.resetLabel} + 5min.*\n`);
        this.addActionLog(id, 'error', `Rate limit reached — resets at ${err.resetLabel}`, err.message);

        const activeTask = this._getAgentTasks(id).find(t => this._isActiveTaskStatus(t.status));
        if (activeTask) {
          activeTask.error = `Rate limit reached — resets at ${err.resetLabel}`;
          this.setTaskStatus(id, activeTask.id, 'error', { skipAutoRefine: true, by: 'rate-limit' });
          console.log(`🕐 [Rate Limit] Task "${activeTask.text.slice(0, 60)}" set to error`);
        }

        setTimeout(() => {
          console.log(`🕐 [Rate Limit] Retry timer fired for "${agent.name}" — triggering re-check`);
          this._recheckConditionalTransitions();
        }, delayMs);

        this.setStatus(id, 'idle');
        this.abortControllers.delete(id);
        if (isTopLevel) this._chatLocks.delete(id);
        return fullResponse;
      }

      // ── Reactive compaction: context exceeded → compact and retry once (task mode only) ──
      // In chat mode, full history must be preserved — context errors propagate to the user.
      if (this._isContextExceededError(err.message) && !agent._compactionRetried && !managesContext && isTaskExecution) {
        console.log(`🗜️  [Reactive Compact] "${agent.name}": context exceeded — compacting and retrying`);
        agent._compactionRetried = true;
        this.addActionLog(id, 'warning', 'Context limit exceeded — compacting conversation and retrying');
        if (isTopLevel) this._chatLocks.delete(id);
        try {
          if (streamCallback) streamCallback(`\n⚠️ *Context limit exceeded — compacting conversation and retrying...*\n`);
          const reactiveCtxLimit = this.resolveLlmConfig(agent).contextLength || agent.contextLength || 8192;
          const reactiveKeep = Math.max(6, Math.floor(this._compactionThresholds(reactiveCtxLimit).maxRecent * 0.5));
          await this._compactHistory(agent, reactiveKeep);
          agent._compactionArmed = false;
          agent.conversationHistory.pop();
          const retryResult = await this.sendMessage(id, userMessage, streamCallback, delegationDepth, messageMeta);
          delete agent._compactionRetried;
          return retryResult;
        } catch (retryErr) {
          delete agent._compactionRetried;
          console.error(`🗜️  [Reactive Compact] "${agent.name}": retry after compaction also failed: ${retryErr.message}`);
          this.abortControllers.delete(id);
          agent.metrics.errors += 1;
          agent.currentThinking = '';
          this.setStatus(id, 'error', retryErr.message);
          saveAgent(agent);
          if (isTopLevel) this._chatLocks.delete(id);
          throw retryErr;
        }
      }

      // ── Transient stream error → retry with backoff ──
      const isUserStop = err.message === 'Agent stopped by user';
      const isAuthError = err.status === 401 || err.status === 403;
      const hasPartialToolCalls = fullResponse && /@(read_file|write_file|list_dir|search_files|run_command|append_file|mcp_call|report_error|task_execution_complete)\b/i.test(fullResponse);
      const isTransient = !isUserStop && !isAuthError && !err.isRateLimit && !this._isContextExceededError(err.message);
      const MAX_STREAM_RETRIES = 3;
      const retryCount = agent._streamRetryCount || 0;

      if (isTransient && !toolsExecuted && !hasPartialToolCalls && retryCount < MAX_STREAM_RETRIES && !abortController.signal.aborted) {
        agent._streamRetryCount = retryCount + 1;
        const delay = 2000 * Math.pow(2, retryCount);
        console.log(`🔄 [Stream Retry] "${agent.name}": ${err.message} — retry ${retryCount + 1}/${MAX_STREAM_RETRIES} in ${delay}ms`);
        this.addActionLog(id, 'warning', `Connection lost, retrying (${retryCount + 1}/${MAX_STREAM_RETRIES})`, err.message);
        if (streamCallback) streamCallback(`\n⚠️ *Connection lost, retrying (${retryCount + 1}/${MAX_STREAM_RETRIES})...*\n`);
        await new Promise(r => setTimeout(r, delay));
        agent.conversationHistory.pop();
        if (isTopLevel) this._chatLocks.delete(id);
        try {
          const retryResult = await this.sendMessage(id, userMessage, streamCallback, delegationDepth, messageMeta);
          delete agent._streamRetryCount;
          return retryResult;
        } catch (retryErr) {
          delete agent._streamRetryCount;
          this.abortControllers.delete(id);
          agent.metrics.errors += 1;
          agent.currentThinking = '';
          const isRetryUserStop = retryErr.message === 'Agent stopped by user';
          this.setStatus(id, isRetryUserStop ? 'idle' : 'error', retryErr.message);
          saveAgent(agent);
          if (isTopLevel) this._chatLocks.delete(id);
          throw retryErr;
        }
      }
      if (isTransient && (toolsExecuted || hasPartialToolCalls) && retryCount < MAX_STREAM_RETRIES) {
        console.log(`🛡️ [Stream Retry] "${agent.name}": skipping retry — ${toolsExecuted ? 'tools already executed' : 'partial response contains tool calls'}`);
        this.addActionLog(id, 'warning', 'Error after tool execution — not retrying to avoid duplicate actions', err.message);
      }
      delete agent._streamRetryCount;

      this.abortControllers.delete(id);
      agent.metrics.errors += 1;
      agent.currentThinking = '';
      this.setStatus(id, isUserStop ? 'idle' : 'error', err.message);
      saveAgent(agent);
      if (isTopLevel) this._chatLocks.delete(id);
      throw err;
    }
  },

  _cleanMarkdown(response) {
    return (response || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  },

  async _buildSystemPrompt(agent, id, delegationDepth) {
    let systemContent = `Your name is "${agent.name}".${agent.role ? ` Your role: ${agent.role}.` : ''}\n\n${agent.instructions || 'You are a helpful AI assistant.'}`;

    if (agent.isLeader && delegationDepth === 0) {
      const availableAgents = Array.from(this.agents.values())
        .filter(a => a.id !== id && a.enabled !== false)
        .map(a => {
          const statusTag = ` [${a.status}]`;
          const projectTag = a.project ? ` [project: ${a.project}]` : ' [no project]';
          const taskInfo = a.currentTask ? ` (working on: "${a.currentTask.slice(0, 60)}${a.currentTask.length > 60 ? '...' : ''}")` : '';
          return `- ${a.name} (${a.role})${statusTag}${projectTag}${taskInfo}: ${a.description || 'No description'}`;
        });

      if (availableAgents.length > 0) {
        systemContent += `\n\n--- Available Swarm Agents ---\nUse the Swarm API MCP tools to manage agents and assign tasks.\n${availableAgents.join('\n')}\n\nTo assign a task to an agent, use:\n@mcp_call(Swarm API, add_task, {"agent_name": "AgentName", "task": "task description", "project": "ProjectName"})\n\nTo check agent status:\n@mcp_call(Swarm API, get_agent_status, {"agent_name": "AgentName"})\n\nTo list all agents:\n@mcp_call(Swarm API, list_agents, {})\n\nIMPORTANT: Agents may report errors using @report_error(). When you check agent status and see errors, analyze the problem and decide whether to retry the task, reassign it to another agent, provide additional guidance, or escalate to the user.`;
      } else {
        systemContent += `\n\n--- Available Swarm Agents ---\nNo other agents are currently available in the swarm. You will need to complete tasks yourself or ask the user to create specialist agents.`;
      }

      const projectNames = await this._listAvailableProjects();
      if (projectNames.length > 0) {
        systemContent += `\n\nAvailable projects: ${projectNames.join(', ')}`;
      }
      systemContent += `\n\n⚠️ IMPORTANT: When adding tasks to agents, always specify the project so the agent works in the correct directory. Agents without a project assignment work at the workspace root and cannot access project files correctly.`;
    }

    if (agent.ragDocuments.length > 0) {
      systemContent += '\n\n--- Reference Documents ---\n';
      for (const doc of agent.ragDocuments) {
        systemContent += `\n[${doc.name}]:\n${doc.content}\n`;
      }
    }

    const agentSkills = agent.skills || [];
    const pluginMcpIds = new Set();
    if (agentSkills.length > 0 && this.skillManager) {
      const resolvedPlugins = agentSkills.map(sid => this.skillManager.getById(sid)).filter(Boolean);
      if (resolvedPlugins.length > 0) {
        systemContent += '\n\n--- Active Plugins ---\n';
        for (const plugin of resolvedPlugins) {
          systemContent += `\n[${plugin.name}]:\n${plugin.instructions}\n`;
          if (Array.isArray(plugin.mcpServerIds)) {
            plugin.mcpServerIds.forEach(id => pluginMcpIds.add(id));
          }
        }
      }
    }

    if (agentSkills.includes('skill-agents-direct-access')) {
      const askableAgents = Array.from(this.agents.values())
        .filter(a => a.id !== id && a.enabled !== false)
        .map(a => `- ${a.name} (${a.role})${a.project ? ` [project: ${a.project}]` : ''}`);
      if (askableAgents.length > 0) {
        systemContent += `\n\n--- Agents You Can Ask ---\n`;
        systemContent += `Use @ask(AgentName, "question") for quick questions.\n`;
        systemContent += askableAgents.join('\n');
      }
    }

    const directMcpIds = agent.mcpServers || [];
    const allMcpIds = [...new Set([...pluginMcpIds, ...directMcpIds])];
    if (allMcpIds.length > 0 && this.mcpManager) {
      const { tools: mcpTools, unavailable: mcpUnavailable } = await this.mcpManager.getToolsForAgent(allMcpIds, id, agent.mcpAuth || {});
      if (mcpTools.length > 0) {
        systemContent += '\n\n--- MCP Tools ---\n';
        systemContent += 'These are NOT shell commands. Do NOT use @run_command or any bash tool to call them.\n';
        systemContent += 'Call them using ONLY the @mcp_call(server, tool, {"arg": "value"}) syntax — this is the ONLY valid way.\n';
        systemContent += 'IMPORTANT: Replace <type> placeholders with ACTUAL values. Do NOT copy the type descriptions.\n';
        systemContent += 'Example: @mcp_call(MyServer, my_tool, {"name": "my-actual-value", "count": 5})\n\n';
        for (const t of mcpTools) {
          const schema = simplifyMcpSchema(t.inputSchema);
          systemContent += `@mcp_call(${t.serverName}, ${t.name}, ${schema}) — ${t.description || ''}\n`;
        }
      }
      if (mcpUnavailable.length > 0) {
        systemContent += '\n\n--- MCP Servers Unavailable ---\n';
        systemContent += 'The following MCP servers are configured but currently NOT connected.\n';
        systemContent += 'Do NOT attempt to call tools on these servers — they will fail.\n';
        systemContent += 'If the user asks you to use these tools, inform them that the MCP server is disconnected.\n\n';
        for (const u of mcpUnavailable) {
          systemContent += `- ${u.serverName}: ${u.reason}\n`;
        }
      }
    }

    const activeTasks = this._getAgentTasks(id).filter(t => this._isActiveTaskStatus(t.status) || t.status === 'error');
    const doneTasks = this._getAgentTasks(id).filter(t => t.status === 'done');
    if (activeTasks.length > 0 || doneTasks.length > 0) {
      systemContent += '\n\n--- Current Task List ---\n';
      for (const task of activeTasks) {
        const mark = this._isActiveTaskStatus(task.status) ? '~' : '!';
        systemContent += `- [${mark}] (${task.id.slice(0, 8)}) ${task.text}\n`;
      }
      if (doneTasks.length > 0) {
        systemContent += `(${doneTasks.length} completed task${doneTasks.length > 1 ? 's' : ''} omitted)\n`;
      }
    }

    if (agent.project) {
      const fileTree = this.executionManager?.getFileTree(id);
      let projectCtx = `\n\n--- PROJECT CONTEXT ---\nYou are working on project: ${agent.project}\nYour current working directory is already the project root.\nAll file paths are relative to this root (e.g. @read_file(src/index.js), NOT @read_file(/projects/${agent.project}/src/index.js)).\nDo NOT use absolute paths or /projects/ prefixes — they will not work.`;
      if (fileTree) {
        projectCtx += `\n\n--- PROJECT ROOT ---\n${fileTree}\n--- END ---\nUse @list_dir to explore subdirectories.`;
      } else {
        projectCtx += `\nUse @list_dir(.) to explore the project structure.`;
      }
      systemContent += projectCtx;
    } else {
      systemContent += `\n\n--- PROJECT CONTEXT ---\nNo specific project is assigned yet. Use @list_dir(.) to discover available projects. IMPORTANT: You MUST navigate into a project folder before working. Always prefix paths with the project name (e.g. @read_file(my-project/src/index.js), @list_dir(my-project/src)). Do NOT create or modify files at the workspace root — always work inside a project directory.`;
    }
    systemContent += `\nIMPORTANT: Your workspace is EPHEMERAL. Always commit and push after completing changes to preserve your work.`;
    systemContent += `\n${TOOL_DEFINITIONS}`;
    systemContent += `\nAlways use these tools to read, analyze, and modify code. Do not just discuss - take action!`;
    systemContent += `\n\nIMPORTANT CONTINUATION RULE: When you receive a message starting with "[TOOL RESULTS", these are the results of tools YOU previously called. Do NOT restart your reasoning from scratch. Do NOT re-call the same tools. Analyze the results and proceed to the NEXT step of your plan.`;

    if (agent.provider === 'ollama') {
      systemContent += `\n\nCRITICAL: You must NEVER use built-in function calls or native tool calls (such as repo_browser, code_sandbox, or any tool_call syntax). Always respond in plain text only. When you need to interact with code, use ONLY the @read_file, @write_file, @list_dir, @search_files, @run_command text commands described above.`;
    }

    const pluginCount = (agent.skills || []).length;
    const resolvedCount = pluginCount > 0 && this.skillManager
      ? (agent.skills || []).map(sid => this.skillManager.getById(sid)).filter(Boolean).length
      : 0;
    const sections = [];
    if (systemContent.includes('Active Plugins'))   sections.push('plugins');
    if (systemContent.includes('AVAILABLE TOOLS'))   sections.push('tools');
    if (systemContent.includes('MCP Tools'))         sections.push('mcp');
    if (systemContent.includes('Current Task List')) sections.push('tasks');
    if (systemContent.includes('PROJECT CONTEXT'))   sections.push('project');
    if (systemContent.includes('Swarm Agents'))      sections.push('swarm');
    console.log(`📋 [System Prompt] Agent "${agent.name}" (${agent.provider}/${agent.model}): ${systemContent.length} chars (~${Math.round(systemContent.length / 4)} tokens) | sections: [${sections.join(', ')}] | plugins: ${resolvedCount}/${pluginCount} | project: ${agent.project || 'none'} | history: ${agent.conversationHistory.length} msgs`);

    return systemContent;
  },

  async _assembleMessages(agent, messages, systemContent, userMessage, delegationDepth, messageMeta, streamCallback) {
    const earlyLlmConfig = this.resolveLlmConfig(agent);
    const managesContext = earlyLlmConfig.managesContext || false;
    if (managesContext) {
      console.log(`🧠 [Managed Context] "${agent.name}": model manages its own memory/compaction — skipping history \& compaction`);
    }

    const contextLimit = earlyLlmConfig.contextLength || agent.contextLength || 8192;
    const { maxRecent, compactTrigger, compactReset, safetyRatio } = this._compactionThresholds(contextLimit);

    const isTopLevelUserMessage = delegationDepth === 0 && !messageMeta;
    const isNewDelegationTask = messageMeta?.type === 'delegation-task';
    const isWorkflowAction = messageMeta?.type === 'workflow-action';
    const shouldCompact = isTopLevelUserMessage || isNewDelegationTask;

    // Determine if agent is currently executing a task (has an active task with startedAt).
    // For direct user messages (isTopLevelUserMessage), chat context is scoped to the
    // last task's startedAt (or full history if no tasks were ever executed).
    // For workflow messages (tool-result, delegation, etc.), also check cross-agent assignments
    // so that utility agents (titles-manager, product-manager) get task-scoped history.
    const agentId = [...this.agents.entries()].find(([, a]) => a === agent)?.[0];
    let activeTask = this._getAgentTasks(agentId).find(t => this._isActiveTaskStatus(t.status) && t.startedAt);
    // Also check cross-agent assignments: when an executor is different from the
    // task creator, _getAgentTasks(executorId) won't find it. We need to search
    // across all agents for tasks assigned to this executor.
    if (!activeTask && agentId) {
      const found = this._findTaskAcross(t => this._isActiveTaskStatus(t.status) && t.startedAt && (t.assignee === agentId || t.actionRunningAgentId === agentId));
      if (found) { activeTask = found.task; }
    }
    const isTaskExecution = !!activeTask;

    // Find the most recent task start time for this agent (used for chat context scoping).
    // When the user chats directly and no task is active, we still scope the history
    // to the last executed task's startedAt to avoid sending the entire history.
    let lastTaskStartTime = null;
    if (!isTaskExecution && agentId) {
      const _checkTime = (ts) => { if (ts && (!lastTaskStartTime || ts > lastTaskStartTime)) lastTaskStartTime = ts; };
      const _checkTask = (t) => {
        if (t.startedAt) _checkTime(new Date(t.startedAt).getTime());
        if (Array.isArray(t.history)) {
          for (const h of t.history) {
            if (h.type === 'execution' && h.startedAt) _checkTime(new Date(h.startedAt).getTime());
          }
        }
      };
      for (const t of this._getAgentTasks(agentId)) _checkTask(t);
      for (const [, tasks] of this._tasks) {
        for (const t of tasks) {
          if (t.assignee === agentId || t.actionRunningAgentId === agentId) _checkTask(t);
        }
      }
    }

    // Proactive compaction: only during task execution, non-managed context.
    // Chat mode scopes to last task start — no compaction needed.
    // Workflow one-shot actions skip compaction (no history included).
    if (shouldCompact && !managesContext && isTaskExecution && !isWorkflowAction) {
      const nonSummaryMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');

      if (agent._compactionArmed === undefined) {
        agent._compactionArmed = true;
      }
      if (!agent._compactionArmed && nonSummaryMessages.length <= compactReset) {
        agent._compactionArmed = true;
      }

      if (agent._compactionArmed && nonSummaryMessages.length > compactTrigger) {
        console.log(`🗜️  [Proactive Compact] "${agent.name}": ${nonSummaryMessages.length} messages — compacting to keep ${maxRecent} recent (context: ${contextLimit})`);
        if (streamCallback) streamCallback(`\n⏳ *Compacting conversation history (${nonSummaryMessages.length} messages)...*\n`);
        await this._compactHistory(agent, maxRecent);
        agent._compactionArmed = false;
      }
    }

    // Workflow one-shot actions (title, set_type, refine, decide) don't need
    // conversation history — they're self-contained prompts. Only 'execute'
    // mode benefits from task-scoped history for multi-turn agent work.
    if (isWorkflowAction && messageMeta.mode !== 'execute') {
      // No history — just system prompt + the action prompt (added below)
      console.log(`📋 [Workflow Action] "${agent.name}": mode=${messageMeta.mode} — no history (one-shot)`);
    } else if (managesContext) {
      // Model manages its own context — only include history relevant to the current task.
      if (activeTask) {
        const taskStartTime = new Date(activeTask.startedAt).getTime();
        const startIdx = agent.conversationHistory.findIndex(
          m => m.timestamp && new Date(m.timestamp).getTime() >= taskStartTime
        );
        if (startIdx >= 0) {
          messages.push(...agent.conversationHistory.slice(startIdx));
        }
      } else if (isTopLevelUserMessage) {
        // Direct user message with no active task: scope to last task's startedAt
        // to avoid sending the entire conversation history.
        let scopedToTask = false;
        if (lastTaskStartTime) {
          const startIdx = agent.conversationHistory.findIndex(
            m => m.timestamp && new Date(m.timestamp).getTime() >= lastTaskStartTime
          );
          if (startIdx >= 0) {
            messages.push(...agent.conversationHistory.slice(startIdx));
            scopedToTask = true;
          }
        }
        if (!scopedToTask) {
          messages.push(...agent.conversationHistory);
        }
      }
      // Otherwise (workflow message, no active task): start fresh
    } else if (isTaskExecution) {
      // Task mode: only include messages from when the task started
      const taskStartTime = new Date(activeTask.startedAt).getTime();
      const startIdx = agent.conversationHistory.findIndex(
        m => m.timestamp && new Date(m.timestamp).getTime() >= taskStartTime
      );
      if (startIdx >= 0) {
        messages.push(...agent.conversationHistory.slice(startIdx));
      } else {
        // Fallback: send recent messages if no timestamp match
        const summary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
        const realMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
        if (summary) messages.push(summary);
        messages.push(...realMessages.slice(-maxRecent));
      }
      console.log(`📋 [Task Context] "${agent.name}": task execution — sending ${messages.length - 1} messages from task start (of ${agent.conversationHistory.length} total)`);
    } else {
      // Chat mode: scope to last task's startedAt to reduce context size.
      // Only sends the full history as fallback when no task has ever been executed.
      let scopedToTask = false;
      if (lastTaskStartTime) {
        const startIdx = agent.conversationHistory.findIndex(
          m => m.timestamp && new Date(m.timestamp).getTime() >= lastTaskStartTime
        );
        if (startIdx >= 0) {
          messages.push(...agent.conversationHistory.slice(startIdx));
          scopedToTask = true;
        }
      }
      if (!scopedToTask) {
        // Fallback: send full history (no task history found or no matching messages)
        const summary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
        const realMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
        if (summary) messages.push(summary);
        messages.push(...realMessages);
      }
      console.log(`📋 [Chat Context] "${agent.name}": chat mode — sending ${messages.length - 1} messages${scopedToTask ? ' (scoped to last task start)' : ' (full history)'} of ${agent.conversationHistory.length} total`);
    }

    messages.push({ role: 'user', content: userMessage });

    // Safety token check: only during task execution, non-managed context.
    // Chat mode scopes to last task start — no token-based compaction.
    if (shouldCompact && !managesContext && isTaskExecution) {
      const realMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
      const estimatedTokens = this._estimateTokens(messages);
      if (estimatedTokens > contextLimit * safetyRatio && realMessages.length > maxRecent) {
        const emergencyKeep = Math.max(6, Math.floor(maxRecent * 0.6));
        console.log(`🗜️  [Token Compact] "${agent.name}": estimated ${estimatedTokens} tokens vs ${contextLimit} limit — compacting to keep ${emergencyKeep}`);
        if (streamCallback) streamCallback(`\n⏳ *Compacting conversation history (token limit)...*\n`);
        await this._compactHistory(agent, emergencyKeep);
        agent._compactionArmed = false;
        messages.length = 0;
        if (systemContent) {
          messages.push({ role: 'system', content: systemContent });
        }
        const newSummary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
        const newReal = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
        if (newSummary) messages.push(newSummary);
        messages.push(...newReal);
        messages.push({ role: 'user', content: userMessage });
      }
    }

    return { managesContext, isTaskExecution, activeTaskId: activeTask?.id || null };
  },

  async _streamAndContinue(agent, id, messages, llmConfig, streamCallback, abortController, delegationDepth, activeTaskId = null) {
    const provider = createProvider({
      provider: llmConfig.provider,
      model: llmConfig.model,
      endpoint: llmConfig.endpoint,
      apiKey: llmConfig.apiKey,
      agentId: id,
      ownerId: agent.ownerId || null
    });

    let fullResponse = '';
    let thinkingBuffer = '';
    let finishReason = null;

    const safeMaxTokens = this._safeMaxTokens(messages, agent, llmConfig);

    this._truncateMessagesToFit(messages, llmConfig.contextLength || 131072, safeMaxTokens);

    // Estimate context size (tokens in the messages array sent to the LLM)
    const estimatedContextTokens = this._estimateTokens(messages);

    for await (const chunk of provider.chatStream(messages, {
      temperature: llmConfig.temperature,
      maxTokens: safeMaxTokens,
      contextLength: llmConfig.contextLength || 0,
      isReasoning: llmConfig.isReasoning || agent.isReasoning || false,
      signal: abortController.signal,
      taskId: activeTaskId || undefined,
    })) {
      if (abortController.signal.aborted) {
        throw new Error('Agent stopped by user');
      }

      if (chunk.type === 'thinking') {
        thinkingBuffer += chunk.text;
        agent.currentThinking = thinkingBuffer;
        this._emit('agent:thinking', { agentId: id, agentName: agent.name, project: agent.project || null, thinking: thinkingBuffer });
      }

      if (chunk.type === 'text') {
        fullResponse += chunk.text;
        if (streamCallback) streamCallback(chunk.text);
      }
      if (chunk.type === 'done') {
        if (chunk.usage) {
          const inTok = chunk.usage.inputTokens || 0;
          const outTok = chunk.usage.outputTokens || 0;
          const cost = chunk.usage.costUsd ?? null;
          agent.metrics.totalTokensIn += inTok;
          agent.metrics.totalTokensOut += outTok;
          if (cost != null && cost > 0) {
            // Use actual cost reported by provider (e.g. Claude Paid Plan via coder-service)
            this._recordUsageDirect(agent, inTok, outTok, cost, estimatedContextTokens);
          } else {
            this._recordUsage(agent, inTok, outTok, estimatedContextTokens);
          }
          console.log(`📊 [Token] "${agent.name}": in=${inTok} out=${outTok} ctx=${estimatedContextTokens} cost=${cost != null ? '$' + cost.toFixed(4) : 'calc'}`);
        } else {
          console.warn(`⚠️ [Token] "${agent.name}": done event with no usage data`);
        }
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
      }
    }

    // ── Auto-continuation ──
    const MAX_CONTINUATIONS = 3;
    let continuationCount = 0;
    while (finishReason === 'length' && continuationCount < MAX_CONTINUATIONS) {
      continuationCount++;
      console.log(`🔄 [Continuation ${continuationCount}/${MAX_CONTINUATIONS}] "${agent.name}": response was truncated (finish_reason=length), requesting continuation...`);
      if (streamCallback) streamCallback(`\n⏳ *Response truncated, continuing...*\n`);

      messages.push({ role: 'assistant', content: fullResponse });
      messages.push({ role: 'user', content: 'Your previous response was cut off because it exceeded the maximum output length. Continue EXACTLY from where you stopped. Do not repeat anything you already wrote — just output the remaining content.' });

      finishReason = null;
      const contMaxTokens = this._safeMaxTokens(messages, agent, llmConfig);
      this._truncateMessagesToFit(messages, llmConfig.contextLength || 131072, contMaxTokens);
      const contContextTokens = this._estimateTokens(messages);
      for await (const chunk of provider.chatStream(messages, {
        temperature: llmConfig.temperature,
        maxTokens: contMaxTokens,
        contextLength: llmConfig.contextLength || 0,
        isReasoning: llmConfig.isReasoning || agent.isReasoning || false,
        signal: abortController.signal
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Agent stopped by user');
        }
        if (chunk.type === 'thinking') {
          thinkingBuffer += chunk.text;
          agent.currentThinking = thinkingBuffer;
          this._emit('agent:thinking', { agentId: id, agentName: agent.name, project: agent.project || null, thinking: thinkingBuffer });
        }
        if (chunk.type === 'text') {
          fullResponse += chunk.text;
          agent.currentThinking = fullResponse;
          if (streamCallback) streamCallback(chunk.text);
        }
        if (chunk.type === 'done') {
          if (chunk.usage) {
            const inTok = chunk.usage.inputTokens || 0;
            const outTok = chunk.usage.outputTokens || 0;
            const cost = chunk.usage.costUsd ?? null;
            agent.metrics.totalTokensIn += inTok;
            agent.metrics.totalTokensOut += outTok;
            if (cost != null && cost > 0) {
              this._recordUsageDirect(agent, inTok, outTok, cost, contContextTokens);
            } else {
              this._recordUsage(agent, inTok, outTok, contContextTokens);
            }
            console.log(`📊 [Token] "${agent.name}" (cont): in=${inTok} out=${outTok} ctx=${contContextTokens} cost=${cost != null ? '$' + cost.toFixed(4) : 'calc'}`);
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
        }
      }
      messages.pop();
      messages.pop();
    }

    if (continuationCount > 0 && finishReason === 'length') {
      console.log(`⚠️  [Continuation] "${agent.name}": still truncated after ${MAX_CONTINUATIONS} continuations`);
    }

    return { fullResponse, thinkingBuffer, finishReason };
  },

  async _processPostResponseActions(agent, id, responseForParsing, fullResponse, streamCallback, delegationDepth, messageMeta) {
    const isTopLevel = delegationDepth === 0 && !messageMeta;

    const isNudge = messageMeta?.type === 'nudge';
    const intentPatterns = /^[\s\S]{0,200}\b(i('ll| will| am going to|'m going to) (start|begin|proceed|now|first)|let me (start|begin|proceed|first|now|go ahead)|let's (start|begin|proceed)|je vais (commencer|d'abord|maintenant)|commençons par|je m'en occupe)\b/i;
    const looksLikePurePlan = responseForParsing.length < 500;

    // Process tool calls
    {
      const toolResults = await this._processToolCalls(id, responseForParsing, streamCallback, delegationDepth);
      if (toolResults.length > 0) {
        const hasTerminal = toolResults.some(r => r.isTerminal);
        const nonTerminal = toolResults.filter(r => !r.isTerminal);
        // If any tool signaled terminal (e.g. @task_execution_complete), stop
        // the continuation loop even if there were other non-terminal results
        // (e.g. run_command). Those tools already executed; sending their
        // output back to the LLM only causes it to loop and re-call the same
        // terminal tool repeatedly.
        if (hasTerminal || nonTerminal.length === 0) {
          return {};
        }
        const resultsSummary = nonTerminal.map(r => {
          if (r.isErrorReport) {
            return `--- ⚠️ ERROR REPORT ---\n${r.args[0] || r.result}`;
          }
          if (!r.success) {
            const parts = [`ERROR: ${r.error}`];
            if (r.result) parts.push(`OUTPUT:\n${r.result}`);
            return `--- ${r.tool}(${r.args.join(', ')}) ---\n${parts.join('\n')}`;
          }
          return `--- ${r.tool}(${r.args.join(', ')}) ---\n${r.result}`;
        }).join('\n\n');

        const hasErrorReports = nonTerminal.some(r => r.isErrorReport);
        const hasRealErrors = nonTerminal.some(r => !r.success && !r.isErrorReport);
        const hasSuccessfulCommit = nonTerminal.some(r => r.tool === 'run_command' && r.success && (r.args[0] || '').toLowerCase().includes('git push'));
        let continuationPrompt = '\nThese are the results of the tools YOU just called. Continue your work based on these results. Do NOT re-explain your plan or re-call the same tools — use the output above and proceed to the next step.';
        // Remind the LLM of the original task/user message to prevent it from
        // losing context across multiple tool-result iterations.
        const originalTask = agent.currentTask || '';
        if (originalTask) {
          continuationPrompt += `\nReminder — your current task: "${originalTask}"`;
        }
        if (hasErrorReports) {
          continuationPrompt = '\nYou reported an error. The error has been escalated to the manager. Summarize what you attempted and what went wrong so the manager can help.';
        } else if (hasRealErrors) {
          continuationPrompt = '\nSome tools encountered errors. Try to resolve the issues, use alternative approaches, or use @report_error(description) to escalate the problem to the manager if you cannot resolve it.';
        } else if (hasSuccessfulCommit) {
          continuationPrompt = '\nYour code has been committed and pushed. Now call @task_execution_complete(summary) to signal that your task is done.';
        }

        const continuedResponse = await this.sendMessage(
          id,
          `[TOOL RESULTS — DO NOT RESTART YOUR REASONING]\n${resultsSummary}\n\n${continuationPrompt}`,
          streamCallback,
          delegationDepth,
          { type: 'tool-result', toolResults: nonTerminal.map(r => ({ tool: r.tool, args: r.args, success: r.success, result: r.result || undefined, error: r.success ? undefined : r.error, isErrorReport: r.isErrorReport || false })) }
        );
        return { earlyReturn: continuedResponse };
      }

      const hasTools = agent.project || agent.mcpServers?.length > 0 || agent.skills?.length > 0;
      if (hasTools && !isNudge && looksLikePurePlan && responseForParsing.length > 20) {
        if (intentPatterns.test(responseForParsing)) {
          console.log(`🔄 [Nudge] Agent "${agent.name}" described intent but used no tools — nudging`);
          const nudgeMessage = agent.project || agent.skills?.length > 0
            ? '[SYSTEM] You described what you plan to do but did not use any tools. Stop describing and START ACTING NOW. Use @read_file, @write_file, @list_dir, @search_files, or @run_command to accomplish your task. Do NOT explain what you will do — just do it.'
            : '[SYSTEM] You described what you plan to do but did not use any tools. Stop describing and START ACTING NOW. Use your available @mcp_call tools to accomplish your task. Do NOT explain what you will do — just do it.';
          const nudgeResponse = await this.sendMessage(
            id,
            nudgeMessage,
            streamCallback,
            delegationDepth,
            { type: 'nudge' }
          );
          return { earlyReturn: nudgeResponse };
        }
      }
    }

    // ── Process @ask commands ────────
    {
      const agentHasDirectAccess = (agent.skills || []).includes('skill-agents-direct-access');
      if (agentHasDirectAccess && delegationDepth < MAX_DELEGATION_DEPTH) {
        const askCommands = this._parseAskCommands(responseForParsing);

        if (askCommands.length > 0) {
          const askResults = [];

          for (const askCmd of askCommands) {
            const targetAgent = Array.from(this.agents.values()).find(
              a => a.name.toLowerCase() === askCmd.agentName.toLowerCase() && a.id !== id && a.enabled !== false
            );

            if (!targetAgent) {
              console.log(`⚠️  [Ask] Agent "${askCmd.agentName}" not found or disabled`);
              askResults.push({ agentName: askCmd.agentName, answer: null, error: `Agent "${askCmd.agentName}" not found or disabled in swarm` });
              continue;
            }

            if (targetAgent.status === 'busy') {
              console.log(`⚠️  [Ask] Agent "${askCmd.agentName}" is busy`);
              askResults.push({ agentName: askCmd.agentName, answer: null, error: `Agent "${askCmd.agentName}" is currently busy. Try again later.` });
              continue;
            }

            console.log(`💬 [Ask] ${agent.name} → ${targetAgent.name}: "${askCmd.question.slice(0, 80)}"`);

            this._emit('agent:ask', {
              from: { id, name: agent.name },
              to: { id: targetAgent.id, name: targetAgent.name },
              question: askCmd.question
            });

            this._emit('agent:stream:start', { agentId: targetAgent.id });

            try {
              const answer = await this.sendMessage(
                targetAgent.id,
                `[QUESTION from ${agent.name}]: ${askCmd.question}\n\nPlease provide a concise, direct answer.`,
                (chunk) => {
                  this._emit('agent:stream:chunk', { agentId: targetAgent.id, chunk });
                },
                delegationDepth + 1,
                { type: 'ask-question', fromAgent: agent.name }
              );

              this._emit('agent:stream:end', { agentId: targetAgent.id });
              this._emit('agent:updated', this._sanitize(targetAgent));

              askResults.push({ agentName: targetAgent.name, answer, error: null });
            } catch (err) {
              this._emit('agent:stream:end', { agentId: targetAgent.id });
              console.error(`💬 [Ask] Error from ${targetAgent.name}: ${err.message}`);
              askResults.push({ agentName: targetAgent.name, answer: null, error: err.message });
            }
          }

          const answersSummary = askResults.map(r => {
            if (r.error) return `--- ⚠️ ERROR asking ${r.agentName} ---\n${r.error}`;
            return `--- Answer from ${r.agentName} ---\n${r.answer}`;
          }).join('\n\n');

          if (streamCallback) streamCallback(`\n\n--- Received answers, continuing ---\n\n`);

          const continuedResponse = await this.sendMessage(
            id,
            `[ASK RESULTS]\n${answersSummary}\n\nContinue with your task based on these answers.`,
            streamCallback,
            delegationDepth,
            { type: 'ask-result', askResults: askResults.map(r => ({ agentName: r.agentName, answer: r.answer, error: r.error })) }
          );
          return { earlyReturn: continuedResponse };
        }
      }
    }

    // ── Rate limit detection ──
    const rateLimitInfo = this._parseRateLimitReset(fullResponse);
    if (rateLimitInfo) {
      agent.conversationHistory.pop();
      this.setStatus(id, 'idle');
      this.abortControllers.delete(id);
      if (isTopLevel) this._chatLocks.delete(id);
      const err = new Error(`Rate limit reached — resets at ${rateLimitInfo.resetLabel}`);
      err.isRateLimit = true;
      err.retryAt = rateLimitInfo.retryAt;
      err.resetLabel = rateLimitInfo.resetLabel;
      throw err;
    }

    return { earlyReturn: null };
  },
};
