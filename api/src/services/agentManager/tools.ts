// ─── Tools: _processToolCalls ────────────────────────────────────────────────
import { parseToolCalls, executeTool } from '../agentTools.js';
import { buildRepoCloneUrl } from '../repoUrl.js';
import { saveAgent, searchAgentSkills, getAgentSkillById, saveAgentSkill, deleteAgentSkillFromDb, getAllBoards, getBoardById, getTasksByStatusAndBoard, saveTaskToDb } from '../database.js';
import { getWorkflowForBoard } from '../configManager.js';
import { setTaskSignal } from './tasks.js';
import { checkToolHooks } from '../toolHooks.js';
import { findBuiltinMcpServer } from '../mcpManager.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Commit detection helpers ────────────────────────────────────────────────

/** Check if a command string represents a git operation that creates or moves commits */
function _isGitMutatingCmd(rawCmd: string): boolean {
  if (!rawCmd.includes('git')) return false;
  if (/--dry-run|--help/.test(rawCmd)) return false;
  // Exclude read-only git commands that happen to be part of a chain
  // but keep commit, push, merge, cherry-pick, rebase, am, pull
  return /\b(commit|push|merge|cherry-pick|rebase|am|pull)\b/.test(rawCmd);
}

/** Check if git output indicates nothing actually happened */
function _isGitNoop(output: string): boolean {
  return /nothing to commit/i.test(output) ||
    /everything up-to-date/i.test(output) ||
    /no changes added to commit/i.test(output) ||
    /nothing added to commit/i.test(output) ||
    /already up.to.date/i.test(output) ||
    /^current branch .+ is up to date/im.test(output);
}

/** Check if git output indicates a fatal error (should not try to link commits) */
function _isGitError(output: string): boolean {
  return /^fatal:/im.test(output) ||
    /^error: failed to push/im.test(output) ||
    /rejected\b.*\bnon-fast-forward/i.test(output) ||
    /permission denied/i.test(output) ||
    /authentication failed/i.test(output) ||
    /could not read from remote/i.test(output) ||
    /unable to access/i.test(output) ||
    /not a git repository/i.test(output);
}

/** Check if git output suggests a successful operation */
function _isGitSuccess(output: string): boolean {
  return (
    // git commit indicators
    /(\d+ files? changed|\d+ insertion|\d+ deletion|create mode|new file)/i.test(output) ||
    // git push indicators (ref update, new branch, new tag)
    /[a-f0-9]{7,}\.\.\.?[a-f0-9]{7,}\s+\S+\s*->\s*\S+/.test(output) ||
    /\[new branch\]/i.test(output) ||
    /\[new tag\]/i.test(output) ||
    /\[new ref\]/i.test(output) ||
    // git merge/rebase indicators
    /merge made by/i.test(output) ||
    /fast-forward/i.test(output) ||
    /successfully rebased/i.test(output) ||
    /applying:/i.test(output)
  );
}

/**
 * Detect commit hashes from a run_command tool call result.
 * Returns an array of { hash, msg } objects (may be empty).
 * Handles: git commit, git push (including push ranges), git merge,
 * git cherry-pick, git rebase, chained commands.
 */
async function _detectCommitHashes(call: any, result: any, executionManager: any, agentId: string): Promise<Array<{ hash: string; msg: string }>> {
  if (typeof result.result !== 'string') return [];
  const rawCmd = (call.args[0] || '').toLowerCase();
  if (!_isGitMutatingCmd(rawCmd)) return [];

  const output = result.result;
  // Skip if the output indicates an error or nothing happened
  if (_isGitNoop(output)) return [];
  if (_isGitError(output)) return [];
  // Non-zero exit code: only skip if output has NO commit indicators.
  // Chained commands (e.g. "git commit && git push") can have exitCode != 0
  // when push fails but commit succeeded — we still want to capture the commit hash.
  if (result.meta?.exitCode && result.meta.exitCode !== 0) {
    if (!_isGitSuccess(output)) return [];
    console.log(`🔗 [Commit] Non-zero exit (${result.meta.exitCode}) but output has commit indicators — continuing detection`);
  }

  const commits: Array<{ hash: string; msg: string }> = [];
  const seenHashes = new Set<string>(); // prefix-aware dedup within this detection pass

  const _addCommit = (hash: string, msg: string) => {
    if (!hash || !/^[a-f0-9]{7,40}$/.test(hash)) return;
    // Prefix-aware dedup: check if we already have this hash (short or full)
    for (const seen of seenHashes) {
      if (seen === hash || seen.startsWith(hash) || hash.startsWith(seen)) {
        // If the new hash is longer (more precise), replace the shorter one
        if (hash.length > seen.length) {
          seenHashes.delete(seen);
          const idx = commits.findIndex(c => c.hash === seen);
          if (idx !== -1) { commits[idx].hash = hash; if (msg && !commits[idx].msg) commits[idx].msg = msg; }
          seenHashes.add(hash);
        }
        return;
      }
    }
    seenHashes.add(hash);
    commits.push({ hash, msg: (msg || '').slice(0, 200) });
  };

  // ── Pattern 1: git commit output — [branch hash] message ──
  const commitMatch = output.match(/\[[^\]]*\s([a-f0-9]{7,40})\]/);
  if (commitMatch) {
    let msg = '';
    const fullLineMatch = output.match(/\[[^\]]+\]\s+(.+)/);
    if (fullLineMatch) msg = fullLineMatch[1].trim();
    _addCommit(commitMatch[1], msg);
  }

  // ── Pattern 2: git push output — old..new branch -> branch ──
  // Also captures the range (old..new) for multi-commit push detection.
  const pushMatch = output.match(/\+?([a-f0-9]{7,40})\.\.\.?([a-f0-9]{7,40})\s+\S+\s*->\s*\S+/);
  let pushOldHash: string | null = null;
  let pushNewHash: string | null = null;
  if (pushMatch) {
    pushOldHash = pushMatch[1];
    pushNewHash = pushMatch[2];
    _addCommit(pushNewHash, '');
    console.log(`🔗 [Commit] Detected push range: ${pushOldHash.slice(0, 7)}..${pushNewHash.slice(0, 7)}`);
  }

  // ── Pattern 3: HEAD is now at <hash> (from rebase, cherry-pick, etc.) ──
  if (commits.length === 0) {
    const headMatch = output.match(/HEAD is now at ([a-f0-9]{7,40})/i);
    if (headMatch) _addCommit(headMatch[1], '');
  }

  // ── Fallback: query HEAD from execution environment ──
  // Covers: new branch pushes, unusual output formats, merge commits, etc.
  if (commits.length === 0 && executionManager?.hasEnvironment(agentId) && _isGitSuccess(output)) {
    try {
      const headResult = await executionManager.exec(agentId, 'git log --format="%H %s" -1', { timeout: 10000 });
      const headOutput = ((headResult.stdout || '') + (headResult.stderr || '')).trim();
      const headMatch = headOutput.match(/^([a-f0-9]{40})\s+(.*)/);
      if (headMatch) {
        _addCommit(headMatch[1], headMatch[2]);
        console.log(`🔗 [Commit] Fallback: captured HEAD ${headMatch[1].slice(0, 7)} via git log (cmd="${rawCmd.slice(0, 60)}")`);
      }
    } catch (e: any) {
      console.warn(`⚠️  [Commit] Fallback git log failed: ${e.message}`);
    }
  }

  // ── Resolve short hashes to full 40-char and fetch all commits in push range ──
  if (commits.length > 0 && executionManager?.hasEnvironment(agentId)) {
    // If we detected a push range, fetch ALL commits in that range
    if (pushOldHash && pushNewHash && commits.length <= 2) {
      try {
        const rangeResult = await executionManager.exec(agentId, `git log --format="%H %s" ${pushOldHash}..${pushNewHash}`, { timeout: 10000 });
        const rangeOutput = ((rangeResult.stdout || '') + (rangeResult.stderr || '')).trim();
        if (rangeOutput) {
          for (const line of rangeOutput.split('\n')) {
            const m = line.match(/^([a-f0-9]{40})\s+(.*)/);
            if (m) _addCommit(m[1], m[2]);
          }
          console.log(`🔗 [Commit] Push range: found ${commits.length} commit(s) in ${pushOldHash.slice(0, 7)}..${pushNewHash.slice(0, 7)}`);
        }
      } catch (e: any) {
        console.warn(`⚠️  [Commit] Push range log failed: ${e.message}`);
      }
    }

    // Resolve any remaining short hashes to full 40-char hashes
    for (const c of commits) {
      if (c.hash.length < 40) {
        try {
          const revResult = await executionManager.exec(agentId, `git rev-parse ${c.hash}`, { timeout: 5000 });
          const fullHash = ((revResult.stdout || '') + (revResult.stderr || '')).trim();
          if (/^[a-f0-9]{40}$/.test(fullHash)) {
            c.hash = fullHash;
          }
        } catch { /* keep short hash */ }
      }
    }
  }

  // Diagnostic: log when a git mutating command ran but no hash was detected
  if (commits.length === 0 && !_isGitNoop(output)) {
    console.warn(`⚠️  [Commit] No hash detected for git command. cmd="${rawCmd.slice(0, 120)}" output="${output.slice(0, 300)}"`);
  }

  return commits;
}

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

    // If explicit taskId provided, look it up directly
    if (explicitTaskId) {
      for (const [creatorId, tasks] of this._tasks) {
        const found = (tasks as any[]).find((t: any) => t.id === explicitTaskId) ||
                      (tasks as any[]).find((t: any) => t.id.startsWith(explicitTaskId));
        if (found) { inProgressTask = found; break; }
      }
      if (!inProgressTask) {
        console.warn(`⚠️  [TaskComplete] Explicit taskId "${explicitTaskId}" not found, falling back to auto-detect`);
      }
    }

    // Auto-detect: Priority 1: Task actively running via this agent (set by processTransition)
    if (!inProgressTask) {
      for (const [ownerId, tasks] of this._tasks) {
        const found = (tasks as any[]).find((t: any) => t.actionRunningAgentId === agentId && this._isActiveTaskStatus(t.status));
        if (found) { inProgressTask = found; break; }
      }
    }
    // Auto-detect: Priority 2: Active task explicitly assigned to this agent
    if (!inProgressTask) {
      for (const [ownerId, tasks] of this._tasks) {
        const found = (tasks as any[]).find((t: any) => this._isActiveTaskStatus(t.status) && t.assignee === agentId);
        if (found) { inProgressTask = found; break; }
      }
    }
    // Auto-detect: Priority 3: Agent's own active task
    if (!inProgressTask) {
      inProgressTask = this._getAgentTasks(agentId).find((t: any) => this._isActiveTaskStatus(t.status));
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

    // Set both legacy in-memory flag AND the signal system for reliable detection
    inProgressTask._executionCompleted = true;
    inProgressTask._executionComment = comment;
    setTaskSignal(inProgressTask.id, 'completed', true);
    setTaskSignal(inProgressTask.id, 'comment', comment);

    // Append the completion comment to the task description, same convention as
    // @update_task(taskId, status, details). This makes the agent's summary visible
    // on the task itself (kanban card) instead of being only relayed to the leader.
    if (comment && comment.trim()) {
      const separator = '\n\n---\n';
      const detailBlock = `**[${agent.name}]** ${comment.trim()}`;
      inProgressTask.text = (inProgressTask.text || '') + separator + detailBlock;
      if (!inProgressTask.history) inProgressTask.history = [];
      inProgressTask.history.push({
        status: inProgressTask.status,
        at: new Date().toISOString(),
        by: agent.name,
        type: 'edit',
        field: 'text',
        oldValue: null,
        newValue: detailBlock,
      });
      inProgressTask.updatedAt = new Date().toISOString();
    }

    // Find ownerAgentId for this task
    let ownerAgentId: string | null = null;
    for (const [ownerId, tasks] of this._tasks) {
      if ((tasks as any[]).includes(inProgressTask)) { ownerAgentId = ownerId as string; break; }
    }
    ownerAgentId = ownerAgentId || agentId;

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
      // ── @task_execution_complete() ──
      if (call.tool === 'task_execution_complete') {
        if (taskExecutionCompleteDone) {
          console.log(`[Dedup] Skipping duplicate @task_execution_complete from "${agent.name}"`);
          continue;
        }
        taskExecutionCompleteDone = true;
        // Validate args: taskId (arg[1]) must look like a UUID or UUID prefix.
        // If it doesn't, it's part of the comment (the parser split on a comma in natural language).
        const UUID_PREFIX_RE = /^[a-f0-9]{8,}(-[a-f0-9]{4,}){0,4}$/i;
        let comment = call.args[0] || '';
        let explicitTaskId = (call.args[1] || '').trim();
        let commitsArgRaw = call.args[2] || '';
        if (explicitTaskId && !UUID_PREFIX_RE.test(explicitTaskId)) {
          // Not a valid taskId — merge back into comment
          comment = call.args.filter(Boolean).join(', ');
          explicitTaskId = '';
          commitsArgRaw = '';
        }
        // Shared with the Swarm API MCP tool of the same name (used by CLI
        // runner agents, which call MCP tools instead of @-syntax). See
        // applyTaskExecutionComplete below.
        const outcome = await this.applyTaskExecutionComplete(agentId, {
          comment,
          explicitTaskId,
          commitsArg: commitsArgRaw,
          streamCallback,
        });
        results.push({ tool: 'task_execution_complete', args: call.args, ...outcome });
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
        let task: any = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
        if (!task) task = this._getAgentTasks(agentId).find((t: any) => t.id.startsWith(taskId));
        let taskAgentId = agentId;
        if (!task) {
          for (const [creatorId, tasks] of this._tasks) {
            const found = (tasks as any[]).find((t: any) => t.id === taskId || t.id.startsWith(taskId));
            if (found) {
              task = found;
              taskAgentId = creatorId as string;
              break;
            }
          }
        }
        if (!task) {
          const partial = this._getAgentTasks(agentId).find((t: any) => t.id.startsWith(taskId.slice(0, 8)));
          const hint = partial ? ` Maybe you meant ${partial.id.slice(0, 8)} which is currently "${partial.status}"?` : '';
          results.push({ tool: 'update_task', args: call.args, success: false, error: `Task not found: ${taskId}.${hint}` });
          continue;
        }

        // Validate status against the board workflow. Agents must move tasks
        // only to columns that exist in the board — otherwise the task lands
        // in an invisible/unreachable state. Case-insensitive match is used
        // so "Resolution" still resolves to "resolution".
        //
        // Validation is strict: if we can't confirm the status is a valid
        // column we reject. A silent fallback to the raw status (previous
        // behavior) used to let bad statuses slip through when the board
        // lookup failed or the task had no boardId.
        let newStatus = rawStatus;
        if (!rawStatus || !String(rawStatus).trim()) {
          results.push({
            tool: 'update_task',
            args: call.args,
            success: false,
            error: 'Status is required. Use: @update_task(taskId, <new_status>)',
          });
          continue;
        }
        if (!task.boardId) {
          results.push({
            tool: 'update_task',
            args: call.args,
            success: false,
            error: `Cannot update status: task ${task.id} is not bound to a board.`,
          });
          continue;
        }
        let wf: any;
        try {
          wf = await getWorkflowForBoard(task.boardId);
        } catch (err: any) {
          results.push({
            tool: 'update_task',
            args: call.args,
            success: false,
            error: `Cannot validate status: failed to load workflow for board ${task.boardId} (${err?.message || 'unknown error'}).`,
          });
          continue;
        }
        if (!wf?.columns?.length) {
          results.push({
            tool: 'update_task',
            args: call.args,
            success: false,
            error: `Cannot update status: board ${task.boardId} has no workflow columns configured.`,
          });
          continue;
        }
        const match = wf.columns.find((c: any) => c.id.toLowerCase() === String(rawStatus).toLowerCase());
        if (!match) {
          const validIds = wf.columns.map((c: any) => c.id).join(', ');
          results.push({
            tool: 'update_task',
            args: call.args,
            success: false,
            error: `Invalid status "${rawStatus}" for this task's board. Valid columns: ${validIds}.`,
          });
          continue;
        }
        if (match.id !== rawStatus) {
          console.log(`[UpdateTask] Normalizing status "${rawStatus}" → "${match.id}"`);
        }
        newStatus = match.id;

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

        // In workflow action modes (decide, refine, etc.), stop the chat loop after status change
        const isWorkflowMode = task.actionRunningMode && task.actionRunningMode !== 'execute';
        if (isWorkflowMode) {
          console.log(`📋 [Task] Workflow mode "${task.actionRunningMode}" — marking @update_task as terminal`);
        }
        results.push({ tool: 'update_task', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" updated to ${newStatus}${details ? ' with details appended' : ''}`, isTerminal: isWorkflowMode || undefined });
        continue;
      }

      // ── @move_task_to_board() ──
      if (call.tool === 'move_task_to_board') {
        const [taskId, targetBoardId] = call.args;
        if (!taskId || !targetBoardId) {
          results.push({ tool: 'move_task_to_board', args: call.args, success: false, error: 'Both taskId and boardId are required. Use: @move_task_to_board(taskId, boardId)' });
          continue;
        }
        // Find the task across all agents
        let task: any = null;
        let taskAgentId = agentId;
        for (const [creatorId, tasks] of this._tasks) {
          const found = (tasks as any[]).find((t: any) => t.id === taskId || t.id.startsWith(taskId));
          if (found) { task = found; taskAgentId = creatorId as string; break; }
        }
        if (!task) {
          results.push({ tool: 'move_task_to_board', args: call.args, success: false, error: `Task not found: ${taskId}` });
          continue;
        }
        // Verify target board exists
        const targetBoard = await getBoardById(targetBoardId);
        if (!targetBoard) {
          results.push({ tool: 'move_task_to_board', args: call.args, success: false, error: `Board not found: ${targetBoardId}` });
          continue;
        }
        const oldBoardId = task.boardId;
        task.boardId = targetBoardId;
        // Check if current status exists in target board's workflow, otherwise reset to first column
        if (targetBoard.workflow?.columns) {
          const hasStatus = targetBoard.workflow.columns.some((c: any) => c.id === task.status);
          if (!hasStatus && targetBoard.workflow.columns.length > 0) {
            const firstCol = targetBoard.workflow.columns[0].id;
            console.log(`📋 [MoveBoard] Task status "${task.status}" not found in target board — resetting to "${firstCol}"`);
            task.status = firstCol;
          }
        }
        if (!task.history) task.history = [];
        task.history.push({ status: task.status, at: new Date().toISOString(), by: agent.name, type: 'board_move', oldBoardId, newBoardId: targetBoardId });
        try {
          await saveTaskToDb({ ...task, agentId: taskAgentId });
        } catch (err: any) {
          results.push({ tool: 'move_task_to_board', args: call.args, success: false, error: `Failed to persist board move: ${err?.message || err}` });
          continue;
        }
        const ownerAgent = this.agents.get(taskAgentId);
        if (ownerAgent) {
          saveAgent(ownerAgent);
          this._emit('agent:updated', this._sanitize(ownerAgent));
        }
        this._emit('task:updated', { agentId: taskAgentId, task: { ...task, agentId: taskAgentId } });
        console.log(`📋 [MoveBoard] Agent "${agent.name}" moved task "${task.text.slice(0, 50)}" to board "${targetBoard.name}" (${targetBoardId})`);
        results.push({ tool: 'move_task_to_board', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" moved to board "${targetBoard.name}" (status: ${task.status})` });
        continue;
      }

      // ── @delete_task() ──
      if (call.tool === 'delete_task') {
        const taskId = (call.args[0] || '').trim();
        if (!taskId) {
          results.push({ tool: 'delete_task', args: call.args, success: false, error: 'Task ID is required. Use: @delete_task(taskId)' });
          continue;
        }
        // Find the task across all agents
        let task: any = null;
        let taskAgentId = agentId;
        for (const [creatorId, tasks] of this._tasks) {
          const found = (tasks as any[]).find((t: any) => t.id === taskId || t.id.startsWith(taskId));
          if (found) { task = found; taskAgentId = creatorId as string; break; }
        }
        if (!task) {
          results.push({ tool: 'delete_task', args: call.args, success: false, error: `Task not found: ${taskId}` });
          continue;
        }
        const deleted = await this.deleteTask(taskAgentId, task.id);
        if (deleted) {
          console.log(`🗑️ [DeleteTask] Agent "${agent.name}" deleted task "${task.text.slice(0, 50)}" (${task.id})`);
          results.push({ tool: 'delete_task', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" (${task.id}) deleted successfully.` });
        } else {
          results.push({ tool: 'delete_task', args: call.args, success: false, error: `Failed to delete task: ${taskId}` });
        }
        continue;
      }

      // ── @list_boards() ──
      if (call.tool === 'list_boards') {
        try {
          const boards = await getAllBoards();
          if (boards.length === 0) {
            results.push({ tool: 'list_boards', args: [], success: true, result: 'No boards found.' });
          } else {
            const lines = boards.map((b: any) => {
              const cols = b.workflow?.columns?.map((c: any) => c.id).join(', ') || 'none';
              const defaultTag = b.is_default ? ' [DEFAULT]' : '';
              return `- **${b.name}**${defaultTag} (${b.id})\n  Columns: ${cols}`;
            });
            results.push({ tool: 'list_boards', args: [], success: true, result: `Found ${boards.length} board(s):\n\n${lines.join('\n\n')}` });
          }
          console.log(`📋 [ListBoards] Agent "${agent.name}" listed ${boards.length} board(s)`);
        } catch (err: any) {
          results.push({ tool: 'list_boards', args: [], success: false, error: err.message });
        }
        continue;
      }

      // ── @list_tasks(status, boardId) ──
      if (call.tool === 'list_tasks') {
        const statusFilter = (call.args[0] || '').trim() || null;
        const boardFilter = (call.args[1] || '').trim() || null;
        try {
          // Validate that the requested board exists before querying. Without
          // this, an unknown boardId silently returns an empty list which
          // makes agent debugging painful.
          let resolvedBoard: any = null;
          if (boardFilter) {
            resolvedBoard = await getBoardById(boardFilter);
            if (!resolvedBoard) {
              results.push({
                tool: 'list_tasks',
                args: call.args,
                success: false,
                error: `Board not found: ${boardFilter}. Use @list_boards to discover valid board IDs.`,
              });
              continue;
            }
            // When both board and status are provided, verify the status
            // exists in that board's workflow. (When only a status is
            // provided we accept it — the agent may be filtering tasks
            // across multiple boards.)
            if (statusFilter && resolvedBoard.workflow?.columns?.length) {
              const match = resolvedBoard.workflow.columns.find(
                (c: any) => c.id?.toLowerCase() === statusFilter.toLowerCase()
              );
              if (!match) {
                const validIds = resolvedBoard.workflow.columns.map((c: any) => c.id).join(', ');
                results.push({
                  tool: 'list_tasks',
                  args: call.args,
                  success: false,
                  error: `Invalid status "${statusFilter}" for board "${resolvedBoard.name || boardFilter}". Valid columns: ${validIds}.`,
                });
                continue;
              }
            }
          }
          const tasks = await getTasksByStatusAndBoard(statusFilter, boardFilter);
          if (tasks.length === 0) {
            const filterDesc = [statusFilter ? `status="${statusFilter}"` : null, boardFilter ? `board="${boardFilter}"` : null].filter(Boolean).join(', ');
            results.push({ tool: 'list_tasks', args: call.args, success: true, result: `No tasks found${filterDesc ? ` matching ${filterDesc}` : ''}.` });
          } else {
            // Group by board for clarity
            const boardName: Record<string, string> = {};
            for (const t of tasks as any[]) {
              if (t.boardId && !boardName[t.boardId]) {
                const board = await getBoardById(t.boardId);
                boardName[t.boardId] = board?.name || t.boardId;
              }
            }
            const lines = (tasks as any[]).map((t: any) => {
              const board = t.boardId ? ` [Board: ${boardName[t.boardId] || t.boardId}]` : '';
              const assigneeInfo = t.assignee ? ` (assignee: ${t.assignee.slice(0, 8)})` : '';
              return `- [${t.status}] ${t.id.slice(0, 8)} — ${t.text.slice(0, 100)}${board}${assigneeInfo}`;
            });
            const filterDesc = [statusFilter ? `status="${statusFilter}"` : null, boardFilter ? `board="${boardFilter}"` : null].filter(Boolean).join(', ');
            results.push({ tool: 'list_tasks', args: call.args, success: true, result: `Found ${tasks.length} task(s)${filterDesc ? ` matching ${filterDesc}` : ''}:\n\n${lines.join('\n')}` });
          }
          console.log(`📋 [ListTasks] Agent "${agent.name}" listed tasks (status=${statusFilter || 'all'}, board=${boardFilter || 'all'}) — ${tasks.length} result(s)`);
        } catch (err: any) {
          results.push({ tool: 'list_tasks', args: call.args, success: false, error: err.message });
        }
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
        const taskHash = JSON.stringify(this._getAgentTasks(agentId).map((t: any) => `${t.id}:${t.status}`));
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
          // Resolve board names for display
          const boardNames: Record<string, string> = {};
          for (const t of tasks) {
            if ((t as any).boardId && !boardNames[(t as any).boardId]) {
              try {
                const board = await getBoardById((t as any).boardId);
                boardNames[(t as any).boardId] = board?.name || (t as any).boardId;
              } catch { boardNames[(t as any).boardId] = (t as any).boardId; }
            }
          }
          const lines = tasks.map((t: any) => {
            const icon = t.status === 'done' ? '[x]' : t.status === 'error' ? '[!]' : this._isActiveTaskStatus(t.status) ? '[~]' : '[ ]';
            const boardInfo = t.boardId ? ` [Board: ${boardNames[t.boardId] || t.boardId}]` : '';
            return `${icon} ${t.id} — ${t.text}${boardInfo}`;
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
        const waitingTasks = todoList.filter((t: any) => !this._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error').length;
        const activeCount = todoList.filter((t: any) => this._isActiveTaskStatus(t.status)).length;
        const doneTasks = todoList.filter((t: any) => t.status === 'done').length;
        const errorTasks = todoList.filter((t: any) => t.status === 'error').length;
        const totalTasks = todoList.length;
        const msgCount = (agent.conversationHistory || []).length;
        const hasSandbox = this.executionManager ? this.executionManager.hasEnvironment(agent.id) : false;
        const currentActiveTask = todoList.find((t: any) => this._isActiveTaskStatus(t.status));
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
        const activeTasks = todoList.filter((t: any) => t.status !== 'done');
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

      // ── @search_skill(query) ──
      if (call.tool === 'search_skill') {
        const query = (call.args[0] || '').trim();
        if (!query) {
          results.push({ tool: 'search_skill', args: call.args, success: false, error: 'Search query is required. Use: @search_skill(keyword)' });
          continue;
        }
        try {
          const skills = await searchAgentSkills(query);
          if (skills.length === 0) {
            results.push({ tool: 'search_skill', args: call.args, success: true, result: `No skills found matching "${query}".` });
          } else {
            const lines = skills.map((s: any) => {
              const mcps = Array.isArray(s.mcpServerIds) && s.mcpServerIds.length > 0 ? ` [MCPs: ${s.mcpServerIds.join(', ')}]` : '';
              return `- **${s.name}** (${s.id})\n  Category: ${s.category || 'general'}${mcps}\n  ${s.description || 'No description'}\n  Created by: ${s.createdBy || 'unknown'} | Updated: ${s.updatedAt || 'unknown'} | Used: ${s.useCount || 0} times`;
            });
            results.push({ tool: 'search_skill', args: call.args, success: true, result: `Found ${skills.length} skill(s) matching "${query}":\n\n${lines.join('\n\n')}` });
          }
          console.log(`🔍 [Skill Search] Agent "${agent.name}" searched for "${query}" — ${skills.length} result(s)`);
        } catch (err: any) {
          results.push({ tool: 'search_skill', args: call.args, success: false, error: err.message });
        }
        continue;
      }

      // ── @create_skill(name, JSON) ──
      if (call.tool === 'create_skill') {
        const skillName = (call.args[0] || '').trim();
        const dataArg = call.args[1] || '{}';
        if (!skillName) {
          results.push({ tool: 'create_skill', args: call.args, success: false, error: 'Skill name is required. Use: @create_skill(name, """{"description": "...", "instructions": "...", "category": "...", "mcpServerIds": [...]}""")' });
          continue;
        }
        try {
          let parsed: any = {};
          if (typeof dataArg === 'string') {
            try { parsed = JSON.parse(dataArg); } catch {
              // If not valid JSON, treat the entire second arg as instructions
              parsed = { instructions: dataArg };
            }
          }
          const skillId = `agent-skill-${uuidv4()}`;
          const nowStr = new Date().toISOString();
          const skill = {
            id: skillId,
            name: skillName,
            description: parsed.description || '',
            category: parsed.category || 'general',
            instructions: parsed.instructions || '',
            mcpServerIds: Array.isArray(parsed.mcpServerIds) ? parsed.mcpServerIds : [],
            createdBy: agent.name,
            createdByAgentId: agentId,
            useCount: 0,
            lastUsedAt: null,
            createdAt: nowStr,
            updatedAt: nowStr,
          };
          await saveAgentSkill(skill);
          console.log(`✨ [Skill Create] Agent "${agent.name}" created skill "${skillName}" (${skillId})`);
          results.push({ tool: 'create_skill', args: call.args, success: true, result: `Skill created successfully:\n- ID: ${skillId}\n- Name: ${skillName}\n- Category: ${skill.category}\n- Description: ${skill.description || '(none)'}\n- MCPs: ${skill.mcpServerIds.length > 0 ? skill.mcpServerIds.join(', ') : 'none'}` });
        } catch (err: any) {
          results.push({ tool: 'create_skill', args: call.args, success: false, error: err.message });
        }
        continue;
      }

      // ── @update_skill(id, JSON) ──
      if (call.tool === 'update_skill') {
        const skillId = (call.args[0] || '').trim();
        const dataArg = call.args[1] || '{}';
        if (!skillId) {
          results.push({ tool: 'update_skill', args: call.args, success: false, error: 'Skill ID is required. Use: @update_skill(skill-id, """{"instructions": "updated instructions", ...}""")' });
          continue;
        }
        try {
          const existing = await getAgentSkillById(skillId);
          if (!existing) {
            results.push({ tool: 'update_skill', args: call.args, success: false, error: `Skill not found: ${skillId}` });
            continue;
          }
          let parsed: any = {};
          if (typeof dataArg === 'string') {
            try { parsed = JSON.parse(dataArg); } catch {
              // If not valid JSON, treat the entire second arg as updated instructions
              parsed = { instructions: dataArg };
            }
          }
          const allowedFields = ['name', 'description', 'category', 'instructions', 'mcpServerIds'];
          for (const key of allowedFields) {
            if (parsed[key] !== undefined) {
              (existing as any)[key] = parsed[key];
            }
          }
          (existing as any).updatedAt = new Date().toISOString();
          (existing as any).lastUpdatedBy = agent.name;
          await saveAgentSkill(existing);
          console.log(`📝 [Skill Update] Agent "${agent.name}" updated skill "${(existing as any).name}" (${skillId})`);
          results.push({ tool: 'update_skill', args: call.args, success: true, result: `Skill "${(existing as any).name}" (${skillId}) updated successfully.\nUpdated fields: ${Object.keys(parsed).filter(k => allowedFields.includes(k)).join(', ') || 'none'}` });
        } catch (err: any) {
          results.push({ tool: 'update_skill', args: call.args, success: false, error: err.message });
        }
        continue;
      }

      // ── @delete_skill(id) ──
      if (call.tool === 'delete_skill') {
        const skillId = (call.args[0] || '').trim();
        if (!skillId) {
          results.push({ tool: 'delete_skill', args: call.args, success: false, error: 'Skill ID is required. Use: @delete_skill(skill-id)' });
          continue;
        }
        try {
          const existing = await getAgentSkillById(skillId);
          if (!existing) {
            results.push({ tool: 'delete_skill', args: call.args, success: false, error: `Skill not found: ${skillId}` });
            continue;
          }
          await deleteAgentSkillFromDb(skillId);
          console.log(`🗑️ [Skill Delete] Agent "${agent.name}" deleted skill "${(existing as any).name}" (${skillId})`);
          results.push({ tool: 'delete_skill', args: call.args, success: true, result: `Skill "${(existing as any).name}" (${skillId}) deleted successfully.` });
        } catch (err: any) {
          results.push({ tool: 'delete_skill', args: call.args, success: false, error: err.message });
        }
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

        // ── Tool Hooks: check MCP calls ──
        const mcpHookResult = checkToolHooks(agent.toolHooks, 'mcp_call', call.args);
        if (!mcpHookResult.allowed) {
          console.log(`🛡️ [ToolHook] Blocked mcp_call for agent "${agent.name}": ${mcpHookResult.message}`);
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: mcpHookResult.message });
          if (streamCallback) streamCallback(`\n✗ mcp_call — blocked by security rule\n`);
          continue;
        }

        // ── Plugin gate: server must be enabled via agent plugins, board plugins,
        //    or direct agent.mcpServers. The LLM may "remember" a tool from a
        //    previous run when more plugins were enabled — refuse to dispatch it.
        const _allowedMcpIds = new Set<string>();
        const _agentSkillIds: string[] = Array.isArray(agent.skills) ? agent.skills : [];
        let _boardPluginIds: string[] = [];
        if (agent.boardId) {
          try {
            const _board = await getBoardById(agent.boardId);
            if (_board && Array.isArray(_board.plugins)) _boardPluginIds = _board.plugins;
          } catch { /* board may not exist */ }
        }
        for (const sid of new Set([..._agentSkillIds, ..._boardPluginIds])) {
          const plugin = this.skillManager ? this.skillManager.getById(sid) : null;
          if (plugin && Array.isArray((plugin as any).mcpServerIds)) {
            for (const mid of (plugin as any).mcpServerIds) _allowedMcpIds.add(mid);
          }
        }
        for (const mid of (agent.mcpServers || [])) _allowedMcpIds.add(mid);

        // Resolve the requested server name to a known id without triggering
        // builtin auto-registration (we don't want to "wake up" a server the
        // agent isn't allowed to use just to deny it).
        const _requestedNameLc = String(serverName).toLowerCase();
        let _resolvedServerId: string | null = null;
        for (const s of this.mcpManager.servers.values()) {
          if (s.name && s.name.toLowerCase() === _requestedNameLc) { _resolvedServerId = s.id; break; }
          if (s.id && s.id.toLowerCase() === _requestedNameLc) { _resolvedServerId = s.id; break; }
        }
        if (!_resolvedServerId) {
          const _builtin = findBuiltinMcpServer(serverName);
          if (_builtin) _resolvedServerId = _builtin.id;
        }

        if (!_resolvedServerId || !_allowedMcpIds.has(_resolvedServerId)) {
          const errMsg = `MCP server "${serverName}" is not enabled for this agent. ` +
            `The agent must have a plugin that provides this server in its own plugin list, ` +
            `or in the current board's plugin list. ` +
            `Do not call @mcp_call(${serverName}, ...) — this tool is not available in this run.`;
          console.log(`🛡️ [MCP Gate] Blocked @mcp_call(${serverName}, ${toolName}) for agent "${agent.name}": server not in enabled plugin set`);
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: errMsg });
          if (streamCallback) streamCallback(`\n✗ MCP: ${serverName} → ${toolName} — blocked: server not enabled for this agent\n`);
          this._emit('agent:tool:error', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', error: errMsg });
          continue;
        }

        const mcpLabel = `MCP: ${serverName} → ${toolName}`;
        agent.currentThinking = mcpLabel;
        this._emit('agent:thinking', { agentId, thinking: mcpLabel });
        this._emit('agent:tool:start', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args });

        try {
          let parsedArgs: any;
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
              } catch (e2: any) {
                throw new Error(`Invalid JSON arguments for ${toolName}: ${e2.message}. Received: ${argsJson.slice(0, 200)}`);
              }
            }

            const vals = Object.values(parsedArgs);
            const looksLikeSchema = vals.length > 0 && vals.every((v: any) =>
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
          const mcpResult = await this.mcpManager.callToolByNameForAgent(serverName, toolName, parsedArgs, agentId, agent.mcpAuth || {}, agent.boardId || null);

          if (streamCallback) {
            const icon = mcpResult.success ? '✓' : '✗';
            streamCallback(`\n${icon} ${mcpLabel}\n`);
          }

          results.push({ tool: 'mcp_call', args: call.args, ...mcpResult });
          this._emit('agent:tool:result', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args, success: mcpResult.success, preview: (mcpResult.result || '').slice(0, 300) });
        } catch (mcpErr: any) {
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

        const llmConfig = this.resolveLlmConfig(agent);
        const toolOptions: any = {};
        const result: any = await executeTool(call.tool, call.args, agent.project, this.executionManager, agentId, toolOptions);

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
