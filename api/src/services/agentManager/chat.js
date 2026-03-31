// ─── Chat: sendMessage, _cleanMarkdown, _buildSystemPrompt, _assembleMessages,
//     _streamAndContinue, _processLeaderCommands, _processPostResponseActions ──
import { createProvider } from '../llmProviders.js';
import { saveAgent } from '../database.js';
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
    agent.currentThinking = '';

    if (messageMeta?.type === 'delegation-task') {
      agent.currentTask = (userMessage || '').replace(/^\[TASK from [^\]]+\]:\s*/i, '').slice(0, 200) || null;
    } else if (delegationDepth === 0 && !messageMeta) {
      agent.currentTask = (userMessage || '').slice(0, 200) || null;
    }
    this._emit('agent:status', { id, status: 'busy', project: agent.project || null, currentTask: agent.currentTask || null });

    if (this.sandboxManager && agent.project && !this.sandboxManager.getFileTree(id)) {
      try {
        const gitUrl = await getProjectGitUrl(agent.project);
        if (gitUrl) {
          await this.sandboxManager.ensureSandbox(id, agent.project, gitUrl);
          if (!this.sandboxManager.getFileTree(id)) {
            await this.sandboxManager.refreshFileTree(id);
          }
        }
      } catch (err) {
        console.warn(`⚠️  [Sandbox] Early init for file tree failed: ${err.message}`);
      }
    }

    const messages = [];
    const systemContent = await this._buildSystemPrompt(agent, id, delegationDepth);
    messages.push({ role: 'system', content: systemContent });

    const { managesContext } = await this._assembleMessages(agent, messages, systemContent, userMessage, delegationDepth, messageMeta, streamCallback);

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
      const streamResult = await this._streamAndContinue(agent, id, messages, llmConfig, streamCallback, abortController, delegationDepth);
      fullResponse = streamResult.fullResponse;
      const { delegationPromises, detectedCount } = streamResult;

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
      const actionResult = await this._processPostResponseActions(agent, id, responseForParsing, fullResponse, streamCallback, delegationDepth, messageMeta, delegationPromises, detectedCount);
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

        const inProgressTask = agent.todoList?.find(t => t.status === 'in_progress');
        if (inProgressTask) {
          inProgressTask.error = `Rate limit reached — resets at ${err.resetLabel}`;
          this.setTaskStatus(id, inProgressTask.id, 'error', { skipAutoRefine: true, by: 'rate-limit' });
          console.log(`🕐 [Rate Limit] Task "${inProgressTask.text.slice(0, 60)}" set to error`);
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

      // ── Reactive compaction: context exceeded → compact and retry once ──
      if (this._isContextExceededError(err.message) && !agent._compactionRetried && !managesContext) {
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
      const hasPartialToolCalls = fullResponse && /@(read_file|write_file|list_dir|search_files|run_command|append_file|git_commit_push|mcp_call|report_error|task_execution_complete)\b/i.test(fullResponse);
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
        systemContent += `\n\n--- Available Swarm Agents ---\nYou can delegate tasks to these agents using the format: @delegate(AgentName, "task description")\n${availableAgents.join('\n')}\n\nWhen you need an agent to work on something, use the @delegate command. The agent's response will be provided back to you.\n\nIMPORTANT: Agents may report errors using @report_error(). When you receive delegation results containing errors, analyze the problem and decide whether to retry the task, reassign it to another agent, provide additional guidance, or escalate to the user.`;
      } else {
        systemContent += `\n\n--- Available Swarm Agents ---\nNo other agents are currently available in the swarm. You will need to complete tasks yourself or ask the user to create specialist agents.`;
      }

      const projectNames = await this._listAvailableProjects();
      systemContent += `\n\n--- Agent Management Tools ---`;
      systemContent += `\nYou have the following management commands available:`;
      systemContent += `\n- @assign_project(AgentName, "project_name") — Assign an agent to a project. This sets their working directory so they can use file and command tools. When an agent's project changes, their conversation context is automatically saved and restored per-project.`;
      systemContent += `\n- @get_project(AgentName) — Check which project an agent is currently assigned to.`;
      systemContent += `\n- @clear_context(AgentName) — Clear an agent's entire conversation history, giving them a fresh start.`;
      systemContent += `\n- @rollback(AgentName, X) — Remove the last X messages from an agent's conversation history.`;
      systemContent += `\n- @stop_agent(AgentName) — Stop an agent's current task immediately.`;
      systemContent += `\n- @list_projects() — List all available projects.`;
      systemContent += `\n- @clear_all_chats() — Clear ALL agents' conversation histories at once, giving every agent a fresh start.`;
      systemContent += `\n- @clear_all_action_logs() — Clear ALL agents' action logs at once.`;
      systemContent += `\n- @list_agents() — List all enabled agents with their current status, project assignment, role, active tasks, and current task. Includes a project summary header showing agent distribution across projects.`;
      systemContent += `\n- @agent_status(AgentName) — Check a specific agent's detailed status: busy/idle/error, current project, current task, active task descriptions, sandbox state, message count, provider/model, and error count.`;
      systemContent += `\n- @get_available_agent(role) — Find all idle agents with the specified role (e.g. "developer"). Returns each agent's name, project assignment, and pending task count. If none are idle, shows busy agents with that role as a hint.`;
      systemContent += `\n- @swarm_status() — Get a comprehensive overview of the entire swarm: all agents grouped by their current project, with per-agent status, role, current task descriptions, and task counts.`;
      systemContent += `\n- @agents_on_project(projectName) — List all agents currently assigned to a specific project with their status, role, current task, and task counts. Useful for checking who is working on a particular project.`;
      if (projectNames.length > 0) {
        systemContent += `\nAvailable projects: ${projectNames.join(', ')}`;
      }
      systemContent += `\n\n⚠️ IMPORTANT: Before delegating tasks, ensure each agent has a project assigned. Agents without a project work at the workspace root and cannot access project files correctly. Use @assign_project(AgentName, "project_name") for any agent marked [no project] above before delegating code-related tasks to them. The system will auto-assign when possible, but explicit assignment is preferred.`;
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

    if (agent.todoList.length > 0) {
      systemContent += '\n\n--- Current Task List ---\n';
      for (const task of agent.todoList) {
        const mark = task.status === 'done' ? 'x' : task.status === 'in_progress' ? '~' : task.status === 'error' ? '!' : ' ';
        systemContent += `- [${mark}] (${task.id.slice(0, 8)}) ${task.text}\n`;
      }
    }

    if (agent.project) {
      const fileTree = this.sandboxManager?.getFileTree(id);
      let projectCtx = `\n\n--- PROJECT CONTEXT ---\nYou are working on project: ${agent.project}\nYour current working directory is already the project root.\nAll file paths are relative to this root (e.g. @read_file(src/index.js), NOT @read_file(/projects/${agent.project}/src/index.js)).\nDo NOT use absolute paths or /projects/ prefixes — they will not work.`;
      if (fileTree) {
        projectCtx += `\n\n--- PROJECT FILE TREE (3 levels) ---\n${fileTree}\n--- END FILE TREE ---\nUse this tree to navigate the project without needing @list_dir(.) first. Only use @list_dir for deeper exploration.`;
      } else {
        projectCtx += `\nUse @list_dir(.) to see its contents.`;
      }
      systemContent += projectCtx;
    } else {
      systemContent += `\n\n--- PROJECT CONTEXT ---\nNo specific project is assigned yet. Use @list_dir(.) to discover available projects. IMPORTANT: You MUST navigate into a project folder before working. Always prefix paths with the project name (e.g. @read_file(my-project/src/index.js), @list_dir(my-project/src)). Do NOT create or modify files at the workspace root — always work inside a project directory.`;
    }
    systemContent += `\nIMPORTANT: Your workspace is EPHEMERAL. Always @git_commit_push(message) after completing changes to preserve your work.`;
    systemContent += `\n${TOOL_DEFINITIONS}`;
    systemContent += `\nAlways use these tools to read, analyze, and modify code. Do not just discuss - take action!`;

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
    const shouldCompact = isTopLevelUserMessage || isNewDelegationTask;

    if (shouldCompact && !managesContext) {
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

    if (!managesContext) {
      const summary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
      const realMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
      if (summary) messages.push(summary);
      messages.push(...realMessages.slice(-maxRecent));
    }

    messages.push({ role: 'user', content: userMessage });

    if (shouldCompact && !managesContext) {
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
        messages.push(...newReal.slice(-maxRecent));
        messages.push({ role: 'user', content: userMessage });
      }
    }

    return { managesContext };
  },

  async _streamAndContinue(agent, id, messages, llmConfig, streamCallback, abortController, delegationDepth) {
    const MAX_DELEGATION_DEPTH = 5;
    const provider = createProvider({
      provider: llmConfig.provider,
      model: llmConfig.model,
      endpoint: llmConfig.endpoint,
      apiKey: llmConfig.apiKey,
      agentId: id
    });

    let fullResponse = '';
    let thinkingBuffer = '';
    let finishReason = null;

    let detectedCount = 0;
    const delegationPromises = [];
    const isLeaderStreaming = agent.isLeader && delegationDepth < MAX_DELEGATION_DEPTH;

    const safeMaxTokens = this._safeMaxTokens(messages, agent, llmConfig);

    this._truncateMessagesToFit(messages, llmConfig.contextLength || 131072, safeMaxTokens);

    for await (const chunk of provider.chatStream(messages, {
      temperature: llmConfig.temperature,
      maxTokens: safeMaxTokens,
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

        // ── Incremental delegation detection ──────────────────────
        if (isLeaderStreaming) {
          const cleanedForParsing = fullResponse.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
          const parsed = this._parseDelegations(cleanedForParsing);
          while (detectedCount < parsed.length) {
            const delegation = parsed[detectedCount];
            detectedCount++;

            const targetAgent = Array.from(this.agents.values()).find(
              a => a.name.toLowerCase() === delegation.agentName.toLowerCase() && a.id !== id && a.enabled !== false
            );

            if (!targetAgent) {
              console.log(`⚠️  Agent "${delegation.agentName}" not found or disabled in swarm`);
              delegationPromises.push(
                Promise.resolve({ agentName: delegation.agentName, response: null, error: `Agent "${delegation.agentName}" not found or disabled in swarm` })
              );
              continue;
            }

            if (!targetAgent.project) {
              let projectToAssign = agent.project;
              if (!projectToAssign) {
                const availableProjects = await this._listAvailableProjects();
                if (availableProjects.length === 1) {
                  projectToAssign = availableProjects[0];
                }
              }
              if (projectToAssign) {
                this.update(targetAgent.id, { project: projectToAssign });
                console.log(`📁 [Auto-assign] ${targetAgent.name} → project "${projectToAssign}" (inherited during delegation)`);
                if (streamCallback) streamCallback(`\n📁 Auto-assigned ${targetAgent.name} to project "${projectToAssign}"\n`);
              }
            }

            console.log(`⚡ [Incremental] Detected delegation #${detectedCount}: ${delegation.agentName} — enqueuing`);

            this._emit('agent:delegation', {
              from: { id, name: agent.name, project: agent.project || null },
              to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
              task: delegation.task
            });

            const createdTask = this.addTask(targetAgent.id, `[From ${agent.name}] ${delegation.task}`, agent.project || null, { type: 'agent', name: agent.name, id });

            const promise = this._enqueueAgentTask(targetAgent.id, async () => {
              if (createdTask) {
                const t = targetAgent.todoList.find(t => t.id === createdTask.id);
                if (t) {
                  t.status = 'in_progress';
                  t.startedAt = new Date().toISOString();
                  saveAgent(targetAgent);
                  this._emit('agent:updated', this._sanitize(targetAgent));
                }
              }

              if (streamCallback) streamCallback(`\n\n--- \uD83D\uDCE8 Delegating to ${targetAgent.name} ---\n`);

              this._emit('agent:stream:start', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });

              const agentResponse = await this.sendMessage(
                targetAgent.id,
                `[TASK from ${agent.name}]: ${delegation.task}`,
                (chunk) => {
                  this._emit('agent:stream:chunk', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, chunk });
                },
                delegationDepth + 1,
                { type: 'delegation-task', fromAgent: agent.name }
              );

              this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });
              if (streamCallback) streamCallback(`\n--- \u2705 ${targetAgent.name} finished ---\n`);
              this._emit('agent:updated', this._sanitize(targetAgent));

              if (createdTask) {
                const t = targetAgent.todoList.find(t => t.id === createdTask.id);
                if (t) {
                  t.status = 'done';
                  t.completedAt = new Date().toISOString();
                  saveAgent(targetAgent);
                  this._emit('agent:updated', this._sanitize(targetAgent));
                }
              }

              return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
            }).catch(err => {
              if (targetAgent?.id) this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent?.name || null, project: targetAgent?.project || null });
              if (createdTask && targetAgent) {
                const t = targetAgent.todoList.find(t => t.id === createdTask.id);
                if (t) {
                  t.errorFromStatus = t.status;
                  t.status = 'error';
                  t.error = err.message;
                  t.completedAt = new Date().toISOString();
                  saveAgent(targetAgent);
                  this._emit('agent:updated', this._sanitize(targetAgent));
                }
              }
              return { agentId: targetAgent?.id, agentName: targetAgent?.name || delegation.agentName, project: targetAgent?.project || null, task: delegation.task, response: null, error: err.message };
            });

            delegationPromises.push(promise);
          }
        }
      }
      if (chunk.type === 'done') {
        if (chunk.usage) {
          agent.metrics.totalTokensIn += chunk.usage.inputTokens;
          agent.metrics.totalTokensOut += chunk.usage.outputTokens;
          this._recordUsage(agent, chunk.usage.inputTokens || 0, chunk.usage.outputTokens || 0);
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
            agent.metrics.totalTokensIn += chunk.usage.inputTokens;
            agent.metrics.totalTokensOut += chunk.usage.outputTokens;
            this._recordUsage(agent, chunk.usage.inputTokens || 0, chunk.usage.outputTokens || 0);
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

    return { fullResponse, thinkingBuffer, finishReason, delegationPromises, detectedCount };
  },

  async _processLeaderCommands(agent, id, responseForParsing, streamCallback) {
    const projectAssignments = this._parseProjectAssignments(responseForParsing);
    for (const assignment of projectAssignments) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === assignment.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Assign Project] Agent "${assignment.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${assignment.targetAgentName}" not found in swarm\n`);
        continue;
      }
      this.update(targetAgent.id, { project: assignment.projectName });
      console.log(`📁 [Assign Project] ${targetAgent.name} → project "${assignment.projectName}"`);
      if (streamCallback) streamCallback(`\n✓ Assigned ${targetAgent.name} to project "${assignment.projectName}"\n`);
    }

    const getProjectCommands = this._parseGetProject(responseForParsing);
    for (const cmd of getProjectCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Get Project] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const projectInfo = targetAgent.project || '(no project assigned)';
      console.log(`📋 [Get Project] ${targetAgent.name} → "${projectInfo}"`);
      if (streamCallback) streamCallback(`\n📋 ${targetAgent.name} is assigned to project: ${projectInfo}\n`);
    }

    const clearContextCommands = this._parseClearContext(responseForParsing);
    for (const cmd of clearContextCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Clear Context] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      this.clearHistory(targetAgent.id);
      console.log(`🧹 [Clear Context] Cleared conversation history for ${targetAgent.name}`);
      if (streamCallback) streamCallback(`\n🧹 Cleared conversation history for ${targetAgent.name}\n`);
    }

    const rollbackCommands = this._parseRollback(responseForParsing);
    for (const cmd of rollbackCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Rollback] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const historyLen = targetAgent.conversationHistory.length;
      const removeCount = Math.min(cmd.count, historyLen);
      if (removeCount === 0) {
        if (streamCallback) streamCallback(`\n⚠️ ${targetAgent.name} has no messages to rollback\n`);
        continue;
      }
      const newLength = historyLen - removeCount;
      targetAgent.conversationHistory = targetAgent.conversationHistory.slice(0, newLength);
      if (newLength === 0) {
        delete targetAgent._compactionArmed;
      }
      saveAgent(targetAgent);
      this._emit('agent:updated', this._sanitize(targetAgent));
      console.log(`⏪ [Rollback] Removed last ${removeCount} message(s) from ${targetAgent.name} (${historyLen} → ${newLength})`);
      if (streamCallback) streamCallback(`\n⏪ Rolled back ${removeCount} message(s) from ${targetAgent.name} (${historyLen} → ${newLength} messages)\n`);
    }

    if (/@list_projects\s*\(\s*\)/i.test(responseForParsing)) {
      const projectNames = await this._listAvailableProjects();
      if (projectNames.length > 0) {
        console.log(`📂 [List Projects] ${projectNames.length} projects found`);
        if (streamCallback) streamCallback(`\n📂 Available projects: ${projectNames.join(', ')}\n`);
      } else {
        if (streamCallback) streamCallback(`\n📂 No projects found\n`);
      }
    }

    const stopAgentCommands = this._parseStopAgent(responseForParsing);
    for (const cmd of stopAgentCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Stop Agent] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const stopped = this.stopAgent(targetAgent.id);
      if (stopped) {
        console.log(`🛑 [Stop Agent] Stopped ${targetAgent.name}`);
        if (streamCallback) streamCallback(`\n🛑 Stopped agent ${targetAgent.name}\n`);
      } else {
        if (streamCallback) streamCallback(`\n⚠️ ${targetAgent.name} is not currently busy\n`);
      }
    }

    if (/@clear_all_chats\s*\(\s*\)/i.test(responseForParsing)) {
      let count = 0;
      for (const a of this.agents.values()) {
        if (a.id !== id && a.enabled !== false) {
          this.clearHistory(a.id);
          count++;
        }
      }
      console.log(`🧹 [Clear All Chats] Cleared conversation history for ${count} agents`);
      if (streamCallback) streamCallback(`\n🧹 Cleared conversation history for ${count} agents\n`);
    }

    if (/@clear_all_action_logs\s*\(\s*\)/i.test(responseForParsing)) {
      let count = 0;
      for (const a of this.agents.values()) {
        if (a.id !== id && a.enabled !== false) {
          this.clearActionLogs(a.id);
          count++;
        }
      }
      console.log(`📋 [Clear All Action Logs] Cleared action logs for ${count} agents`);
      if (streamCallback) streamCallback(`\n📋 Cleared action logs for ${count} agents\n`);
    }

    const agentStatusCommands = this._parseAgentStatus(responseForParsing);
    for (const cmd of agentStatusCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Agent Status] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const todoList = targetAgent.todoList || [];
      const pendingTasks = todoList.filter(t => t.status === 'pending' || t.status === 'error').length;
      const inProgressTasks = todoList.filter(t => t.status === 'in_progress').length;
      const doneTasks = todoList.filter(t => t.status === 'done').length;
      const totalTasks = todoList.length;
      const msgCount = (targetAgent.conversationHistory || []).length;
      const hasSandbox = this.sandboxManager ? this.sandboxManager.hasSandbox(targetAgent.id) : false;
      const inProgressTask = todoList.find(t => t.status === 'in_progress');
      const currentTaskInfo = targetAgent.currentTask
        ? targetAgent.currentTask.slice(0, 120) + (targetAgent.currentTask.length > 120 ? '...' : '')
        : inProgressTask
          ? inProgressTask.text.slice(0, 120) + (inProgressTask.text.length > 120 ? '...' : '')
          : 'none';
      const projectAssignedAt = targetAgent.projectChangedAt
        ? new Date(targetAgent.projectChangedAt).toLocaleString()
        : 'n/a';
      const targetProjectDuration = targetAgent.project && targetAgent.projectChangedAt
        ? AgentManager.formatDuration(Date.now() - new Date(targetAgent.projectChangedAt).getTime())
        : 'n/a';
      const lines = [
        `Name: ${targetAgent.name}`,
        `Status: ${targetAgent.status}`,
        `Role: ${targetAgent.role || 'worker'}`,
        `Project: ${targetAgent.project || 'none'}${targetAgent.project ? ` (assigned ${projectAssignedAt}, duration: ${targetProjectDuration})` : ''}`,
        `Current task: ${currentTaskInfo}`,
        `Provider: ${targetAgent.provider || 'unknown'}/${targetAgent.model || 'unknown'}`,
        `Sandbox: ${hasSandbox ? 'running' : 'not running'}`,
        `Tasks: ${inProgressTasks} in-progress, ${pendingTasks} pending, ${doneTasks} done / ${totalTasks} total`,
        `Messages: ${msgCount}`,
        `Last active: ${targetAgent.metrics?.lastActiveAt || 'never'}`,
        `Errors: ${targetAgent.metrics?.errors || 0}`,
      ];
      const activeTasks = todoList.filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'error');
      if (activeTasks.length > 0) {
        lines.push(`Active tasks:`);
        for (const t of activeTasks.slice(0, 10)) {
          const mark = t.status === 'in_progress' ? '~' : t.status === 'error' ? '!' : ' ';
          lines.push(`  [${mark}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '...' : ''}`);
        }
        if (activeTasks.length > 10) lines.push(`  ... and ${activeTasks.length - 10} more`);
      }
      console.log(`📊 [Agent Status] ${targetAgent.name}: ${targetAgent.status} | project=${targetAgent.project || 'none'} | task=${currentTaskInfo}`);
      if (streamCallback) streamCallback(`\n📊 Agent status:\n${lines.join('\n')}\n`);
    }

    if (/@list_agents\s*\(\s*\)/i.test(responseForParsing)) {
      const enabled = Array.from(this.agents.values()).filter(a => a.enabled !== false);

      const projectGroups = {};
      let unassignedCount = 0;
      for (const a of enabled) {
        if (a.project) {
          if (!projectGroups[a.project]) projectGroups[a.project] = { busy: 0, idle: 0, error: 0, total: 0 };
          projectGroups[a.project].total++;
          if (a.status === 'busy') projectGroups[a.project].busy++;
          else if (a.status === 'error') projectGroups[a.project].error++;
          else projectGroups[a.project].idle++;
        } else {
          unassignedCount++;
        }
      }

      let output = `\n👥 Enabled agents (${enabled.length}):\n`;
      const projectKeys = Object.keys(projectGroups);
      if (projectKeys.length > 0 || unassignedCount > 0) {
        output += `Projects: ${projectKeys.map(p => `${p} (${projectGroups[p].busy} busy, ${projectGroups[p].idle} idle)`).join(' | ')}`;
        if (unassignedCount > 0) output += ` | unassigned: ${unassignedCount}`;
        output += '\n';
      }

      const lines = enabled.map(a => {
        const projectTag = a.project ? `project=${a.project}` : 'NO PROJECT';
        const taskCount = (a.todoList || []).filter(t => t.status !== 'done').length;
        const inProgressTask = (a.todoList || []).find(t => t.status === 'in_progress');
        const taskCountInfo = taskCount > 0 ? ` tasks=${taskCount}` : '';
        const taskInfo = a.currentTask
          ? ` working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
          : inProgressTask
            ? ` working on: "${inProgressTask.text.slice(0, 80)}${inProgressTask.text.length > 80 ? '...' : ''}"`
            : '';
        return `- ${a.name} [${a.status}] [${projectTag}] (${a.role || 'worker'})${taskCountInfo}${taskInfo}`;
      });
      output += lines.join('\n') + '\n';

      console.log(`👥 [List Agents] ${enabled.length} enabled agents across ${projectKeys.length} projects`);
      if (streamCallback) streamCallback(output);
    }

    const getAvailableCommands = this._parseGetAvailableAgent(responseForParsing);
    for (const cmd of getAvailableCommands) {
      const allMatching = Array.from(this.agents.values()).filter(
        a => a.id !== id && a.enabled !== false && a.status === 'idle' && (a.role || '').toLowerCase() === cmd.role.toLowerCase()
      );
      if (allMatching.length > 0) {
        const lines = allMatching.map(a => {
          const projectInfo = a.project ? `project=${a.project}` : 'no project';
          const todoCount = (a.todoList || []).filter(t => t.status !== 'done').length;
          const taskInfo = todoCount > 0 ? `, ${todoCount} pending tasks` : '';
          return `  - ${a.name} [idle] (${projectInfo}${taskInfo})`;
        });
        console.log(`🔍 [Get Available] Found ${allMatching.length} idle "${cmd.role}" agent(s)`);
        if (streamCallback) streamCallback(`\n🔍 Available ${cmd.role} agents (${allMatching.length} idle):\n${lines.join('\n')}\n`);
      } else {
        const busyMatching = Array.from(this.agents.values()).filter(
          a => a.id !== id && a.enabled !== false && a.status === 'busy' && (a.role || '').toLowerCase() === cmd.role.toLowerCase()
        );
        let hint = '';
        if (busyMatching.length > 0) {
          hint = ` (${busyMatching.length} busy: ${busyMatching.map(a => `${a.name} on ${a.project || 'no project'}`).join(', ')})`;
        }
        console.log(`🔍 [Get Available] No idle agent with role "${cmd.role}"`);
        if (streamCallback) streamCallback(`\n🔍 No idle agent with role "${cmd.role}" available${hint}\n`);
      }
    }

    if (/@swarm_status\s*\(\s*\)/i.test(responseForParsing)) {
      const swarmStatus = this.getSwarmStatus();
      const s = swarmStatus.summary;
      let output = `\n📊 Swarm Status: ${s.enabled} agents (${s.busy} busy, ${s.idle} idle, ${s.error} error) | ${s.activeProjects.length} active projects\n`;
      for (const [project, agents] of Object.entries(swarmStatus.projectAssignments)) {
        const ps = swarmStatus.projectSummaries[project];
        output += `\n📁 Project: ${project} (${ps.total} agents: ${ps.busy} busy, ${ps.idle} idle)\n`;
        for (const a of agents) {
          const taskInfo = a.currentTask
            ? ` — working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
            : '';
          const taskCountInfo = a.tasks.inProgress > 0 || a.tasks.pending > 0
            ? ` | tasks: ${a.tasks.inProgress} in-progress, ${a.tasks.pending} pending`
            : '';
          output += `  - ${a.name} [${a.status}] (${a.role})${taskCountInfo}${taskInfo}\n`;
        }
      }
      if (swarmStatus.unassignedAgents.length > 0) {
        output += `\n⚠️ Unassigned (no project): ${swarmStatus.unassignedAgents.length} agents\n`;
        for (const a of swarmStatus.unassignedAgents) {
          const taskInfo = a.currentTask ? ` — task: "${a.currentTask.slice(0, 80)}..."` : '';
          output += `  - ${a.name} [${a.status}] (${a.role})${taskInfo}\n`;
        }
      }
      console.log(`📊 [Swarm Status] ${s.enabled} agents, ${Object.keys(swarmStatus.projectAssignments).length} projects`);
      if (streamCallback) streamCallback(output);
    }

    const agentsOnProjectCommands = this._parseAgentsOnProject(responseForParsing);
    for (const cmd of agentsOnProjectCommands) {
      const agents = this.getAgentsByProject(cmd.projectName);
      if (agents.length > 0) {
        let output = `\n📁 Agents on project "${cmd.projectName}" (${agents.length}):\n`;
        const busyCount = agents.filter(a => a.status === 'busy').length;
        const idleCount = agents.filter(a => a.status === 'idle').length;
        output += `Summary: ${busyCount} busy, ${idleCount} idle\n`;
        for (const a of agents) {
          const taskInfo = a.currentTask
            ? ` — working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
            : '';
          const taskCountInfo = a.tasks.inProgress > 0 || a.tasks.pending > 0
            ? ` | tasks: ${a.tasks.inProgress} in-progress, ${a.tasks.pending} pending`
            : '';
          output += `  - ${a.name} [${a.status}] (${a.role})${taskCountInfo}${taskInfo}\n`;
        }
        console.log(`📁 [Agents On Project] ${agents.length} agents on "${cmd.projectName}"`);
        if (streamCallback) streamCallback(output);
      } else {
        console.log(`📁 [Agents On Project] No agents assigned to "${cmd.projectName}"`);
        if (streamCallback) streamCallback(`\n📁 No agents are currently assigned to project "${cmd.projectName}"\n`);
      }
    }
  },

  async _processPostResponseActions(agent, id, responseForParsing, fullResponse, streamCallback, delegationDepth, messageMeta, delegationPromises, detectedCount) {
    const MAX_DELEGATION_DEPTH = 5;
    const isLeaderStreaming = agent.isLeader && delegationDepth < MAX_DELEGATION_DEPTH;
    const isTopLevel = delegationDepth === 0 && !messageMeta;

    const isNudge = messageMeta?.type === 'nudge';
    const intentPatterns = /^[\s\S]{0,200}\b(i('ll| will| am going to|'m going to) (start|begin|proceed|now|first)|let me (start|begin|proceed|first|now|go ahead)|let's (start|begin|proceed)|je vais (commencer|d'abord|maintenant)|commençons par|je m'en occupe)\b/i;
    const looksLikePurePlan = responseForParsing.length < 500;

    // Process tool calls
    {
      const toolResults = await this._processToolCalls(id, responseForParsing, streamCallback, delegationDepth);
      if (toolResults.length > 0) {
        const nonTerminal = toolResults.filter(r => !r.isTerminal);
        if (nonTerminal.length === 0) {
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
        const hasSuccessfulCommit = nonTerminal.some(r => r.tool === 'git_commit_push' && r.success);
        let continuationPrompt = '\n';
        if (hasErrorReports) {
          continuationPrompt = '\nYou reported an error. The error has been escalated to the manager. Summarize what you attempted and what went wrong so the manager can help.';
        } else if (hasRealErrors) {
          continuationPrompt = '\nSome tools encountered errors. Try to resolve the issues, use alternative approaches, or use @report_error(description) to escalate the problem to the manager if you cannot resolve it.';
        } else if (hasSuccessfulCommit) {
          continuationPrompt = '\n Your code has been committed, pushed, and the task has been auto-completed. Provide a brief summary of what was accomplished.';
        }

        const continuedResponse = await this.sendMessage(
          id,
          `\n${resultsSummary}\n\n${continuationPrompt}`,
          streamCallback,
          delegationDepth,
          { type: 'tool-result', toolResults: nonTerminal.map(r => ({ tool: r.tool, args: r.args, success: r.success, result: r.result || undefined, error: r.success ? undefined : r.error, isErrorReport: r.isErrorReport || false })) }
        );
        return { earlyReturn: continuedResponse };
      }

      const hasTools = agent.project || agent.mcpServers?.length > 0 || agent.skills?.length > 0;
      if (hasTools && !isNudge && looksLikePurePlan && responseForParsing.length > 20 && !isLeaderStreaming) {
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

    // For leader agents, process delegation commands
    if (isLeaderStreaming) {
      const finalParsed = this._parseDelegations(responseForParsing);
      while (detectedCount < finalParsed.length) {
        const delegation = finalParsed[detectedCount];
        detectedCount++;

        const targetAgent = Array.from(this.agents.values()).find(
          a => a.name.toLowerCase() === delegation.agentName.toLowerCase() && a.id !== id
        );

        if (!targetAgent) {
          delegationPromises.push(
            Promise.resolve({ agentName: delegation.agentName, response: null, error: `Agent "${delegation.agentName}" not found in swarm` })
          );
          continue;
        }

        this._emit('agent:delegation', {
          from: { id, name: agent.name, project: agent.project || null },
          to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
          task: delegation.task
        });
        const createdTask = this.addTask(targetAgent.id, `[From ${agent.name}] ${delegation.task}`, agent.project || null, { type: 'agent', name: agent.name, id });

        const promise = this._enqueueAgentTask(targetAgent.id, async () => {
          if (createdTask) {
            const t = targetAgent.todoList.find(t => t.id === createdTask.id);
            if (t) {
              t.status = 'in_progress';
              t.startedAt = new Date().toISOString();
              saveAgent(targetAgent);
              this._emit('agent:updated', this._sanitize(targetAgent));
            }
          }

          if (streamCallback) streamCallback(`\n\n--- \uD83D\uDCE8 Delegating to ${targetAgent.name} ---\n`);

          this._emit('agent:stream:start', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });

          const agentResponse = await this.sendMessage(
            targetAgent.id,
            `[TASK from ${agent.name}]: ${delegation.task}`,
            (chunk) => {
              this._emit('agent:stream:chunk', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, chunk });
            },
            delegationDepth + 1,
            { type: 'delegation-task', fromAgent: agent.name }
          );

          this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });
          if (streamCallback) streamCallback(`\n--- \u2705 ${targetAgent.name} finished ---\n`);
          this._emit('agent:updated', this._sanitize(targetAgent));

          if (createdTask) {
            const t = targetAgent.todoList.find(t => t.id === createdTask.id);
            if (t) {
              t.status = 'done';
              t.completedAt = new Date().toISOString();
              saveAgent(targetAgent);
              this._emit('agent:updated', this._sanitize(targetAgent));
            }
          }
          return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
        }).catch(err => {
          if (targetAgent?.id) this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent?.name || null, project: targetAgent?.project || null });
          if (createdTask && targetAgent) {
            const t = targetAgent.todoList.find(t => t.id === createdTask.id);
            if (t) {
              t.errorFromStatus = t.status;
              t.status = 'error';
              t.error = err.message;
              t.completedAt = new Date().toISOString();
              saveAgent(targetAgent);
              this._emit('agent:updated', this._sanitize(targetAgent));
            }
          }
          return { agentId: targetAgent?.id, agentName: targetAgent?.name || delegation.agentName, project: targetAgent?.project || null, task: delegation.task, response: null, error: err.message };
        });

        delegationPromises.push(promise);
      }

      if (delegationPromises.length > 0) {
        console.log(`📨 [Delegation] Waiting for ${delegationPromises.length} queued delegation(s) to complete...`);
        const delegationResults = await Promise.all(delegationPromises);

        if (streamCallback) {
          streamCallback(`\n\n--- Delegation complete, synthesizing results ---\n\n`);
        }

        const resultsSummary = delegationResults.map(r => {
          const projectTag = r.project ? ` [project: ${r.project}]` : '';
          const header = r.error
            ? `--- ⚠️ ERROR from ${r.agentName}${projectTag} ---`
            : `--- Response from ${r.agentName}${projectTag} ---`;
          return `${header}\n${r.response || r.error}`;
        }).join('\n\n');

        const hasErrors = delegationResults.some(r => r.error);
        const synthesisHint = hasErrors
          ? 'Some agents reported errors. Decide whether to retry, reassign, or adapt your plan accordingly.'
          : 'Please synthesize these results and continue with your plan. If more delegations are needed, use @delegate() commands. If the task is complete, provide the final response.';

        const synthesisResponse = await this.sendMessage(
          id,
          `[DELEGATION RESULTS]\n${resultsSummary}\n\n${synthesisHint}`,
          streamCallback,
          delegationDepth + 1,
          { type: 'delegation-result', delegationResults: delegationResults.map(r => ({ agentName: r.agentName, project: r.project || null, task: r.task, response: r.response, error: r.error })) }
        );
        return { earlyReturn: synthesisResponse };
      }
      // Leader nudge
      if (!isNudge && looksLikePurePlan && delegationPromises.length === 0 && responseForParsing.length > 20) {
        if (intentPatterns.test(responseForParsing)) {
          console.log(`🔄 [Nudge] Leader "${agent.name}" described intent but used no @delegate — nudging`);
          const nudgeResponse = await this.sendMessage(
            id,
            '[SYSTEM] You described what you plan to do but did not actually delegate or take action. Stop planning and ACT NOW. Use @delegate(AgentName, task) to assign work to agents. Do NOT explain what you will do — just do it.',
            streamCallback,
            delegationDepth,
            { type: 'nudge' }
          );
          return { earlyReturn: nudgeResponse };
        }
      }
    } else if (agent.isLeader && delegationDepth >= MAX_DELEGATION_DEPTH) {
      console.log(`⚠️ Max delegation depth (${MAX_DELEGATION_DEPTH}) reached for leader ${agent.name}`);
    }

    if (agent.isLeader) {
      await this._processLeaderCommands(agent, id, responseForParsing, streamCallback);
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
