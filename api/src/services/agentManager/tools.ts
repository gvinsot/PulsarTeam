// ─── Tools: _processToolCalls ────────────────────────────────────────────────
import { executeTool } from '../agentTools.js';
import { toExecutionToolCall, type NativeToolCall } from '../nativeTools.js';
import { buildRepoCloneUrl } from '../repoUrl.js';
import {
  saveAgent,
  updateTaskFields,
  getTaskByIdPrefix,
  getTaskByActionRunningAgent,
  getTasksByAssignee,
  getActiveTasksByAgent,
  getAllTasks,
} from '../database.js';
import { setTaskSignal } from './tasks.js';
import { checkToolHooks } from '../toolHooks.js';
import { restrictedToolRefusal } from '../security/externalRunProfile.js';
import { getTaskCommitRun, reconcileTaskCommits } from './tools/gitReconcile.js';
import { HANDLERS, appendTaskNote, HandlerCtx } from './tools/handlers.js';
import { enrichAssignee } from '../taskMutations.js';

/** @this {import('./index.js').AgentManager} */
export const toolsMethods = {
  /**
   * Record the completion part of `update_task`: append the agent's summary,
   * link commits, and set the execute-mode completion signal watched by the
   * task loop. Non-execute workflow modes finish through the status move.
   */
  async recordTaskCompletion(
    this: any,
    agentId: string,
    {
      comment = '',
      explicitTaskId = '',
      commitsArg = '',
      streamCallback = null,
    }: { comment?: string; explicitTaskId?: string; commitsArg?: string; streamCallback?: any } = {}
  ): Promise<{ success: boolean; result: string; isTerminal?: boolean; taskId?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`⚠️ [UpdateTask] Completion requested for unknown agent ${agentId}`);
      return { success: false, result: `Agent ${agentId} not found.` };
    }

    let inProgressTask: any = null;
    // Track the owning agent of inProgressTask as we resolve it, so we don't
    // have to re-scan _tasks for the owner later (the previous includes() pass).
    // Nullable because a board-level task carries `agent_id = NULL`: resolving
    // one through getTaskByIdPrefix / getTaskByActionRunningAgent genuinely
    // yields a null owner, which the reads below already have to survive.
    let ownerAgentId: string | null = agentId;

    // If explicit taskId provided, look it up directly (DB, by id or unique prefix)
    if (explicitTaskId) {
      const found = await getTaskByIdPrefix(explicitTaskId);
      if (found) {
        inProgressTask = found;
        ownerAgentId = found.agentId;
      }
      if (!inProgressTask) {
        console.warn(
          `⚠️  [UpdateTask] Explicit taskId "${explicitTaskId}" not found, falling back to auto-detect`
        );
      }
    }

    // Auto-detect: Priority 1: Task actively running via this agent (set by processTransition)
    if (!inProgressTask) {
      const found = await getTaskByActionRunningAgent(agentId);
      if (found && this._isActiveTaskStatus(found.status)) {
        inProgressTask = found;
        ownerAgentId = found.agentId;
      }
    }
    // Auto-detect: Priority 2/3: Active task this agent executes (assignee, or its
    // own unassigned task — getTasksByAssignee is exactly that set).
    if (!inProgressTask) {
      const found = (await getTasksByAssignee(agentId)).find((t: any) =>
        this._isActiveTaskStatus(t.status)
      );
      if (found) {
        inProgressTask = found;
        ownerAgentId = found.agentId;
      }
    }
    // Auto-detect: Priority 3b: Agent's own active task assigned to someone else (rare).
    if (!inProgressTask) {
      const found = (await getActiveTasksByAgent(agentId)).find((t: any) =>
        this._isActiveTaskStatus(t.status)
      );
      if (found) {
        inProgressTask = found;
        ownerAgentId = agentId;
      }
    }

    if (!inProgressTask) {
      // Log diagnostic info to help debug why no task was found
      const allActiveTasks = (await getAllTasks())
        .filter((t: any) => this._isActiveTaskStatus(t.status))
        .map((t: any) => ({
          id: t.id,
          status: t.status,
          assignee: t.assignee,
          actionRunningAgentId: t.actionRunningAgentId,
          ownerId: t.agentId,
        }));
      console.log(
        `⚠️ [UpdateTask] Agent "${agent.name}" (${agentId}) requested completion but no active task was found. Active tasks: ${JSON.stringify(allActiveTasks.slice(0, 5))}`
      );
      return { success: true, result: 'No action needed (no active task).', isTerminal: true };
    }

    // The completion signal consumed by _waitForExecutionComplete only makes
    // sense outside a workflow action mode: decide/refine waits advance on the
    // status move, and a stray signal there could be consumed elsewhere. Fire the
    // signal only when no action mode is running. Commit linking and the summary
    // append happen in EVERY mode (see below) — they are not gated by fireSignal.
    const fireSignal = !inProgressTask.actionRunningMode;

    if (fireSignal) {
      setTaskSignal(inProgressTask.id, 'completed', true);
      setTaskSignal(inProgressTask.id, 'comment', comment);
    }

    // Append the completion comment to the task description, same convention as
    // update_task's task move. This makes the agent's summary visible
    // on the task itself (kanban card) instead of being only relayed to the leader.
    // stampUpdatedAt=true: no setTaskStatus follows here (unlike update_task).
    if (comment && comment.trim()) {
      appendTaskNote(inProgressTask, agent.name, comment, true);
    }

    // ownerAgentId was captured while resolving inProgressTask above.

    // Link commits if provided (format: "hash:message, hash:message").
    // Explicit associations are accepted in every workflow mode.
    if (commitsArg) {
      const commitEntries = commitsArg
        .split(/,\s*(?=[a-f0-9])/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      for (const entry of commitEntries) {
        const colonIdx = entry.indexOf(':');
        const hash = colonIdx > 0 ? entry.slice(0, colonIdx).trim() : entry.trim();
        const msg = colonIdx > 0 ? entry.slice(colonIdx + 1).trim() : '';
        if (hash && /^[a-f0-9]{7,40}$/.test(hash)) {
          await this.addTaskCommit(ownerAgentId, inProgressTask.id, hash, msg);
          console.log(
            `🔗 [UpdateTask] Linked commit ${hash.slice(0, 7)} to task ${inProgressTask.id}`
          );
        }
      }
    }

    // All automatic attribution uses the same evidence and the exact run/task.
    // Explicit links remain available when no execution context survived (e.g.
    // after a restart), or when work was committed in a secondary repository.
    const commitRun = getTaskCommitRun(this, agentId);
    if (commitRun?.taskId === inProgressTask.id) {
      try {
        await reconcileTaskCommits(this, agentId, inProgressTask.id, {
          ...commitRun,
          label: 'UpdateTask',
        });
      } catch (error: any) {
        console.warn(`⚠️ [UpdateTask] Commit reconcile failed: ${error.message}`);
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
        // Persist only the comment fields: the task snapshot predates commit
        // linking, so saving it wholesale would erase the newly linked commits.
        const updated = await updateTaskFields(inProgressTask.id, {
          text: inProgressTask.text,
          history: inProgressTask.history,
        });
        if (updated) inProgressTask = updated;
      } catch (err: any) {
        console.warn(
          `⚠️ [UpdateTask] Failed to persist appended comment for task ${inProgressTask.id}: ${err?.message || err}`
        );
      }
      const taskPayload: any = enrichAssignee(this, { ...inProgressTask, agentId: ownerAgentId });
      this._emit('task:updated', { agentId: ownerAgentId, task: taskPayload });
    }

    console.log(
      `✅ [UpdateTask] Agent "${agent.name}" recorded completion for task ${inProgressTask.id} (status="${inProgressTask.status}", assignee="${inProgressTask.assignee || 'none'}"): "${comment.slice(0, 120)}"`
    );
    if (streamCallback) {
      streamCallback(`\n✅ Task updated: ${comment.slice(0, 200)}\n`);
    }
    return {
      success: true,
      result: `Task "${inProgressTask.text.slice(0, 80)}" completion recorded. Comment: ${comment}`,
      isTerminal: true,
      taskId: inProgressTask.id,
    };
  },

  async _processToolCalls(
    this: any,
    agentId: string,
    nativeToolCalls: NativeToolCall[],
    streamCallback: any,
    depth: number = 0
  ): Promise<any[]> {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    const toolCalls = nativeToolCalls.map(toExecutionToolCall);

    // Dedup: per-invocation flags for idempotent tools (set by the handlers
    // before their first await — see handlers.ts). Lives once across the loop.
    const dedup: Record<string, boolean> = {};

    console.log(
      `\n🔧 [Tools] Received ${toolCalls.length} native call(s) from "${agent.name}" (depth=${depth})`
    );

    if (toolCalls.length === 0) {
      return [];
    }

    console.log(
      `🔧 Agent ${agent.name} executing ${toolCalls.length} tool(s) (project=${agent.project || 'none'}, execution=${this.executionManager ? (this.executionManager.hasEnvironment(agentId) ? 'ready' : 'not-initialized') : 'no-manager'})`
    );

    if (this.executionManager) {
      try {
        // Bind agent to the correct execution provider based on runner field or LLM config
        const llmCfg = this.resolveLlmConfig(agent);
        const providerType = agent.runner || (llmCfg.managesContext ? 'claudecode' : 'sandbox');
        const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
        const gitCreds = await getGitHubCredentialsForAgent(agentId, agent.boardId || null);
        const llmConfigForRunner = agent.llmConfigId ? llmCfg : null;
        this.executionManager.bindAgent(agentId, providerType, {
          ownerId: agent.ownerId || null,
          gitCredentials: gitCreds,
          permissions: agent.permissions || null,
          llmConfig: llmConfigForRunner,
        });

        if (agent.project) {
          const gitUrl = buildRepoCloneUrl(agent.project);
          if (gitUrl) {
            await this.executionManager.ensureProject(agentId, agent.project, gitUrl, gitCreds);
          } else {
            console.warn(
              `⚠️  [Execution] No git URL derived from agent.project "${agent.project}" — expected "owner/repo" format`
            );
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
        console.log(
          `📦 [Execution] After ensureProject: hasEnvironment=${this.executionManager.hasEnvironment(agentId)}, provider=${providerType}`
        );
      } catch (err: any) {
        console.error(
          `⚠️  [Execution] Failed to ensure environment for ${agent.name}:`,
          err.message
        );
      }
    }

    const results: any[] = [];
    for (const call of toolCalls) {
      const resultStart = results.length;
      try {
        if (call.error) {
          results.push({ tool: call.tool, args: call.args, success: false, error: call.error });
          continue;
        }
        // Per-tool handler table (handlers.ts). A handler returns the result
        // object to push, or null to push nothing (in-response dedup early-outs).
        // Tools without a handler (read_file/write_file/append_file/search_files/
        // run_command + the list_dir cache pre-check) fall through to the generic
        // executeTool path below.
        // Restricted profile of an external task (security/externalRunProfile.ts):
        // checked BEFORE the handler table, because mcp_call, ask_agent and
        // update_task are handlers and would otherwise never reach the hooks.
        const profileRefusal = restrictedToolRefusal(agent, call.tool, call.args || []);
        if (profileRefusal) {
          console.log(`🛡️ [SecurityProfile] Blocked ${call.tool} for agent "${agent.name}"`);
          results.push({ tool: call.tool, args: call.args, success: false, error: profileRefusal });
          if (streamCallback) {
            streamCallback(`\n✗ ${call.tool} — blocked by the external-task security profile\n`);
          }
          continue;
        }

        const handler = HANDLERS[call.tool];
        if (handler) {
          const ctx: HandlerCtx = { mgr: this, agent, agentId, call, streamCallback, dedup, depth };
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
          if (cached && ldNow - cached.at < 30000) {
            console.log(
              `[Dedup] Skipping list_dir(${dirPath}) from "${agent.name}" — listed ${Math.round((ldNow - cached.at) / 1000)}s ago`
            );
            results.push({
              tool: 'list_dir',
              args: call.args,
              success: true,
              result: cached.result,
            });
            continue;
          }
        }

        try {
          const toolLabels: Record<string, (a: any[]) => string> = {
            write_file: a => `Writing ${a[0] || ''}`,
            append_file: a => `Appending to ${a[0] || ''}`,
            read_file: a => `Reading ${a[0] || ''}`,
            list_dir: a => `Listing ${a[0] || '.'}`,
            search_files: a => `Searching ${a[0] || '*'} for "${a[1] || ''}"`,
            run_command: a => `Running: ${(a[0] || '').slice(0, 80)}`,
          };
          const labelFn = toolLabels[call.tool];
          const toolLabel = labelFn ? labelFn(call.args) : call.tool;
          agent.currentThinking = toolLabel;
          this._emit('agent:thinking', { agentId, thinking: agent.currentThinking });

          this._emit('agent:tool:start', {
            agentId,
            agentName: agent.name,
            project: agent.project || null,
            tool: call.tool,
            args: call.args,
          });

          // ── Tool Hooks: pre-execution check ──
          const hookResult = checkToolHooks(agent.toolHooks, call.tool, call.args);
          if (!hookResult.allowed) {
            console.log(
              `🛡️ [ToolHook] Blocked ${call.tool} for agent "${agent.name}": ${hookResult.message}`
            );
            results.push({
              tool: call.tool,
              args: call.args,
              success: false,
              error: hookResult.message,
            });
            if (streamCallback) {
              streamCallback(`\n✗ ${call.tool} — blocked by security rule\n`);
            }
            continue;
          }
          if (hookResult.matchedRule && hookResult.message) {
            console.log(`🛡️ ${hookResult.message}`);
          }

          const commandCommitRun = getTaskCommitRun(this, agentId);
          const result = await executeTool(
            call.tool,
            call.args,
            agent.project,
            this.executionManager,
            agentId
          );

          // Schedule code index re-indexation for file modifications
          if (
            result.success &&
            (call.tool === 'write_file' || call.tool === 'append_file') &&
            agent.project
          ) {
            const filePath = result.meta?.path || call.args[0];
            const content = call.tool === 'write_file' ? call.args[1] : undefined;
            if (filePath) {
              this.scheduleCodeIndexUpdate(agent.project, filePath, content);
            }
          }

          // A failed command may still have created commits (commit && push).
          // Never associate push tips or terminal text with a guessed task.
          if (
            call.tool === 'run_command' &&
            commandCommitRun &&
            /\bgit\b/.test(call.args[0] || '')
          ) {
            try {
              await reconcileTaskCommits(this, agentId, commandCommitRun.taskId, {
                ...commandCommitRun,
                label: 'RunCommand',
              });
            } catch (error: any) {
              console.warn(`⚠️ [Commit] Command reconcile failed: ${error.message}`);
            }
          }

          results.push({ tool: call.tool, args: call.args, ...result });

          // Cache list_dir results for cross-turn dedup
          if (call.tool === 'list_dir' && result.success) {
            if (!agent._lastListDirCache) agent._lastListDirCache = {};
            agent._lastListDirCache[call.args[0] || '.'] = {
              result: result.result,
              at: Date.now(),
            };
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
              // Optional chain, not an assertion: `result` is declared optional on
              // ToolResult because the failure branch may omit it.
              preview: result.result?.slice(0, 300),
            });
          } else {
            console.warn(
              `⚠️  [Tool Error] Agent "${agent.name}" — ${call.tool}(${(call.args[0] || '').slice(0, 80)}): ${result.error}`
            );

            this._emit('agent:tool:error', {
              agentId,
              agentName: agent.name,
              project: agent.project || null,
              tool: call.tool,
              args: call.args,
              error: result.error || 'Unknown error',
              output: result.result || null,
              timestamp: new Date().toISOString(),
            });

            if (streamCallback) {
              const outputSnippet = result.result
                ? `\n\`\`\`\n${result.result.slice(0, 500)}\n\`\`\``
                : '';
              streamCallback(
                `\n\n⚠️ **Tool error** \`${call.tool}(${(call.args[0] || '').slice(0, 100)})\`: ${result.error}${outputSnippet}\n`
              );
            }
          }
        } catch (err: any) {
          console.error(`❌ [Tool Crash] Agent "${agent.name}" — ${call.tool}: ${err.message}`);

          results.push({
            tool: call.tool,
            args: call.args,
            success: false,
            error: err.message,
          });

          this._emit('agent:tool:error', {
            agentId,
            agentName: agent.name,
            project: agent.project || null,
            tool: call.tool,
            args: call.args,
            error: err.message,
            timestamp: new Date().toISOString(),
          });

          if (streamCallback) {
            streamCallback(
              `\n\n❌ **Tool crashed** \`${call.tool}(${(call.args[0] || '').slice(0, 100)})\`: ${err.message}\n`
            );
          }
        }
      } finally {
        for (const result of results.slice(resultStart)) {
          result.toolCallId = call.id;
        }
      }
    }

    return results;
  },
};
