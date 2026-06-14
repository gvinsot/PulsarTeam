// ─── Tools: _processToolCalls ────────────────────────────────────────────────
import { parseToolCalls, executeTool } from '../agentTools.js';
import { buildRepoCloneUrl } from '../repoUrl.js';
import { saveAgent, saveTaskToDb } from '../database.js';
import { setTaskSignal } from './tasks.js';
import { checkToolHooks } from '../toolHooks.js';
import { _detectCommitHashes } from './tools/commitDetection.js';
import { HANDLERS, appendTaskNote, HandlerCtx } from './tools/handlers.js';

/** @this {import('./index.js').AgentManager} */
export const toolsMethods = {

  /**
   * Core of `task_execution_complete`: mark the agent's active task as
   * execution-complete (set the completion signal `_waitForExecutionComplete`
   * is polling for), append the agent's summary onto the task, and link commits.
   *
   * Shared by two call sites that signal completion differently:
   *  - the native `@task_execution_complete` text tool (see _processToolCalls),
   *    used by sandbox/non-CLI agents whose output we parse;
   *  - the Swarm API MCP tool of the same name (see swarmApiMcp.ts), used by CLI
   *    runner agents (claude-code/codex/opencode/openclaw/hermes), which invoke
   *    MCP tools rather than emitting @-syntax our parser would see.
   *
   * Returns the per-tool outcome ({ success, result, isTerminal? }) so each
   * caller can shape its own response envelope.
   */
  async applyTaskExecutionComplete(
    this: any,
    agentId: string,
    { comment = '', explicitTaskId = '', commitsArg = '', streamCallback = null }:
      { comment?: string; explicitTaskId?: string; commitsArg?: string; streamCallback?: any } = {},
  ): Promise<{ success: boolean; result: string; isTerminal?: boolean; taskId?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`⚠️ [TaskComplete] task_execution_complete for unknown agent ${agentId}`);
      return { success: false, result: `Agent ${agentId} not found.` };
    }

    let inProgressTask: any = null;
    // Track the owning agent of inProgressTask as we resolve it, so we don't
    // have to re-scan _tasks for the owner later (the previous includes() pass).
    let ownerAgentId: string = agentId;

    // If explicit taskId provided, look it up directly
    if (explicitTaskId) {
      const found = this._findTaskByIdOrPrefix(explicitTaskId);
      if (found) { inProgressTask = found.task; ownerAgentId = found.agentId; }
      if (!inProgressTask) {
        console.warn(`⚠️  [TaskComplete] Explicit taskId "${explicitTaskId}" not found, falling back to auto-detect`);
      }
    }

    // Auto-detect: Priority 1: Task actively running via this agent (set by processTransition)
    if (!inProgressTask) {
      const found = this._findTaskAcross((t: any) => t.actionRunningAgentId === agentId && this._isActiveTaskStatus(t.status));
      if (found) { inProgressTask = found.task; ownerAgentId = found.agentId; }
    }
    // Auto-detect: Priority 2: Active task explicitly assigned to this agent
    if (!inProgressTask) {
      const found = this._findTaskAcross((t: any) => this._isActiveTaskStatus(t.status) && t.assignee === agentId);
      if (found) { inProgressTask = found.task; ownerAgentId = found.agentId; }
    }
    // Auto-detect: Priority 3: Agent's own active task (owner is this agent)
    if (!inProgressTask) {
      inProgressTask = this._getAgentTasks(agentId).find((t: any) => this._isActiveTaskStatus(t.status));
      if (inProgressTask) ownerAgentId = agentId;
    }

    if (!inProgressTask) {
      // Log diagnostic info to help debug why no task was found
      const allActiveTasks: any[] = [];
      for (const [ownerId, tasks] of this._tasks) {
        for (const t of tasks as any[]) {
          if (this._isActiveTaskStatus(t.status)) {
            allActiveTasks.push({ id: t.id, status: t.status, assignee: t.assignee, actionRunningAgentId: t.actionRunningAgentId, ownerId });
          }
        }
      }
      console.log(`⚠️ [TaskComplete] Agent "${agent.name}" (${agentId}) called task_execution_complete but no active task found. Active tasks: ${JSON.stringify(allActiveTasks.slice(0, 5))}`);
      return { success: true, result: 'No action needed (no active task).', isTerminal: true };
    }

    // Guard: task_execution_complete only makes sense when a _waitForExecutionComplete
    // is actually listening (execute mode). In decide/refine modes the agent should
    // use @update_task instead. Warn and let the chat loop continue so the agent
    // can self-correct.
    if (inProgressTask.actionRunningMode && inProgressTask.actionRunningMode !== 'execute') {
      console.warn(`⚠️ [TaskComplete] Agent "${agent.name}" called task_execution_complete but task ${inProgressTask.id} is in "${inProgressTask.actionRunningMode}" mode. Use @update_task instead.`);
      return { success: false, result: `Wrong tool: this task is in ${inProgressTask.actionRunningMode} mode, not execute mode. Use @update_task(${inProgressTask.id}, <new_status>) to change the task status.` };
    }

    setTaskSignal(inProgressTask.id, 'completed', true);
    setTaskSignal(inProgressTask.id, 'comment', comment);

    // Append the completion comment to the task description, same convention as
    // @update_task(taskId, status, details). This makes the agent's summary visible
    // on the task itself (kanban card) instead of being only relayed to the leader.
    // stampUpdatedAt=true: no setTaskStatus follows here (unlike @update_task).
    if (comment && comment.trim()) {
      appendTaskNote(inProgressTask, agent.name, comment, true);
    }

    // ownerAgentId was captured while resolving inProgressTask above.

    // Link commits if provided (format: "hash:message, hash:message")
    let linkedCommitCount = 0;
    if (commitsArg) {
      const commitEntries = commitsArg.split(/,\s*(?=[a-f0-9])/).map((s: string) => s.trim()).filter(Boolean);
      for (const entry of commitEntries) {
        const colonIdx = entry.indexOf(':');
        const hash = colonIdx > 0 ? entry.slice(0, colonIdx).trim() : entry.trim();
        const msg = colonIdx > 0 ? entry.slice(colonIdx + 1).trim() : '';
        if (hash && /^[a-f0-9]{7,40}$/.test(hash)) {
          this.addTaskCommit(ownerAgentId, inProgressTask.id, hash, msg);
          linkedCommitCount++;
          console.log(`🔗 [TaskComplete] Linked commit ${hash.slice(0, 7)} to task ${inProgressTask.id}`);
        }
      }
    }

    // Auto-detect commits from git environment when none were explicitly provided
    // and the task has no existing commits. This catches cases where:
    // - The agent forgot to pass commit hashes
    // - The execution was retried and commits were made in a previous round
    // - The auto-detection during @run_command(git push) failed
    const existingCommits = inProgressTask.commits || [];
    if (linkedCommitCount === 0 && existingCommits.length === 0 && this.executionManager?.hasEnvironment(agentId)) {
      try {
        // Use %aI (ISO author date) so we can filter by task time window in code
        // and avoid relying solely on git's --since (which is fuzzy on edge cases).
        const taskStartedAt = inProgressTask.startedAt;
        const sinceArg = taskStartedAt ? ` --since="${new Date(new Date(taskStartedAt).getTime() - 5 * 60000).toISOString()}"` : '';
        const logCmd = `git log --format="%H %aI %s"${sinceArg} -20`;
        const logResult = await this.executionManager.exec(agentId, logCmd, { timeout: 10000 });
        const logOutput = ((logResult.stdout || '') + (logResult.stderr || '')).trim();
        if (logOutput) {
          const agentNameLower = (agent.name || '').toLowerCase();
          const startedAtMs = taskStartedAt ? new Date(taskStartedAt).getTime() : 0;
          type Entry = { hash: string; date: string; msg: string; ts: number };
          const entries: Entry[] = [];
          for (const line of logOutput.split('\n')) {
            const m = line.match(/^([a-f0-9]{40})\s+(\S+)\s+(.*)/);
            if (!m) continue;
            const ts = new Date(m[2]).getTime() || 0;
            entries.push({ hash: m[1], date: m[2], msg: m[3], ts });
          }

          // Pass 1: name-based match (existing convention, highest confidence)
          for (const e of entries) {
            if (agentNameLower && e.msg.toLowerCase().includes(agentNameLower)) {
              const linked = this.addTaskCommit(ownerAgentId, inProgressTask.id, e.hash, e.msg);
              if (linked) {
                linkedCommitCount++;
                console.log(`🔗 [TaskComplete] Auto-detected commit ${e.hash.slice(0, 7)} for task ${inProgressTask.id} (by-name): "${e.msg.slice(0, 60)}"`);
              }
            }
          }

          // Pass 2: date-only fallback. If the agent didn't include its
          // name in the commit message, link every commit authored at-or-
          // after task.startedAt that does NOT mention a different agent
          // (to avoid stealing commits in shared-repo multi-agent setups).
          if (linkedCommitCount === 0 && startedAtMs > 0) {
            const otherAgentNames = [...this.agents.values()]
              .filter((a: any) => a.id !== agentId && a.name)
              .map((a: any) => (a.name as string).toLowerCase());
            for (const e of entries) {
              if (e.ts < startedAtMs) continue;
              const msgLower = e.msg.toLowerCase();
              if (otherAgentNames.some(n => msgLower.includes(n))) continue;
              const linked = this.addTaskCommit(ownerAgentId, inProgressTask.id, e.hash, e.msg);
              if (linked) {
                linkedCommitCount++;
                console.log(`🔗 [TaskComplete] Auto-detected commit ${e.hash.slice(0, 7)} for task ${inProgressTask.id} (by-date): "${e.msg.slice(0, 60)}"`);
              }
            }
          }
        }
        if (linkedCommitCount === 0) {
          console.log(`ℹ️ [TaskComplete] No auto-detectable commits for task ${inProgressTask.id} (agent="${agent.name}")`);
        }
      } catch (e: any) {
        console.warn(`⚠️ [TaskComplete] Auto-detect commits failed: ${e.message}`);
      }
    }

    const ownerAgent = this.agents.get(ownerAgentId);
    if (ownerAgent) saveAgent(ownerAgent);

    // Persist the description change (text + history) so the appended comment
    // survives a restart and is visible to other clients in real time. Without
    // this, the mutation lives only in memory until the workflow engine later
    // calls setTaskStatus — and if that step is skipped/delayed, the comment
    // would never reach the DB.
    if (comment && comment.trim()) {
      try {
        await saveTaskToDb({ ...inProgressTask, agentId: ownerAgentId });
      } catch (err: any) {
        console.warn(`⚠️ [TaskComplete] Failed to persist appended comment for task ${inProgressTask.id}: ${err?.message || err}`);
      }
      const taskPayload: any = { ...inProgressTask, agentId: ownerAgentId };
      if (inProgressTask.assignee) {
        const assigneeAgent = this.agents.get(inProgressTask.assignee);
        taskPayload.assigneeName = assigneeAgent?.name || null;
        taskPayload.assigneeIcon = assigneeAgent?.icon || null;
      }
      this._emit('task:updated', { agentId: ownerAgentId, task: taskPayload });
    }

    console.log(`✅ [TaskComplete] Agent "${agent.name}" signaled completion for task ${inProgressTask.id} (status="${inProgressTask.status}", assignee="${inProgressTask.assignee || 'none'}"): "${comment.slice(0, 120)}"`);
    if (streamCallback) {
      streamCallback(`\n✅ Task execution complete: ${comment.slice(0, 200)}\n`);
    }
    return {
      success: true,
      result: `Task "${inProgressTask.text.slice(0, 80)}" marked as execution complete. Comment: ${comment}`,
      isTerminal: true,
      taskId: inProgressTask.id,
    };
  },

  async _processToolCalls(this: any, agentId: string, response: string, streamCallback: any, depth: number = 0): Promise<any[]> {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    const toolCalls = parseToolCalls(response);

    // Dedup: per-invocation flags for idempotent tools (set by the handlers
    // before their first await — see handlers.ts). Lives once across the loop.
    const dedup: Record<string, boolean> = {};

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
        // Bind agent to the correct execution provider based on runner field or LLM config
        const llmCfg = this.resolveLlmConfig(agent);
        const providerType = agent.runner || (llmCfg.managesContext ? 'claudecode' : 'sandbox');
        const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
        const gitCreds = await getGitHubCredentialsForAgent(agentId, agent.boardId || null);
        const llmConfigForRunner = agent.llmConfigId ? llmCfg : null;
        this.executionManager.bindAgent(agentId, providerType, { ownerId: agent.ownerId || null, gitCredentials: gitCreds, permissions: agent.permissions || null, llmConfig: llmConfigForRunner });

        if (agent.project) {
          const gitUrl = buildRepoCloneUrl(agent.project);
          if (gitUrl) {
            await this.executionManager.ensureProject(agentId, agent.project, gitUrl, gitCreds);
          } else {
            console.warn(`⚠️  [Execution] No git URL derived from agent.project "${agent.project}" — expected "owner/repo" format`);
          }
        } else {
          await this.executionManager.ensureProject(agentId);
          // No project pinned → /projects/ensure won't ship git_credentials.
          // Push them via /credentials/git so the runner still gets
          // ~/.git-credentials + GITHUB_TOKEN exposed to the CLI subprocess.
          if (gitCreds?.token && this.executionManager.installGitCredentials) {
            await this.executionManager.installGitCredentials(agentId, gitCreds);
          }
        }
        console.log(`📦 [Execution] After ensureProject: hasEnvironment=${this.executionManager.hasEnvironment(agentId)}, provider=${providerType}`);
      } catch (err: any) {
        console.error(`⚠️  [Execution] Failed to ensure environment for ${agent.name}:`, err.message);
      }
    }

    const results: any[] = [];
    for (const call of toolCalls) {
      // Per-tool handler table (handlers.ts). A handler returns the result
      // object to push, or null to push nothing (in-response dedup early-outs).
      // Tools without a handler (read_file/write_file/append_file/search_files/
      // run_command + the list_dir cache pre-check) fall through to the generic
      // executeTool path below.
      const handler = HANDLERS[call.tool];
      if (handler) {
        const ctx: HandlerCtx = { mgr: this, agent, agentId, call, streamCallback, dedup };
        const r = await handler(ctx);
        if (r) results.push(r);
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
        const toolLabels: Record<string, (a: any[]) => string> = {
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

        // ── Tool Hooks: pre-execution check ──
        const hookResult = checkToolHooks(agent.toolHooks, call.tool, call.args);
        if (!hookResult.allowed) {
          console.log(`🛡️ [ToolHook] Blocked ${call.tool} for agent "${agent.name}": ${hookResult.message}`);
          results.push({ tool: call.tool, args: call.args, success: false, error: hookResult.message });
          if (streamCallback) {
            streamCallback(`\n✗ ${call.tool} — blocked by security rule\n`);
          }
          continue;
        }
        if (hookResult.matchedRule && hookResult.message) {
          console.log(`🛡️ ${hookResult.message}`);
        }

        const result: any = await executeTool(call.tool, call.args, agent.project, this.executionManager, agentId);

        // Schedule code index re-indexation for file modifications
        if (result.success && (call.tool === 'write_file' || call.tool === 'append_file') && agent.project) {
          const filePath = result.meta?.path || call.args[0];
          const content = call.tool === 'write_file' ? call.args[1] : undefined;
          if (filePath) {
            this.scheduleCodeIndexUpdate(agent.project, filePath, content);
          }
        }

        // Auto-capture commit hashes from git commands and link to task
        if (call.tool === 'run_command' && result.success) {
          const detectedCommits = await _detectCommitHashes(call, result, this.executionManager, agentId);

          if (detectedCommits.length > 0) {
            let targetTask: any = null;
            let ownerAgentId = agentId;

            // Auto-detect active task
            const found = await this._findTaskForCommitLink(agentId);
            targetTask = found?.task || null;
            ownerAgentId = found?.ownerAgentId || agentId;

            if (!targetTask) {
              const taskText = agent.currentTask || detectedCommits[0].msg || 'Commit without task';
              const created = this.addTask(agentId, taskText, { type: 'auto', reason: 'commit-link' });
              if (created) {
                targetTask = this._getAgentTasks(agentId).find((t: any) => t.id === created.id);
                ownerAgentId = agentId;
                console.log(`🔗 [Commit] Auto-created task "${taskText.slice(0, 50)}" for commit linking`);
              }
            }

            if (targetTask) {
              let linkedCount = 0;
              for (const { hash, msg } of detectedCommits) {
                const linked = this.addTaskCommit(ownerAgentId, targetTask.id, hash, msg);
                if (linked) linkedCount++;
              }
              if (linkedCount > 0) {
                const hashPreview = detectedCommits.map(c => c.hash.slice(0, 7)).join(', ');
                console.log(`🔗 [Commit] Auto-linked ${linkedCount} commit(s) [${hashPreview}] to task "${targetTask.text?.slice(0, 50)}" (status=${targetTask.status}, owner=${ownerAgentId.slice(0, 8)})`);
                result.result = `${result.result}\n\n🔗 ${linkedCount} commit(s) automatically linked to task "${targetTask.text?.slice(0, 60)}"`;
              }
            } else {
              console.warn(`⚠️  [Commit] Agent "${agent.name}" committed but no task found to link`);
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
      } catch (err: any) {
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
