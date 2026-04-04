// ─── Tools: _processToolCalls ────────────────────────────────────────────────
import { parseToolCalls, executeTool } from '../agentTools.js';
import { getProjectGitUrl } from '../githubProjects.js';
import { saveAgent } from '../database.js';
import { getWorkflowForBoard } from '../configManager.js';
import { setTaskSignal } from './tasks.js';

/** @this {import('./index.js').AgentManager} */
export const toolsMethods = {

  async _processToolCalls(agentId, response, streamCallback, depth = 0) {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    const toolCalls = parseToolCalls(response);

    // Dedup: track which idempotent tools have already been processed in this response
    let taskExecutionCompleteDone = false;
    let listMyTasksDone = false;
    let checkStatusDone = false;
    
    console.log(`\n🔧 [Tools] Parsing response from "${agent.name}" (depth=${depth}, length=${response.length})`);
    
    if (toolCalls.length === 0) {
      const rawCount = (response.match(/@(read_file|write_file|list_dir|search_files|run_command|append_file)/gi) || []).length;
      const tagCount = (response.match(/<tool_call>/gi) || []).length;
      if (rawCount > 0 || tagCount > 0) {
        console.warn(`⚠️  [Tools] Agent "${agent.name}": found ${rawCount} @tool mention(s) and ${tagCount} <tool_call> tag(s) but parseToolCalls returned 0 matches`);
        const lines = response.split('\n');
        const toolLines = lines
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => /@(read_file|write_file|list_dir|search_files|run_command|append_file)/i.test(line) || /<tool_call>/i.test(line));
        for (const { line, i } of toolLines.slice(0, 5)) {
          console.warn(`   L${i + 1}: ${line.slice(0, 200)}`);
        }
      }
      return [];
    }
    
    console.log(`🔧 Agent ${agent.name} executing ${toolCalls.length} tool(s) (project=${agent.project || 'none'}, execution=${this.executionManager ? (this.executionManager.hasEnvironment(agentId) ? 'ready' : 'not-initialized') : 'no-manager'})`);

    if (this.executionManager) {
      try {
        // Bind agent to the correct execution provider based on LLM config
        const llmCfg = this.resolveLlmConfig(agent);
        const providerType = llmCfg.managesContext ? 'coder' : 'sandbox';
        this.executionManager.bindAgent(agentId, providerType, { ownerId: agent.ownerId || null });

        if (agent.project) {
          const gitUrl = await getProjectGitUrl(agent.project);
          if (gitUrl) {
            await this.executionManager.ensureProject(agentId, agent.project, gitUrl);
          } else {
            console.warn(`⚠️  [Execution] No git URL found for project "${agent.project}" — environment will NOT be initialized`);
          }
        } else {
          await this.executionManager.ensureProject(agentId);
        }
        console.log(`📦 [Execution] After ensureProject: hasEnvironment=${this.executionManager.hasEnvironment(agentId)}, provider=${providerType}`);
      } catch (err) {
        console.error(`⚠️  [Execution] Failed to ensure environment for ${agent.name}:`, err.message);
      }
    }

    const results = [];
    for (const call of toolCalls) {
      // ── @task_execution_complete() ──
      if (call.tool === 'task_execution_complete') {
        if (taskExecutionCompleteDone) {
          console.log(`[Dedup] Skipping duplicate @task_execution_complete from "${agent.name}"`);
          continue;
        }
        taskExecutionCompleteDone = true;
        const comment = call.args[0] || '';
        const explicitTaskId = (call.args[1] || '').trim();
        let inProgressTask = null;

        // If explicit taskId provided, look it up directly
        if (explicitTaskId) {
          for (const [creatorId, tasks] of this._tasks) {
            const found = tasks.find(t => t.id === explicitTaskId) ||
                          tasks.find(t => t.id.startsWith(explicitTaskId));
            if (found) { inProgressTask = found; break; }
          }
          if (!inProgressTask) {
            console.warn(`⚠️  [TaskComplete] Explicit taskId "${explicitTaskId}" not found, falling back to auto-detect`);
          }
        }

        // Auto-detect: Priority 1: Task actively running via this agent (set by processTransition)
        if (!inProgressTask) {
          for (const [ownerId, tasks] of this._tasks) {
            const found = tasks.find(t => t.actionRunningAgentId === agentId && this._isActiveTaskStatus(t.status));
            if (found) { inProgressTask = found; break; }
          }
        }
        // Auto-detect: Priority 2: Active task explicitly assigned to this agent
        if (!inProgressTask) {
          for (const [ownerId, tasks] of this._tasks) {
            const found = tasks.find(t => this._isActiveTaskStatus(t.status) && t.assignee === agentId);
            if (found) { inProgressTask = found; break; }
          }
        }
        // Auto-detect: Priority 3: Agent's own active task
        if (!inProgressTask) {
          inProgressTask = this._getAgentTasks(agentId).find(t => this._isActiveTaskStatus(t.status));
        }
        if (inProgressTask) {
          // Guard: task_execution_complete only makes sense when a _waitForExecutionComplete
          // is actually listening (execute mode). In decide/refine modes the agent should
          // use @update_task instead. Warn and let the chat loop continue so the agent
          // can self-correct.
          if (inProgressTask.actionRunningMode && inProgressTask.actionRunningMode !== 'execute') {
            console.warn(`⚠️ [TaskComplete] Agent "${agent.name}" called task_execution_complete but task ${inProgressTask.id} is in "${inProgressTask.actionRunningMode}" mode. Use @update_task instead.`);
            results.push({ tool: 'task_execution_complete', args: call.args, success: false, result: `Wrong tool: this task is in ${inProgressTask.actionRunningMode} mode, not execute mode. Use @update_task(${inProgressTask.id}, <new_status>) to change the task status.` });
            continue;
          }

          // Set both legacy in-memory flag AND the signal system for reliable detection
          inProgressTask._executionCompleted = true;
          inProgressTask._executionComment = comment;
          setTaskSignal(inProgressTask.id, 'completed', true);
          setTaskSignal(inProgressTask.id, 'comment', comment);

          // Link commits if provided (format: "hash:message, hash:message")
          const commitsArg = call.args[2] || '';
          if (commitsArg) {
            let ownerAgentId = null;
            for (const [ownerId, tasks] of this._tasks) {
              if (tasks.includes(inProgressTask)) { ownerAgentId = ownerId; break; }
            }
            ownerAgentId = ownerAgentId || agentId;
            const commitEntries = commitsArg.split(/,\s*(?=[a-f0-9])/).map(s => s.trim()).filter(Boolean);
            for (const entry of commitEntries) {
              const colonIdx = entry.indexOf(':');
              const hash = colonIdx > 0 ? entry.slice(0, colonIdx).trim() : entry.trim();
              const msg = colonIdx > 0 ? entry.slice(colonIdx + 1).trim() : '';
              if (hash && /^[a-f0-9]{7,40}$/.test(hash)) {
                this.addTaskCommit(ownerAgentId, inProgressTask.id, hash, msg);
                console.log(`🔗 [TaskComplete] Linked commit ${hash.slice(0, 7)} to task ${inProgressTask.id}`);
              }
            }
          }

          for (const [ownerId, tasks] of this._tasks) {
            if (tasks.includes(inProgressTask)) {
              const ownerAgent = this.agents.get(ownerId);
              if (ownerAgent) saveAgent(ownerAgent);
              break;
            }
          }
          console.log(`✅ [TaskComplete] Agent "${agent.name}" signaled completion for task ${inProgressTask.id} (status="${inProgressTask.status}", assignee="${inProgressTask.assignee || 'none'}"): "${comment.slice(0, 120)}"`);
          if (streamCallback) {
            streamCallback(`\n✅ Task execution complete: ${comment.slice(0, 200)}\n`);
          }
          results.push({ tool: 'task_execution_complete', args: call.args, success: true, result: `Task "${inProgressTask.text.slice(0, 80)}" marked as execution complete. Comment: ${comment}`, isTerminal: true });
        } else {
          // Log diagnostic info to help debug why no task was found
          const allActiveTasks = [];
          for (const [ownerId, tasks] of this._tasks) {
            for (const t of tasks) {
              if (this._isActiveTaskStatus(t.status)) {
                allActiveTasks.push({ id: t.id, status: t.status, assignee: t.assignee, actionRunningAgentId: t.actionRunningAgentId, ownerId });
              }
            }
          }
          console.log(`⚠️ [TaskComplete] Agent "${agent.name}" (${agentId}) called task_execution_complete but no active task found. Active tasks: ${JSON.stringify(allActiveTasks.slice(0, 5))}`);
          results.push({ tool: 'task_execution_complete', args: call.args, success: true, result: 'No action needed (no active task).', isTerminal: true });
        }
        continue;
      }

      // ── @report_error() ──
      if (call.tool === 'report_error') {
        const errorDescription = call.args[0] || 'Unknown error';
        console.log(`🚨 [Error Report] Agent "${agent.name}" reports: ${errorDescription.slice(0, 200)}`);
        this._emit('agent:error:report', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          description: errorDescription,
          timestamp: new Date().toISOString()
        });
        if (streamCallback) {
          streamCallback(`\n\n🚨 **Error reported by ${agent.name}:** ${errorDescription}\n`);
        }
        results.push({
          tool: 'report_error',
          args: call.args,
          success: true,
          result: `Error reported: ${errorDescription}`,
          isErrorReport: true
        });
        continue;
      }

      // ── @update_task() ──
      if (call.tool === 'update_task') {
        const [taskId, rawStatus, details] = call.args;
        let task = this._getAgentTasks(agentId).find(t => t.id === taskId);
        if (!task) task = this._getAgentTasks(agentId).find(t => t.id.startsWith(taskId));
        let taskAgentId = agentId;
        if (!task) {
          for (const [creatorId, tasks] of this._tasks) {
            const found = tasks.find(t => t.id === taskId || t.id.startsWith(taskId));
            if (found) {
              task = found;
              taskAgentId = creatorId;
              break;
            }
          }
        }
        if (!task) {
          const partial = this._getAgentTasks(agentId).find(t => t.id.startsWith(taskId.slice(0, 8)));
          const hint = partial ? ` Maybe you meant ${partial.id.slice(0, 8)} which is currently "${partial.status}"?` : '';
          results.push({ tool: 'update_task', args: call.args, success: false, error: `Task not found: ${taskId}.${hint}` });
          continue;
        }

        // Normalize status to match actual column IDs (case-insensitive).
        // Agents often pass "Resolution" instead of "resolution".
        let newStatus = rawStatus;
        if (task.boardId) {
          try {
            const wf = await getWorkflowForBoard(task.boardId);
            if (wf?.columns) {
              const match = wf.columns.find(c => c.id.toLowerCase() === rawStatus.toLowerCase());
              if (match) {
                if (match.id !== rawStatus) {
                  console.log(`[UpdateTask] Normalizing status "${rawStatus}" → "${match.id}"`);
                }
                newStatus = match.id;
              }
            }
          } catch (_) { /* best-effort, use raw */ }
        }

        if (details && details.trim()) {
          const separator = '\n\n---\n';
          const detailBlock = `**[${agent.name}]** ${details.trim()}`;
          task.text = (task.text || '') + separator + detailBlock;
          if (!task.history) task.history = [];
          task.history.push({
            status: task.status,
            at: new Date().toISOString(),
            by: agent.name,
            type: 'edit',
            field: 'text',
            oldValue: null,
            newValue: detailBlock,
          });
        }
        const updated = this.setTaskStatus(taskAgentId, task.id, newStatus, { skipAutoRefine: false, by: agent.name });
        if (!updated) {
          results.push({ tool: 'update_task', args: call.args, success: false, error: `Cannot move task to "${newStatus}" (blocked by guard or same status).` });
          continue;
        }
        console.log(`📋 [Task] Agent "${agent.name}" updated task "${task.text.slice(0, 50)}" → ${newStatus}${details ? ' (with details)' : ''}`);
        results.push({ tool: 'update_task', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" updated to ${newStatus}${details ? ' with details appended' : ''}` });
        continue;
      }

      // ── @list_projects() ──
      if (call.tool === 'list_projects') {
        const projects = await this._listAvailableProjects();
        if (projects.length === 0) {
          results.push({ tool: 'list_projects', args: [], success: true, result: 'No projects found.' });
        } else {
          results.push({ tool: 'list_projects', args: [], success: true, result: `Available projects:\n${projects.join('\n')}` });
        }
        continue;
      }

      // ── @list_my_tasks() ──
      if (call.tool === 'list_my_tasks') {
        if (listMyTasksDone) {
          console.log(`[Dedup] Skipping duplicate @list_my_tasks from "${agent.name}"`);
          continue;
        }
        listMyTasksDone = true;
        // Cross-turn dedup: skip if called recently (within 60s) with unchanged task list
        const now = Date.now();
        const lastCall = agent._lastListMyTasks || 0;
        const taskHash = JSON.stringify(this._getAgentTasks(agentId).map(t => `${t.id}:${t.status}`));
        if (now - lastCall < 60000 && agent._lastListMyTasksHash === taskHash) {
          console.log(`[Dedup] Skipping @list_my_tasks from "${agent.name}" — unchanged since ${Math.round((now - lastCall) / 1000)}s ago`);
          results.push({ tool: 'list_my_tasks', args: [], success: true, result: '[Tasks unchanged since last check — focus on your current task]' });
          continue;
        }
        agent._lastListMyTasks = now;
        agent._lastListMyTasksHash = taskHash;
        const tasks = this._getAgentTasks(agentId);
        const header = `Agent: ${agent.name} | Project: ${agent.project || 'none'} | Status: ${agent.status}`;
        if (tasks.length === 0) {
          results.push({ tool: 'list_my_tasks', args: [], success: true, result: `${header}\nNo tasks assigned.` });
        } else {
          const lines = tasks.map(t => {
            const icon = t.status === 'done' ? '[x]' : t.status === 'error' ? '[!]' : this._isActiveTaskStatus(t.status) ? '[~]' : '[ ]';
            return `${icon} ${t.id} — ${t.text}`;
          });
          results.push({ tool: 'list_my_tasks', args: [], success: true, result: `${header}\n${lines.join('\n')}` });
        }
        continue;
      }

      // ── @check_status() ──
      if (call.tool === 'check_status') {
        if (checkStatusDone) {
          console.log(`[Dedup] Skipping duplicate @check_status from "${agent.name}"`);
          continue;
        }
        checkStatusDone = true;
        // Cross-turn dedup: skip if called recently (within 30s)
        const csNow = Date.now();
        if (csNow - (agent._lastCheckStatus || 0) < 30000) {
          console.log(`[Dedup] Skipping @check_status from "${agent.name}" — called ${Math.round((csNow - agent._lastCheckStatus) / 1000)}s ago`);
          results.push({ tool: 'check_status', args: [], success: true, result: '[Status unchanged — focus on your current task]' });
          continue;
        }
        agent._lastCheckStatus = csNow;
        const { AgentManager } = await import('./index.js');
        const todoList = this._getAgentTasks(agentId);
        const waitingTasks = todoList.filter(t => !this._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error').length;
        const activeCount = todoList.filter(t => this._isActiveTaskStatus(t.status)).length;
        const doneTasks = todoList.filter(t => t.status === 'done').length;
        const errorTasks = todoList.filter(t => t.status === 'error').length;
        const totalTasks = todoList.length;
        const msgCount = (agent.conversationHistory || []).length;
        const hasSandbox = this.executionManager ? this.executionManager.hasEnvironment(agent.id) : false;
        const currentActiveTask = todoList.find(t => this._isActiveTaskStatus(t.status));
        const currentTaskInfo = agent.currentTask
          ? agent.currentTask.slice(0, 120)
          : currentActiveTask
            ? currentActiveTask.text.slice(0, 120)
            : 'none';
        const projectAssignedAt = agent.projectChangedAt
          ? new Date(agent.projectChangedAt).toLocaleString()
          : 'n/a';
        const projectDurationMs = agent.project && agent.projectChangedAt
          ? Date.now() - new Date(agent.projectChangedAt).getTime()
          : null;
        const projectDuration = AgentManager.formatDuration(projectDurationMs);

        const lines = [
          `Name: ${agent.name}`,
          `Status: ${agent.status}`,
          `Role: ${agent.role || 'worker'}`,
          `Project: ${agent.project || 'none'}${agent.project ? ` (assigned ${projectAssignedAt}, duration: ${projectDuration})` : ''}`,
          `Current task: ${currentTaskInfo}`,
          `Provider: ${agent.provider || 'unknown'}/${agent.model || 'unknown'}`,
          `Sandbox: ${hasSandbox ? 'running' : 'not running'}`,
          `Tasks: ${activeCount} active, ${waitingTasks} waiting, ${doneTasks} done, ${errorTasks} error / ${totalTasks} total`,
          `Messages: ${msgCount}`,
          `Last active: ${agent.metrics?.lastActiveAt || 'never'}`,
          `Errors: ${agent.metrics?.errors || 0}`,
        ];
        const activeTasks = todoList.filter(t => t.status !== 'done');
        if (activeTasks.length > 0) {
          lines.push(`Active tasks:`);
          for (const t of activeTasks.slice(0, 10)) {
            const mark = this._isActiveTaskStatus(t.status) ? '~' : t.status === 'error' ? '!' : ' ';
            lines.push(`  [${mark}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '...' : ''}`);
          }
          if (activeTasks.length > 10) lines.push(`  ... and ${activeTasks.length - 10} more`);
        }

        console.log(`📊 [Check Status] Agent "${agent.name}": ${agent.status} | project=${agent.project || 'none'} | task=${currentTaskInfo}`);
        results.push({ tool: 'check_status', args: [], success: true, result: lines.join('\n') });
        continue;
      }

      // ── @mcp_call() ──
      if (call.tool === 'mcp_call') {
        const [serverName, toolName, argsJson] = call.args;

        if (!serverName || !serverName.trim()) {
          const errMsg = 'MCP call requires a server name. Use: @mcp_call(ServerName, tool_name, {"arg": "value"})';
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: errMsg });
          continue;
        }
        if (!toolName || !toolName.trim()) {
          const errMsg = 'MCP call requires a tool name. Use: @mcp_call(ServerName, tool_name, {"arg": "value"})';
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: errMsg });
          continue;
        }

        const mcpLabel = `MCP: ${serverName} → ${toolName}`;
        agent.currentThinking = mcpLabel;
        this._emit('agent:thinking', { agentId, thinking: mcpLabel });
        this._emit('agent:tool:start', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args });

        try {
          let parsedArgs;
          if (typeof argsJson === 'string') {
            let raw = argsJson.trim();
            raw = raw.replace(/,?\s*\.{3}\s*/g, '');

            try {
              parsedArgs = JSON.parse(raw);
            } catch {
              let fixed = raw;
              fixed = fixed.replace(/([{,])\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
              fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
              fixed = fixed.replace(/'/g, '"');
              try {
                parsedArgs = JSON.parse(fixed);
                console.log(`🔧 [MCP] Repaired malformed JSON for ${toolName}: ${argsJson.slice(0, 100)}`);
              } catch (e2) {
                throw new Error(`Invalid JSON arguments for ${toolName}: ${e2.message}. Received: ${argsJson.slice(0, 200)}`);
              }
            }

            const vals = Object.values(parsedArgs);
            const looksLikeSchema = vals.length > 0 && vals.every(v =>
              (typeof v === 'object' && v !== null && ('type' in v || 'title' in v || 'anyOf' in v)) ||
              (typeof v === 'string' && /^<[^>]+>$/.test(v))
            );
            if (looksLikeSchema) {
              const paramNames = Object.keys(parsedArgs);
              throw new Error(
                `You passed the schema definition instead of actual values. ` +
                `Do NOT copy the type descriptions — pass real values. ` +
                `Example: @mcp_call(${serverName}, ${toolName}, {${paramNames.map(p => `"${p}": "actual-value-here"`).join(', ')}})`
              );
            }
          } else {
            parsedArgs = argsJson || {};
          }
          const mcpResult = await this.mcpManager.callToolByNameForAgent(serverName, toolName, parsedArgs, agentId, agent.mcpAuth || {});

          if (streamCallback) {
            const icon = mcpResult.success ? '✓' : '✗';
            streamCallback(`\n${icon} ${mcpLabel}\n`);
          }

          results.push({ tool: 'mcp_call', args: call.args, ...mcpResult });
          this._emit('agent:tool:result', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args, success: mcpResult.success, preview: (mcpResult.result || '').slice(0, 300) });
        } catch (mcpErr) {
          console.error(`❌ [MCP] Agent "${agent.name}" mcp_call failed: ${mcpErr.message}`);
          if (streamCallback) streamCallback(`\n✗ ${mcpLabel}: ${mcpErr.message}\n`);
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: mcpErr.message });
          this._emit('agent:tool:error', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', error: mcpErr.message });
        }
        continue;
      }

      // Cross-turn dedup for list_dir: skip if the same path was listed recently (within 30s)
      if (call.tool === 'list_dir') {
        const dirPath = call.args[0] || '.';
        const ldNow = Date.now();
        if (!agent._lastListDirCache) agent._lastListDirCache = {};
        const cached = agent._lastListDirCache[dirPath];
        if (cached && (ldNow - cached.at) < 30000) {
          console.log(`[Dedup] Skipping @list_dir(${dirPath}) from "${agent.name}" — listed ${Math.round((ldNow - cached.at) / 1000)}s ago`);
          results.push({ tool: 'list_dir', args: call.args, success: true, result: cached.result });
          continue;
        }
      }

      try {
        const toolLabels = {
          write_file: (a) => `Writing ${a[0] || ''}`,
          append_file: (a) => `Appending to ${a[0] || ''}`,
          read_file: (a) => `Reading ${a[0] || ''}`,
          list_dir: (a) => `Listing ${a[0] || '.'}`,
          search_files: (a) => `Searching ${a[0] || '*'} for "${a[1] || ''}"`,
          run_command: (a) => `Running: ${(a[0] || '').slice(0, 80)}`,
        };
        const labelFn = toolLabels[call.tool];
        const toolLabel = labelFn ? labelFn(call.args) : `@${call.tool}`;
        agent.currentThinking = toolLabel;
        this._emit('agent:thinking', { agentId, thinking: agent.currentThinking });

        this._emit('agent:tool:start', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          tool: call.tool,
          args: call.args
        });

        const llmConfig = this.resolveLlmConfig(agent);
        const toolOptions = {};
        const result = await executeTool(call.tool, call.args, agent.project, this.executionManager, agentId, toolOptions);

        // Schedule code index re-indexation for file modifications
        if (result.success && (call.tool === 'write_file' || call.tool === 'append_file') && agent.project) {
          const filePath = result.meta?.path || call.args[0];
          const content = call.tool === 'write_file' ? call.args[1] : undefined;
          if (filePath) {
            this.scheduleCodeIndexUpdate(agent.project, filePath, content);
          }
        }

        // Auto-capture commit hash and link to task
        if (call.tool === 'git_commit_push' || (call.tool === 'run_command' && result.success)) {
          let commitHash = null;
          let commitMsg = '';

          if (call.tool === 'git_commit_push') {
            commitHash = result.meta?.commitHash || null;
            commitMsg = call.args[0] || '';
          }
          if (!commitHash && typeof result.result === 'string') {
            const rawCmd = (call.args[0] || '').toLowerCase();
            const isGitCommit = call.tool === 'git_commit_push' ||
              (rawCmd.includes('git') && (rawCmd.includes('commit') || rawCmd.includes('push')));
            if (isGitCommit) {
              const commitMatch = result.result.match(/\[[^\]]*\s([a-f0-9]{7,40})\]/);
              if (commitMatch) commitHash = commitMatch[1];
              if (!commitMsg) commitMsg = call.args[0] || '';
            }
          }

          // Track the task we link to, so auto-complete can reuse it
          let commitLinkedTask = null;
          let commitLinkedOwnerAgentId = null;

          if (commitHash) {
            // If explicit taskId provided via @git_commit_push(message, taskId), use it
            const explicitTaskId = call.tool === 'git_commit_push' ? (call.args[1] || '').trim() : '';
            let targetTask = null;
            let ownerAgentId = agentId;

            if (explicitTaskId) {
              // Look up the explicit task
              for (const [creatorId, tasks] of this._tasks) {
                const found = tasks.find(t => t.id === explicitTaskId) ||
                              tasks.find(t => t.id.startsWith(explicitTaskId));
                if (found) { targetTask = found; ownerAgentId = creatorId; break; }
              }
              if (!targetTask) {
                console.warn(`⚠️  [Commit] Explicit taskId "${explicitTaskId}" not found, falling back to auto-detect`);
              }
            }

            // Fallback: auto-detect active task
            if (!targetTask) {
              const found = await this._findTaskForCommitLink(agentId);
              targetTask = found?.task || null;
              ownerAgentId = found?.ownerAgentId || agentId;
            }

            if (!targetTask) {
              const taskText = agent.currentTask || commitMsg || 'Commit without task';
              const created = this.addTask(agentId, taskText, agent.project || null, { type: 'auto', reason: 'commit-link' });
              if (created) {
                targetTask = this._getAgentTasks(agentId).find(t => t.id === created.id);
                ownerAgentId = agentId;
                console.log(`🔗 [Commit] Auto-created task "${taskText.slice(0, 50)}" for commit linking`);
              }
            }

            if (targetTask) {
              const linked = this.addTaskCommit(ownerAgentId, targetTask.id, commitHash, commitMsg);
              if (linked) {
                commitLinkedTask = targetTask;
                commitLinkedOwnerAgentId = ownerAgentId;
                console.log(`🔗 [Commit] Auto-linked ${commitHash.slice(0, 7)} to task "${targetTask.text?.slice(0, 50)}" (status=${targetTask.status}, owner=${ownerAgentId.slice(0, 8)})`);
                result.result = `${result.result}\n\n🔗 Commit ${commitHash.slice(0, 8)} automatically linked to task "${targetTask.text?.slice(0, 60)}"`;
              } else {
                console.warn(`⚠️  [Commit] addTaskCommit failed for ${commitHash.slice(0, 7)} → task "${targetTask.text?.slice(0, 50)}"`);
                result.result = `${result.result}\n\n⚠️ Auto-linking failed. Try again with explicit taskId: @git_commit_push(${commitMsg.slice(0, 40)}, ${targetTask.id})`;
              }
            } else {
              const agentTasks = [];
              for (const [ownerId, tasks] of this._tasks) {
                for (const t of tasks) {
                  if (t.assignee === agentId || ownerId === agentId) {
                    agentTasks.push(t);
                  }
                }
              }
              if (agentTasks.length > 0) {
                const taskList = agentTasks.slice(0, 5).map(t =>
                  `  - ${t.id.slice(0, 8)} → [${t.status}] ${t.text?.slice(0, 50)}`
                ).join('\n');
                console.warn(`⚠️  [Commit] Agent "${agent.name}" committed ${commitHash.slice(0, 7)} but no active task found. Available tasks:\n${taskList}`);
                result.result = `${result.result}\n\n⚠️ Commit ${commitHash.slice(0, 8)} was not auto-linked (no active task). Re-push with explicit taskId: @git_commit_push(message, taskId)`;
              } else {
                console.warn(`⚠️  [Commit] Agent "${agent.name}" committed ${commitHash.slice(0, 7)} but has no tasks at all`);
                result.result = `${result.result}\n\n⚠️ Commit ${commitHash.slice(0, 8)} was not linked — no tasks found for this agent.`;
              }
            }
          } else if (call.tool === 'git_commit_push' && result.success) {
            console.warn(`⚠️  [Commit] Agent "${agent.name}" git_commit_push succeeded but could not extract commit hash from output`);
          }

          // Auto-complete task after successful git_commit_push
          // Reuse the task found during commit linking for consistency
          if (call.tool === 'git_commit_push' && result.success) {
            const inProgressTask = commitLinkedTask;
            if (inProgressTask && this._isActiveTaskStatus(inProgressTask.status)) {
              const autoComment = commitMsg || 'Completed (auto-closed after successful git push)';
              // Set both legacy in-memory flag AND the signal system for reliable detection
              inProgressTask._executionCompleted = true;
              inProgressTask._executionComment = autoComment;
              setTaskSignal(inProgressTask.id, 'completed', true);
              setTaskSignal(inProgressTask.id, 'comment', autoComment);
              // Save the owner agent
              const ownerAgent = commitLinkedOwnerAgentId ? this.agents.get(commitLinkedOwnerAgentId) : null;
              if (ownerAgent) {
                saveAgent(ownerAgent);
              } else {
                // Fallback: find the agent that owns this task
                for (const [ownerId, tasks] of this._tasks) {
                  if (tasks.includes(inProgressTask)) {
                    const ag = this.agents.get(ownerId);
                    if (ag) saveAgent(ag);
                    break;
                  }
                }
              }
              console.log(`✅ [AutoComplete] Agent "${agent.name}" git_commit_push → auto-completing task "${inProgressTask.text?.slice(0, 80)}"`);
              if (streamCallback) {
                streamCallback(`\n✅ Task auto-completed after successful commit & push.\n`);
              }
              result.result = `${result.result}\n\n✅ Task automatically marked as complete.`;
            }
          }
        }

        results.push({ tool: call.tool, args: call.args, ...result });

        // Cache list_dir results for cross-turn dedup
        if (call.tool === 'list_dir' && result.success) {
          if (!agent._lastListDirCache) agent._lastListDirCache = {};
          agent._lastListDirCache[call.args[0] || '.'] = { result: result.result, at: Date.now() };
        }

        if (streamCallback) {
          const statusIcon = result.success ? '✓' : '✗';
          streamCallback(`\n${statusIcon} ${toolLabel}\n`);
        }

        if (result.success) {
          this._emit('agent:tool:result', {
            agentId,
            agentName: agent.name,
            project: agent.project || null,
            tool: call.tool,
            args: call.args,
            success: true,
            preview: result.result.slice(0, 300)
          });
        } else {
          console.warn(`⚠️  [Tool Error] Agent "${agent.name}" — @${call.tool}(${(call.args[0] || '').slice(0, 80)}): ${result.error}`);
          
          this._emit('agent:tool:error', {
            agentId,
            agentName: agent.name,
            project: agent.project || null,
            tool: call.tool,
            args: call.args,
            error: result.error || 'Unknown error',
            output: result.result || null,
            timestamp: new Date().toISOString()
          });

          if (streamCallback) {
            const outputSnippet = result.result ? `\n\`\`\`\n${result.result.slice(0, 500)}\n\`\`\`` : '';
            streamCallback(`\n\n⚠️ **Tool error** \`@${call.tool}(${(call.args[0] || '').slice(0, 100)})\`: ${result.error}${outputSnippet}\n`);
          }
        }
      } catch (err) {
        console.error(`❌ [Tool Crash] Agent "${agent.name}" — @${call.tool}: ${err.message}`);
        
        results.push({
          tool: call.tool,
          args: call.args,
          success: false,
          error: err.message
        });
        
        this._emit('agent:tool:error', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          tool: call.tool,
          args: call.args,
          error: err.message,
          timestamp: new Date().toISOString()
        });

        if (streamCallback) {
          streamCallback(`\n\n❌ **Tool crashed** \`@${call.tool}(${(call.args[0] || '').slice(0, 100)})\`: ${err.message}\n`);
        }
      }
    }

    return results;
  },
};
