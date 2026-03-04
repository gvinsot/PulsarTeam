import { v4 as uuidv4 } from 'uuid';
import { createProvider } from './llmProviders.js';
import { getAllAgents, saveAgent, deleteAgentFromDb } from './database.js';
import { TOOL_DEFINITIONS, parseToolCalls, executeTool } from './agentTools.js';
import { listStarredRepos, getProjectGitUrl } from './githubProjects.js';
import fs from 'fs/promises';
import path from 'path';

// ─── File System Handoff ────────────────────────────────────────────────────────
async function transferUserFiles(fromId, toId) {
  const tempDir = path.join('/tmp', `handoff-${uuidv4()}`);
  const fromHomeDir = `/home/${fromId}`;
  const toHomeDir = `/home/${toId}`;

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.cp(fromHomeDir, tempDir, { recursive: true });
    await fs.chmod(tempDir, 0o755);
    await fs.rename(tempDir, toHomeDir);
    return { success: true, message: 'File system handoff completed successfully' };
  } catch (error) {
    console.error('File system handoff failed:', error);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    return { success: false, message: error.message };
  }
}

export class AgentManager {
  constructor(io, skillManager, sandboxManager, mcpManager = null) {
    this.agents = new Map();
    this.abortControllers = new Map(); // Track ongoing requests by agentId
    this._taskQueues = new Map();       // Per-agent sequential task queue
    this.io = io;
    this.skillManager = skillManager;
    this.sandboxManager = sandboxManager;
    this.mcpManager = mcpManager;
  }

  async loadFromDatabase() {
    try {
      const agents = await getAllAgents();
      for (const agent of agents) {
        // Reset runtime state
        agent.status = 'idle';
        agent.currentTask = null;
        agent.currentThinking = '';
        agent.actionLogs = agent.actionLogs || [];
        agent.skills = agent.skills || [];
        agent.mcpServers = agent.mcpServers || [];
        agent.isVoice = agent.isVoice || false;
        agent.voice = agent.voice || 'alloy';
        agent.projectContexts = agent.projectContexts || {};
        // Migration: initialize projectChangedAt for existing agents
        if (agent.projectChangedAt === undefined) {
          agent.projectChangedAt = agent.project ? (agent.updatedAt || agent.createdAt || null) : null;
        }
        // Migration: done boolean → status string
        if (agent.todoList) {
          for (const todo of agent.todoList) {
            if (todo.status === undefined) {
              todo.status = todo.done ? 'done' : 'pending';
              delete todo.done;
            }
            // Reset in_progress tasks to pending on server restart
            if (todo.status === 'in_progress') {
              todo.status = 'pending';
            }
          }
        }
        this.agents.set(agent.id, agent);
      }
      console.log(`📂 Loaded ${agents.length} agents from database`);
    } catch (err) {
      console.error('Failed to load agents from database:', err.message);
    }
  }

  create(config) {
    const id = uuidv4();
    const agent = {
      id,
      name: config.name || 'Unnamed Agent',
      role: config.role || 'general',
      description: config.description || '',
      provider: config.provider,
      model: config.model,
      endpoint: config.endpoint || '',
      apiKey: config.apiKey || '',
      instructions: config.instructions || 'You are a helpful AI assistant.',
      status: 'idle',
      currentTask: null,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 128000,
      contextLength: config.contextLength ?? 0,
      todoList: config.todoList || [],
      ragDocuments: config.ragDocuments || [],
      skills: config.skills || [],
      mcpServers: config.mcpServers || [],
      conversationHistory: [],
      actionLogs: [],
      currentThinking: '',
      metrics: {
        totalMessages: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        lastActiveAt: null,
        errors: 0
      },
      handoffTargets: config.handoffTargets || [],
      project: config.project || null,
      projectChangedAt: config.project ? new Date().toISOString() : null,
      projectContexts: {},
      enabled: config.enabled !== undefined ? config.enabled : true,
      isLeader: config.isLeader || config.isVoice || false,
      isVoice: config.isVoice || false,
      voice: config.voice || 'alloy',
      template: config.template || null,
      color: config.color || this._randomColor(),
      icon: config.icon || '🤖',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.agents.set(id, agent);
    saveAgent(agent); // Persist to database
    this._emit('agent:created', this._sanitize(agent));
    return this._sanitize(agent);
  }

  getAll() {
    return Array.from(this.agents.values()).map(a => this._sanitize(a));
  }

  getById(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return this._sanitize(agent);
  }

  getLastMessages(agentId, limit = 1) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 1;
    const history = Array.isArray(agent.conversationHistory) ? agent.conversationHistory : [];
    const startIndex = Math.max(0, history.length - safeLimit);

    const messages = history.slice(-safeLimit).map((m, idx) => ({
      index: startIndex + idx,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || null,
      type: m.type || null
    }));

    return {
      agentId: agent.id,
      agentName: agent.name,
      project: agent.project || null,
      status: agent.status,
      totalMessages: history.length,
      returned: messages.length,
      limit: safeLimit,
      messages
    };
  }

  getLastMessagesByName(agentName, limit = 1) {
    if (!agentName) return null;
    const target = Array.from(this.agents.values()).find(
      a => (a.name || '').toLowerCase() === String(agentName).toLowerCase()
    );
    if (!target) return null;
    return this.getLastMessages(target.id, limit);
  }

  /**
   * Get comprehensive status of a single agent including project info.
   * Used by REST API and leader tools for detailed agent inspection.
   */
  getAgentStatus(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const todoList = agent.todoList || [];
    const pendingTodos = todoList.filter(t => t.status === 'pending').length;
    const inProgressTodos = todoList.filter(t => t.status === 'in_progress').length;
    const doneTodos = todoList.filter(t => t.status === 'done').length;
    const errorTodos = todoList.filter(t => t.status === 'error').length;
    const totalTodos = todoList.length;
    const msgCount = (agent.conversationHistory || []).length;
    const hasSandbox = this.sandboxManager ? this.sandboxManager.hasSandbox(agent.id) : false;

    // Extract current in-progress task description from todoList
    const currentTaskTodo = todoList.find(t => t.status === 'in_progress');
    const currentTask = agent.currentTask || (currentTaskTodo ? currentTaskTodo.text : null);

    // Collect active (in-progress + pending) todo descriptions for visibility
    const activeTodos = todoList
      .filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'error')
      .map(t => ({ id: t.id, text: t.text, status: t.status, startedAt: t.startedAt || null }));

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      role: agent.role || 'worker',
      description: agent.description || '',
      project: agent.project || null,
      projectChangedAt: agent.projectChangedAt || null,
      currentTask: currentTask,
      activeTodos,
      provider: agent.provider || null,
      model: agent.model || null,
      enabled: agent.enabled !== false,
      isLeader: agent.isLeader || false,
      sandbox: hasSandbox ? 'running' : 'not running',
      todos: {
        pending: pendingTodos,
        inProgress: inProgressTodos,
        done: doneTodos,
        error: errorTodos,
        total: totalTodos
      },
      messages: msgCount,
      metrics: {
        totalMessages: agent.metrics?.totalMessages || 0,
        totalTokensIn: agent.metrics?.totalTokensIn || 0,
        totalTokensOut: agent.metrics?.totalTokensOut || 0,
        lastActiveAt: agent.metrics?.lastActiveAt || null,
        errors: agent.metrics?.errors || 0
      },
      createdAt: agent.createdAt || null,
      updatedAt: agent.updatedAt || null
    };
  }

  /**
   * Get lightweight status for ALL agents (including project info).
   * Unlike getAll() which returns full agent data (heavy), this returns
   * only the essential status fields for each agent — ideal for dashboards,
   * management tools, and leader queries that need a quick overview.
   */
  getAllStatuses() {
    return Array.from(this.agents.values())
      .filter(a => a.enabled !== false)
      .map(a => this.getAgentStatus(a.id))
      .filter(Boolean);
  }

  /**
   * Get lightweight statuses for agents assigned to a specific project.
   * Used by REST API for project-filtered queries.
   */
  getAgentsByProject(projectName) {
    if (!projectName) return [];
    return Array.from(this.agents.values())
      .filter(a => a.enabled !== false && (a.project || '').toLowerCase() === projectName.toLowerCase())
      .map(a => this.getAgentStatus(a.id))
      .filter(Boolean);
  }

  /**
   * Get a high-level summary of all projects and their agent assignments.
   * Useful for management dashboards and leader tools that need to quickly
   * see how agents are distributed across projects.
   */
  getProjectSummary() {
    const enabled = Array.from(this.agents.values()).filter(a => a.enabled !== false);
    const projectMap = {};
    const unassigned = [];

    for (const agent of enabled) {
      if (agent.project) {
        if (!projectMap[agent.project]) {
          projectMap[agent.project] = { agents: [], busy: 0, idle: 0, error: 0, total: 0 };
        }
        const entry = projectMap[agent.project];
        entry.total++;
        if (agent.status === 'busy') entry.busy++;
        else if (agent.status === 'error') entry.error++;
        else entry.idle++;
        entry.agents.push({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          role: agent.role || 'worker',
          currentTask: agent.currentTask || null
        });
      } else {
        unassigned.push({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          role: agent.role || 'worker',
          currentTask: agent.currentTask || null
        });
      }
    }

    return {
      projects: Object.entries(projectMap).map(([name, data]) => ({
        name,
        ...data
      })),
      unassigned,
      totalAgents: enabled.length,
      totalProjects: Object.keys(projectMap).length
    };
  }

  /**
   * Get comprehensive swarm status: all agents with their current project assignments.
   * Used by REST API and @swarm_status() leader command.
   */
  getSwarmStatus() {
    const allAgents = Array.from(this.agents.values());
    const enabled = allAgents.filter(a => a.enabled !== false);
    const disabled = allAgents.filter(a => a.enabled === false);

    // Group agents by project
    const projectMap = {};
    const unassigned = [];
    for (const agent of enabled) {
      const status = this.getAgentStatus(agent.id);
      if (agent.project) {
        if (!projectMap[agent.project]) projectMap[agent.project] = [];
        projectMap[agent.project].push(status);
      } else {
        unassigned.push(status);
      }
    }

    // Build per-project summary with busy/idle counts and per-agent task details
    const projectSummaries = {};
    for (const [project, agents] of Object.entries(projectMap)) {
      projectSummaries[project] = {
        total: agents.length,
        busy: agents.filter(a => a.status === 'busy').length,
        idle: agents.filter(a => a.status === 'idle').length,
        error: agents.filter(a => a.status === 'error').length,
        agents: agents.map(a => ({
          name: a.name,
          status: a.status,
          role: a.role,
          currentTask: a.currentTask || null,
          activeTodos: (a.activeTodos || []).length,
          projectChangedAt: a.projectChangedAt || null
        }))
      };
    }

    return {
      summary: {
        total: allAgents.length,
        enabled: enabled.length,
        disabled: disabled.length,
        busy: enabled.filter(a => a.status === 'busy').length,
        idle: enabled.filter(a => a.status === 'idle').length,
        error: enabled.filter(a => a.status === 'error').length,
        withProject: enabled.filter(a => a.project).length,
        withoutProject: enabled.filter(a => !a.project).length,
        activeProjects: Object.keys(projectMap)
      },
      projectSummaries,
      projectAssignments: projectMap,
      unassignedAgents: unassigned,
      agents: enabled.map(a => this.getAgentStatus(a.id))
    };
  }

  update(id, updates) {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const allowed = [
      'name', 'role', 'description', 'instructions', 'temperature',
      'maxTokens', 'contextLength', 'todoList', 'ragDocuments', 'skills', 'mcpServers', 'handoffTargets',
      'color', 'icon', 'provider', 'model', 'endpoint', 'apiKey', 'project', 'isLeader', 'isVoice', 'voice', 'enabled'
    ];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        // Don't overwrite existing apiKey with empty string
        if (key === 'apiKey' && !updates[key] && agent[key]) continue;
        // Context switching when project changes
        if (key === 'project' && updates[key] !== agent[key]) {
          this._switchProjectContext(agent, agent.project, updates[key]);
          agent.projectChangedAt = updates[key] ? new Date().toISOString() : null;
        }
        agent[key] = updates[key];
      }
    }
    agent.updatedAt = new Date().toISOString();

    saveAgent(agent); // Persist to database
    this._emit('agent:updated', this._sanitize(agent));
    return this._sanitize(agent);
  }

  delete(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;
    // Destroy sandbox container
    if (this.sandboxManager) {
      this.sandboxManager.destroySandbox(id).catch(err => {
        console.error(`Failed to destroy sandbox for agent ${id}:`, err.message);
      });
    }
    this.agents.delete(id);
    deleteAgentFromDb(id); // Remove from database
    this._emit('agent:deleted', { id });
    return true;
  }

  updateAllProjects(project) {
    const updated = [];
    for (const agent of this.agents.values()) {
      if (project !== agent.project) {
        this._switchProjectContext(agent, agent.project, project);
        agent.projectChangedAt = project ? new Date().toISOString() : null;
      }
      agent.project = project;
      agent.updatedAt = new Date().toISOString();
      saveAgent(agent);
      updated.push(this._sanitize(agent));
      this._emit('agent:updated', this._sanitize(agent));
    }
    return updated;
  }

  setStatus(id, status, detail = null) {
    const agent = this.agents.get(id);
    if (!agent) return;
    const prev = agent.status;
    agent.status = status;

    // Clear currentTask when agent goes idle or errors out
    if (status === 'idle' || status === 'error') {
      agent.currentTask = null;
    }

    this._emit('agent:status', {
      id,
      name: agent.name,
      status,
      role: agent.role || 'worker',
      project: agent.project || null,
      currentTask: agent.currentTask || null,
      isLeader: agent.isLeader || false
    });

    // Log meaningful status transitions
    if (status === 'busy' && prev !== 'busy') {
      this.addActionLog(id, 'busy', detail || 'Agent started working');
    } else if (status === 'idle' && prev !== 'idle') {
      this.addActionLog(id, 'idle', detail || 'Agent finished working');
    } else if (status === 'error') {
      this.addActionLog(id, 'error', 'Agent encountered an error', detail);
    }
  }

  // ─── Stop Agent ─────────────────────────────────────────────────────
  stopAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;

    // Abort any in-progress request
    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    // Clear the task queue so pending delegations don't start
    this._taskQueues.delete(id);

    // If this is a leader, also stop all other busy agents (delegated work)
    if (agent.isLeader) {
      for (const [subId, subAgent] of this.agents) {
        if (subId !== id && subAgent.status === 'busy') {
          const subCtrl = this.abortControllers.get(subId);
          if (subCtrl) {
            subCtrl.abort();
            this.abortControllers.delete(subId);
          }
          this._taskQueues.delete(subId);
          subAgent.currentThinking = '';
          subAgent.currentTask = null;
          this.setStatus(subId, 'idle', 'Stopped by leader');
          saveAgent(subAgent);
          this._emit('agent:stopped', { id: subId, name: subAgent.name, project: subAgent.project || null });
        }
      }
    }

    // Reset agent state
    agent.currentThinking = '';
    agent.currentTask = null;
    this.setStatus(id, 'idle', 'Agent stopped by user');
    saveAgent(agent);

    console.log(`🛑 Agent ${agent.name} stopped`);
    this._emit('agent:stopped', { id, name: agent.name, project: agent.project || null });
    return true;
  }

  // ─── Chat ───────────────────────────────────────────────────────────
  async sendMessage(id, userMessage, streamCallback, delegationDepth = 0, messageMeta = null) {
    const MAX_DELEGATION_DEPTH = 5; // Prevent infinite loops
    
    // Create abort controller for this request
    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);
    
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent not found');

    this.setStatus(id, 'busy');
    agent.currentThinking = '';

    // Track the current task for status reporting
    if (messageMeta?.type === 'delegation-task') {
      agent.currentTask = (userMessage || '').replace(/^\[TASK from [^\]]+\]:\s*/i, '').slice(0, 200) || null;
    } else if (delegationDepth === 0 && !messageMeta) {
      agent.currentTask = (userMessage || '').slice(0, 200) || null;
    }
    this._emit('agent:status', { id, status: 'busy', project: agent.project || null, currentTask: agent.currentTask || null });

    // Build messages array
    const messages = [];
    let systemContent = '';   // Hoisted so we can rebuild messages after compaction
    {
      systemContent = `Your name is "${agent.name}".${agent.role ? ` Your role: ${agent.role}.` : ''}\n\n${agent.instructions || 'You are a helpful AI assistant.'}`;
      
      // For leader agents, inject available agents context (only at top level to avoid confusion)
      if (agent.isLeader && delegationDepth === 0) {
        const availableAgents = Array.from(this.agents.values())
          .filter(a => a.id !== id && a.enabled !== false) // Exclude self and disabled agents
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

        // Inject leader management tools and available projects
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
        systemContent += `\n- @list_agents() — List all enabled agents with their current status, project assignment, role, active todos, and current task. Includes a project summary header showing agent distribution across projects.`;
        systemContent += `\n- @agent_status(AgentName) — Check a specific agent's detailed status: busy/idle/error, current project, current task, active todo descriptions, sandbox state, message count, provider/model, and error count.`;
        systemContent += `\n- @get_available_agent(role) — Find all idle agents with the specified role (e.g. "developer"). Returns each agent's name, project assignment, and pending todo count. If none are idle, shows busy agents with that role as a hint.`;
        systemContent += `\n- @swarm_status() — Get a comprehensive overview of the entire swarm: all agents grouped by their current project, with per-agent status, role, current task descriptions, and todo counts.`;
        systemContent += `\n- @agents_on_project(projectName) — List all agents currently assigned to a specific project with their status, role, current task, and todo counts. Useful for checking who is working on a particular project.`;
        if (projectNames.length > 0) {
          systemContent += `\nAvailable projects: ${projectNames.join(', ')}`;
        }
        systemContent += `\n\n⚠️ IMPORTANT: Before delegating tasks, ensure each agent has a project assigned. Agents without a project work at the workspace root and cannot access project files correctly. Use @assign_project(AgentName, "project_name") for any agent marked [no project] above before delegating code-related tasks to them. The system will auto-assign when possible, but explicit assignment is preferred.`;
      }
      
      // Append RAG context if available
      if (agent.ragDocuments.length > 0) {
        systemContent += '\n\n--- Reference Documents ---\n';
        for (const doc of agent.ragDocuments) {
          systemContent += `\n[${doc.name}]:\n${doc.content}\n`;
        }
      }
      // Append Plugins context and collect MCP server IDs from plugins
      const agentSkills = agent.skills || [];
      const pluginMcpIds = new Set();
      if (agentSkills.length > 0 && this.skillManager) {
        const resolvedPlugins = agentSkills.map(sid => this.skillManager.getById(sid)).filter(Boolean);
        if (resolvedPlugins.length > 0) {
          systemContent += '\n\n--- Active Plugins ---\n';
          for (const plugin of resolvedPlugins) {
            systemContent += `\n[${plugin.name}]:\n${plugin.instructions}\n`;
            // Collect MCP server IDs from plugin associations
            if (Array.isArray(plugin.mcpServerIds)) {
              plugin.mcpServerIds.forEach(id => pluginMcpIds.add(id));
            }
          }
        }
      }

      // Merge MCP server IDs: from plugins + direct agent assignments (backward compat)
      const directMcpIds = agent.mcpServers || [];
      const allMcpIds = [...new Set([...pluginMcpIds, ...directMcpIds])];
      if (allMcpIds.length > 0 && this.mcpManager) {
        const mcpTools = this.mcpManager.getToolsForAgent(allMcpIds);
        if (mcpTools.length > 0) {
          systemContent += '\n\n--- MCP Tools ---\n';
          systemContent += 'Call these tools using @mcp_call(server, tool, {"arg": "value"}) syntax.\n\n';
          for (const t of mcpTools) {
            const schema = t.inputSchema?.properties ? JSON.stringify(t.inputSchema.properties) : '{}';
            systemContent += `@mcp_call(${t.serverName}, ${t.name}, ${schema}) — ${t.description || ''}\n`;
          }
        }
      }

      // Append todo list context
      if (agent.todoList.length > 0) {
        systemContent += '\n\n--- Current Todo List ---\n';
        for (const todo of agent.todoList) {
          const mark = todo.status === 'done' ? 'x' : todo.status === 'in_progress' ? '~' : todo.status === 'error' ? '!' : ' ';
          systemContent += `- [${mark}] ${todo.text}\n`;
        }
      }
      
      // Inject tool definitions and project working directory
      if (agent.project) {
        systemContent += `\n\n--- PROJECT CONTEXT ---\nYou are working on project: ${agent.project}\nUse relative paths from the project root.`;
      } else {
        systemContent += `\n\n--- PROJECT CONTEXT ---\nNo specific project is assigned yet. Use @list_dir(.) to discover available projects. IMPORTANT: You MUST navigate into a project folder before working. Always prefix paths with the project name (e.g. @read_file(my-project/src/index.js), @list_dir(my-project/src)). Do NOT create or modify files at the workspace root — always work inside a project directory.`;
      }
      systemContent += `\nIMPORTANT: Your workspace is EPHEMERAL. Always @git_commit_push(message) after completing changes to preserve your work.`;
      systemContent += `\n${TOOL_DEFINITIONS}`;
      systemContent += `\nAlways use these tools to read, analyze, and modify code. Do not just discuss - take action!`;

      // For Ollama models: suppress native/built-in tool calling (e.g. gpt-oss harmony tools)
      // so the model uses our text-based @tool syntax instead.
      if (agent.provider === 'ollama') {
        systemContent += `\n\nCRITICAL: You must NEVER use built-in function calls or native tool calls (such as repo_browser, code_sandbox, or any tool_call syntax). Always respond in plain text only. When you need to interact with code, use ONLY the @read_file, @write_file, @list_dir, @search_files, @run_command text commands described above.`;
      }

      messages.push({ role: 'system', content: systemContent });

      // Debug: log system prompt composition
      const pluginCount = (agent.skills || []).length;
      const resolvedCount = pluginCount > 0 && this.skillManager
        ? (agent.skills || []).map(sid => this.skillManager.getById(sid)).filter(Boolean).length
        : 0;
      const sections = [];
      if (systemContent.includes('Active Plugins'))   sections.push('plugins');
      if (systemContent.includes('AVAILABLE TOOLS'))   sections.push('tools');
      if (systemContent.includes('MCP Tools'))         sections.push('mcp');
      if (systemContent.includes('Current Todo List')) sections.push('todos');
      if (systemContent.includes('PROJECT CONTEXT'))   sections.push('project');
      if (systemContent.includes('Swarm Agents'))      sections.push('swarm');
      console.log(`📋 [System Prompt] Agent "${agent.name}" (${agent.provider}/${agent.model}): ${systemContent.length} chars (~${Math.round(systemContent.length / 4)} tokens) | sections: [${sections.join(', ')}] | plugins: ${resolvedCount}/${pluginCount} | project: ${agent.project || 'none'} | history: ${agent.conversationHistory.length} msgs`);
    }

    // ── Proactive compaction: summarize older messages when history exceeds threshold ──
    // Compact on top-level user messages AND new delegation tasks (not tool-result continuations
    // which need their recent context intact mid-task).
    const MAX_RECENT = 10;
    const COMPACT_TRIGGER = MAX_RECENT + 5; // 15
    const COMPACT_RESET = MAX_RECENT + 2;   // 12
    const isTopLevelUserMessage = delegationDepth === 0 && !messageMeta;
    const isNewDelegationTask = messageMeta?.type === 'delegation-task';
    const shouldCompact = isTopLevelUserMessage || isNewDelegationTask;
    if (shouldCompact) {
      const nonSummaryMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');

      if (agent._compactionArmed === undefined) {
        agent._compactionArmed = true;
      }
      if (!agent._compactionArmed && nonSummaryMessages.length <= COMPACT_RESET) {
        agent._compactionArmed = true;
      }

      if (agent._compactionArmed && nonSummaryMessages.length > COMPACT_TRIGGER) {
        console.log(`🗜️  [Proactive Compact] "${agent.name}": ${nonSummaryMessages.length} messages — compacting to keep ${MAX_RECENT} recent`);
        if (streamCallback) streamCallback(`\n⏳ *Compacting conversation history (${nonSummaryMessages.length} messages)...*\n`);
        await this._compactHistory(agent, MAX_RECENT);
        agent._compactionArmed = false;
      }
    }

    // Add conversation history: always include compaction summary + last N real messages
    const summary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
    const realMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
    if (summary) messages.push(summary);
    messages.push(...realMessages.slice(-MAX_RECENT));

    // Add user message
    messages.push({ role: 'user', content: userMessage });

    // ── Safety net: also compact if token budget is exceeded ──
    // Skip during tool-result continuations to avoid breaking mid-task context
    if (shouldCompact) {
      const contextLimit = agent.contextLength || 8192;
      const estimatedTokens = this._estimateTokens(messages);
      if (estimatedTokens > contextLimit * 0.75 && realMessages.length > MAX_RECENT) {
        console.log(`🗜️  [Token Compact] "${agent.name}": estimated ${estimatedTokens} tokens vs ${contextLimit} limit — compacting`);
        if (streamCallback) streamCallback(`\n⏳ *Compacting conversation history (token limit)...*\n`);
        await this._compactHistory(agent, 6);
        agent._compactionArmed = false;
        // Rebuild messages with compacted history
        messages.length = 0;
        if (systemContent) {
          messages.push({ role: 'system', content: systemContent });
        }
        const newSummary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
        const newReal = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
        if (newSummary) messages.push(newSummary);
        messages.push(...newReal.slice(-MAX_RECENT));
        messages.push({ role: 'user', content: userMessage });
      }
    }

    // Store user message (with optional metadata for tool/delegation results)
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

    try {
      const provider = createProvider({
        provider: agent.provider,
        model: agent.model,
        endpoint: agent.endpoint,
        apiKey: agent.apiKey
      });

      let fullResponse = '';
      let finishReason = null;

      // ── Incremental delegation: detect → enqueue immediately ───────────
      // As the leader streams, we detect complete @delegate() commands and:
      //  1. Notify the UI immediately (create todo + emit event)
      //  2. Enqueue execution on the target agent's task queue
      // The per-agent queue guarantees tasks run one-at-a-time per Developer,
      // but multiple tasks can be ADDED to the queue in parallel.
      // Each enqueue returns a Promise that resolves when execution finishes.
      let detectedCount = 0;
      const delegationPromises = [];   // Promise[] — one per enqueued task
      const isLeaderStreaming = agent.isLeader && delegationDepth < MAX_DELEGATION_DEPTH;

      // Stream response (check for abort on each chunk)
      for await (const chunk of provider.chatStream(messages, {
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        contextLength: agent.contextLength || 0,
        signal: abortController.signal
      })) {
        // Check if aborted
        if (abortController.signal.aborted) {
          throw new Error('Agent stopped by user');
        }
        
        if (chunk.type === 'thinking') {
          // Reasoning model thinking tokens — show in UI but don't add to response
          agent.currentThinking = chunk.text;
          this._emit('agent:thinking', { agentId: id, agentName: agent.name, project: agent.project || null, thinking: chunk.text });
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

              // ── Auto-propagate project to target agent if it has none ──
              if (!targetAgent.project) {
                // Try leader's project first, then fall back to only available project
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

              // Notify UI immediately
              this._emit('agent:delegation', {
                from: { id, name: agent.name, project: agent.project || null },
                to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
                task: delegation.task
              });

              // Create todo immediately
              const todo = this.addTodo(targetAgent.id, `[From ${agent.name}] ${delegation.task}`);

              // Enqueue execution — the queue will process it when the agent is free
              const promise = this._enqueueAgentTask(targetAgent.id, async () => {
                // Mark todo as in_progress
                if (todo) {
                  const t = targetAgent.todoList.find(t => t.id === todo.id);
                  if (t) {
                    t.status = 'in_progress';
                    t.startedAt = new Date().toISOString();
                    saveAgent(targetAgent);
                    this._emit('agent:updated', this._sanitize(targetAgent));
                  }
                }

                // Notify leader's stream with a status marker (not raw sub-agent output)
                if (streamCallback) streamCallback(`\n\n--- \uD83D\uDCE8 Delegating to ${targetAgent.name} ---\n`);

                // Stream to the sub-agent's own chat via socket
                this._emit('agent:stream:start', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });

                const agentResponse = await this.sendMessage(
                  targetAgent.id,
                  `[TASK from ${agent.name}]: ${delegation.task}`,
                  (chunk) => {
                    // Stream to the sub-agent's own chat
                    this._emit('agent:stream:chunk', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, chunk });
                  },
                  delegationDepth + 1,
                  { type: 'delegation-task', fromAgent: agent.name }
                );

                // End sub-agent stream and notify leader
                this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });
                if (streamCallback) streamCallback(`\n--- \u2705 ${targetAgent.name} finished ---\n`);
                this._emit('agent:updated', this._sanitize(targetAgent));

                // Mark todo as done
                if (todo) {
                  const t = targetAgent.todoList.find(t => t.id === todo.id);
                  if (t) {
                    t.status = 'done';
                    t.completedAt = new Date().toISOString();
                    saveAgent(targetAgent);
                    this._emit('agent:updated', this._sanitize(targetAgent));
                  }
                }

                return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
              }).catch(err => {
                // End sub-agent stream on error too
                if (targetAgent?.id) this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent?.name || null, project: targetAgent?.project || null });
                // Mark todo as error
                if (todo && targetAgent) {
                  const t = targetAgent.todoList.find(t => t.id === todo.id);
                  if (t) {
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
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
        }
      }

      // ── Auto-continuation: if the model hit maxTokens, ask it to continue ──
      const MAX_CONTINUATIONS = 3;
      let continuationCount = 0;
      while (finishReason === 'length' && continuationCount < MAX_CONTINUATIONS) {
        continuationCount++;
        console.log(`🔄 [Continuation ${continuationCount}/${MAX_CONTINUATIONS}] "${agent.name}": response was truncated (finish_reason=length), requesting continuation...`);
        if (streamCallback) streamCallback(`\n⏳ *Response truncated, continuing...*\n`);

        // Add the partial response to history and ask the model to continue
        messages.push({ role: 'assistant', content: fullResponse });
        messages.push({ role: 'user', content: 'Your previous response was cut off because it exceeded the maximum output length. Continue EXACTLY from where you stopped. Do not repeat anything you already wrote — just output the remaining content.' });

        finishReason = null;
        for await (const chunk of provider.chatStream(messages, {
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          contextLength: agent.contextLength || 0,
          signal: abortController.signal
        })) {
          if (abortController.signal.aborted) {
            throw new Error('Agent stopped by user');
          }
          if (chunk.type === 'thinking') {
            agent.currentThinking = chunk.text;
            this._emit('agent:thinking', { agentId: id, agentName: agent.name, project: agent.project || null, thinking: chunk.text });
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
            }
            if (chunk.finishReason) {
              finishReason = chunk.finishReason;
            }
          }
        }
        // Remove the temporary continuation messages from the messages array
        // so they don't pollute the stored history
        messages.pop(); // remove continuation prompt
        messages.pop(); // remove partial assistant response
      }

      if (continuationCount > 0 && finishReason === 'length') {
        console.log(`⚠️  [Continuation] "${agent.name}": still truncated after ${MAX_CONTINUATIONS} continuations`);
      }

      // Store assistant message
      agent.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
        timestamp: new Date().toISOString()
      });

      agent.metrics.totalMessages += 1;
      agent.metrics.lastActiveAt = new Date().toISOString();
      agent.currentThinking = '';
      saveAgent(agent); // Persist conversation and metrics

      // Strip <think>...</think> blocks from response before parsing tool calls / delegations
      // These are reasoning tokens some models (Qwen3, etc.) emit inline in content
      // Also handles unclosed <think> blocks (model ran out of tokens mid-reasoning)
      const responseForParsing = fullResponse.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

      // Shared nudge detection (used for both tool-using agents and leaders)
      const isNudge = messageMeta?.type === 'nudge';
      const intentPatterns = /\b(i('ll| will| am going to|'m going to)|(let me|let's|going to|i'll|je vais|nous allons|on va|je m'en occupe|commençons|voyons|d'abord|ensuite|puis))\b|je [^ ]+(rai|erai)\b/i;

      // Process tool calls — all agents can use tools (no project = access to all projects)
      {
        const toolResults = await this._processToolCalls(id, responseForParsing, streamCallback, delegationDepth);
        if (toolResults.length > 0) {
          // Feed tool results back to agent and continue
          const resultsSummary = toolResults.map(r => {
            if (r.isErrorReport) {
              return `--- ⚠️ ERROR REPORT ---\n${r.args[0] || r.result}`;
            }
            if (!r.success) {
              // Include both the error message AND the actual command output (stderr/stdout)
              const parts = [`ERROR: ${r.error}`];
              if (r.result) parts.push(`OUTPUT:\n${r.result}`);
              return `--- ${r.tool}(${r.args.join(', ')}) ---\n${parts.join('\n')}`;
            }
            return `--- ${r.tool}(${r.args.join(', ')}) ---\n${r.result}`;
          }).join('\n\n');

          // Check if there are error reports — add specific instructions for the agent
          const hasErrorReports = toolResults.some(r => r.isErrorReport);
          const hasRealErrors = toolResults.some(r => !r.success && !r.isErrorReport);
          let continuationPrompt = 'Continue with your task based on these results. Use more tools if needed, or provide your final response.';
          if (hasErrorReports) {
            continuationPrompt = 'You reported an error. The error has been escalated to the manager. Summarize what you attempted and what went wrong so the manager can help.';
          } else if (hasRealErrors) {
            continuationPrompt = 'Some tools encountered errors. Try to resolve the issues, use alternative approaches, or use @report_error(description) to escalate the problem to the manager if you cannot resolve it.';
          }

          const continuedResponse = await this.sendMessage(
            id,
            `[TOOL RESULTS]\n${resultsSummary}\n\n${continuationPrompt}`,
            streamCallback,
            delegationDepth,  // Same depth — tool continuation is the same agent working
            { type: 'tool-result', toolResults: toolResults.map(r => ({ tool: r.tool, args: r.args, success: r.success, result: r.result || undefined, error: r.success ? undefined : r.error, isErrorReport: r.isErrorReport || false })) }
          );
          this.setStatus(id, 'idle');
          return continuedResponse;
        }

        // Nudge mechanism: if agent has tools (project or MCP), produced text but NO tool calls,
        // and this isn't already a nudge — the agent may have described intent without acting.
        // Only nudge agents that have tools available (project-based or MCP).
        const hasTools = agent.project || agent.mcpServers?.length > 0 || agent.skills?.length > 0;
        if (hasTools && !isNudge && responseForParsing.length > 20 && !isLeaderStreaming) {
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
            this.setStatus(id, 'idle');
            return nudgeResponse;
          }
        }
      }

      // For leader agents, process delegation commands (with depth limit)
      if (isLeaderStreaming) {
        // Final pass: catch any delegations completed in the last chunk
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
          const todo = this.addTodo(targetAgent.id, `[From ${agent.name}] ${delegation.task}`);

          const promise = this._enqueueAgentTask(targetAgent.id, async () => {
            // Mark todo as in_progress
            if (todo) {
              const t = targetAgent.todoList.find(t => t.id === todo.id);
              if (t) {
                t.status = 'in_progress';
                t.startedAt = new Date().toISOString();
                saveAgent(targetAgent);
                this._emit('agent:updated', this._sanitize(targetAgent));
              }
            }

            // Notify leader's stream with a status marker (not raw sub-agent output)
            if (streamCallback) streamCallback(`\n\n--- \uD83D\uDCE8 Delegating to ${targetAgent.name} ---\n`);

            // Stream to the sub-agent's own chat via socket
            this._emit('agent:stream:start', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });

            const agentResponse = await this.sendMessage(
              targetAgent.id,
              `[TASK from ${agent.name}]: ${delegation.task}`,
              (chunk) => {
                // Stream to the sub-agent's own chat
                this._emit('agent:stream:chunk', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, chunk });
              },
              delegationDepth + 1,
              { type: 'delegation-task', fromAgent: agent.name }
            );

            // End sub-agent stream and notify leader
            this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });
            if (streamCallback) streamCallback(`\n--- \u2705 ${targetAgent.name} finished ---\n`);
            this._emit('agent:updated', this._sanitize(targetAgent));

            if (todo) {
              const t = targetAgent.todoList.find(t => t.id === todo.id);
              if (t) {
                t.status = 'done';
                t.completedAt = new Date().toISOString();
                saveAgent(targetAgent);
                this._emit('agent:updated', this._sanitize(targetAgent));
              }
            }
            return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
          }).catch(err => {
            // End sub-agent stream on error too
            if (targetAgent?.id) this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent?.name || null, project: targetAgent?.project || null });
            // Mark todo as error
            if (todo && targetAgent) {
              const t = targetAgent.todoList.find(t => t.id === todo.id);
              if (t) {
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
          // Wait for all enqueued delegations to finish (they run sequentially per agent)
          const delegationResults = await Promise.all(delegationPromises);

          // Notify the stream that delegation results are being processed
          if (streamCallback) {
            streamCallback(`\n\n--- Delegation complete, synthesizing results ---\n\n`);
          }
          
          // Feed delegation results back to leader and get synthesis (includes project info)
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

          // Continue conversation with delegation results (increment depth)
          const synthesisResponse = await this.sendMessage(
            id, 
            `[DELEGATION RESULTS]\n${resultsSummary}\n\n${synthesisHint}`,
            streamCallback,
            delegationDepth + 1,
            { type: 'delegation-result', delegationResults: delegationResults.map(r => ({ agentName: r.agentName, project: r.project || null, task: r.task, response: r.response, error: r.error })) }
          );
          this.setStatus(id, 'idle');
          return synthesisResponse;
        }
        // Leader nudge: leader described intent but didn't use @delegate()
        if (!isNudge && delegationPromises.length === 0 && responseForParsing.length > 20) {
          if (intentPatterns.test(responseForParsing)) {
            console.log(`🔄 [Nudge] Leader "${agent.name}" described intent but used no @delegate — nudging`);
            const nudgeResponse = await this.sendMessage(
              id,
              '[SYSTEM] You described what you plan to do but did not actually delegate or take action. Stop planning and ACT NOW. Use @delegate(AgentName, task) to assign work to agents. Do NOT explain what you will do — just do it.',
              streamCallback,
              delegationDepth,
              { type: 'nudge' }
            );
            this.setStatus(id, 'idle');
            return nudgeResponse;
          }
        }
      } else if (agent.isLeader && delegationDepth >= MAX_DELEGATION_DEPTH) {
        console.log(`⚠️ Max delegation depth (${MAX_DELEGATION_DEPTH}) reached for leader ${agent.name}`);
      }

      // ── Process @assign_project commands (for leader agents) ──────────
      if (agent.isLeader) {
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

        // ── Process @get_project commands ──────────────────────────────────
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

        // ── Process @clear_context commands ────────────────────────────────
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

        // ── Process @rollback commands ─────────────────────────────────────
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

        // ── Process @list_projects commands ──────────────────────────────
        if (/@list_projects\s*\(\s*\)/i.test(responseForParsing)) {
          const projectNames = await this._listAvailableProjects();
          if (projectNames.length > 0) {
            console.log(`📂 [List Projects] ${projectNames.length} projects found`);
            if (streamCallback) streamCallback(`\n📂 Available projects: ${projectNames.join(', ')}\n`);
          } else {
            if (streamCallback) streamCallback(`\n📂 No projects found\n`);
          }
        }

        // ── Process @stop_agent commands ─────────────────────────────────
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

        // ── Process @clear_all_chats commands ───────────────────────────
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

        // ── Process @clear_all_action_logs commands ─────────────────────
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

        // ── Process @agent_status commands ───────────────────────────────
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
          const pendingTodos = todoList.filter(t => t.status === 'pending' || t.status === 'error').length;
          const inProgressTodos = todoList.filter(t => t.status === 'in_progress').length;
          const doneTodos = todoList.filter(t => t.status === 'done').length;
          const totalTodos = todoList.length;
          const msgCount = (targetAgent.conversationHistory || []).length;
          const hasSandbox = this.sandboxManager ? this.sandboxManager.hasSandbox(targetAgent.id) : false;
          const inProgressTodo = todoList.find(t => t.status === 'in_progress');
          const currentTaskInfo = targetAgent.currentTask
            ? targetAgent.currentTask.slice(0, 120) + (targetAgent.currentTask.length > 120 ? '...' : '')
            : inProgressTodo
              ? inProgressTodo.text.slice(0, 120) + (inProgressTodo.text.length > 120 ? '...' : '')
              : 'none';
          const projectAssignedAt = targetAgent.projectChangedAt
            ? new Date(targetAgent.projectChangedAt).toLocaleString()
            : 'n/a';
          const lines = [
            `Name: ${targetAgent.name}`,
            `Status: ${targetAgent.status}`,
            `Role: ${targetAgent.role || 'worker'}`,
            `Project: ${targetAgent.project || 'none'}${targetAgent.project ? ` (assigned ${projectAssignedAt})` : ''}`,
            `Current task: ${currentTaskInfo}`,
            `Provider: ${targetAgent.provider || 'unknown'}/${targetAgent.model || 'unknown'}`,
            `Sandbox: ${hasSandbox ? 'running' : 'not running'}`,
            `Todos: ${inProgressTodos} in-progress, ${pendingTodos} pending, ${doneTodos} done / ${totalTodos} total`,
            `Messages: ${msgCount}`,
            `Last active: ${targetAgent.metrics?.lastActiveAt || 'never'}`,
            `Errors: ${targetAgent.metrics?.errors || 0}`,
          ];
          // Show active todo details if any
          const activeTodos = todoList.filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'error');
          if (activeTodos.length > 0) {
            lines.push(`Active todos:`);
            for (const t of activeTodos.slice(0, 10)) {
              const mark = t.status === 'in_progress' ? '~' : t.status === 'error' ? '!' : ' ';
              lines.push(`  [${mark}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '...' : ''}`);
            }
            if (activeTodos.length > 10) lines.push(`  ... and ${activeTodos.length - 10} more`);
          }
          console.log(`📊 [Agent Status] ${targetAgent.name}: ${targetAgent.status} | project=${targetAgent.project || 'none'} | task=${currentTaskInfo}`);
          if (streamCallback) streamCallback(`\n📊 Agent status:\n${lines.join('\n')}\n`);
        }

        // ── Process @list_agents commands ────────────────────────────────
        if (/@list_agents\s*\(\s*\)/i.test(responseForParsing)) {
          const enabled = Array.from(this.agents.values()).filter(a => a.enabled !== false);

          // Build project summary header
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
          // Project summary
          const projectKeys = Object.keys(projectGroups);
          if (projectKeys.length > 0 || unassignedCount > 0) {
            output += `Projects: ${projectKeys.map(p => `${p} (${projectGroups[p].busy} busy, ${projectGroups[p].idle} idle)`).join(' | ')}`;
            if (unassignedCount > 0) output += ` | unassigned: ${unassignedCount}`;
            output += '\n';
          }

          // Per-agent details
          const lines = enabled.map(a => {
            const projectTag = a.project ? `project=${a.project}` : 'NO PROJECT';
            const todoCount = (a.todoList || []).filter(t => t.status !== 'done').length;
            const inProgressTodo = (a.todoList || []).find(t => t.status === 'in_progress');
            const todoInfo = todoCount > 0 ? ` todos=${todoCount}` : '';
            const taskInfo = a.currentTask
              ? ` working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
              : inProgressTodo
                ? ` working on: "${inProgressTodo.text.slice(0, 80)}${inProgressTodo.text.length > 80 ? '...' : ''}"`
                : '';
            return `- ${a.name} [${a.status}] [${projectTag}] (${a.role || 'worker'})${todoInfo}${taskInfo}`;
          });
          output += lines.join('\n') + '\n';

          console.log(`👥 [List Agents] ${enabled.length} enabled agents across ${projectKeys.length} projects`);
          if (streamCallback) streamCallback(output);
        }

        // ── Process @get_available_agent commands ─────────────────────────
        const getAvailableCommands = this._parseGetAvailableAgent(responseForParsing);
        for (const cmd of getAvailableCommands) {
          const allMatching = Array.from(this.agents.values()).filter(
            a => a.id !== id && a.enabled !== false && a.status === 'idle' && (a.role || '').toLowerCase() === cmd.role.toLowerCase()
          );
          if (allMatching.length > 0) {
            const lines = allMatching.map(a => {
              const projectInfo = a.project ? `project=${a.project}` : 'no project';
              const todoCount = (a.todoList || []).filter(t => t.status !== 'done').length;
              const todoInfo = todoCount > 0 ? `, ${todoCount} pending todos` : '';
              return `  - ${a.name} [idle] (${projectInfo}${todoInfo})`;
            });
            console.log(`🔍 [Get Available] Found ${allMatching.length} idle "${cmd.role}" agent(s)`);
            if (streamCallback) streamCallback(`\n🔍 Available ${cmd.role} agents (${allMatching.length} idle):\n${lines.join('\n')}\n`);
          } else {
            // Show busy agents with that role as a hint
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

        // ── Process @swarm_status commands ──────────────────────────────
        if (/@swarm_status\s*\(\s*\)/i.test(responseForParsing)) {
          const swarmStatus = this.getSwarmStatus();
          const s = swarmStatus.summary;
          let output = `\n📊 Swarm Status: ${s.enabled} agents (${s.busy} busy, ${s.idle} idle, ${s.error} error) | ${s.activeProjects.length} active projects\n`;
          // Group by project
          for (const [project, agents] of Object.entries(swarmStatus.projectAssignments)) {
            const ps = swarmStatus.projectSummaries[project];
            output += `\n📁 Project: ${project} (${ps.total} agents: ${ps.busy} busy, ${ps.idle} idle)\n`;
            for (const a of agents) {
              const taskInfo = a.currentTask
                ? ` — working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
                : '';
              const todoInfo = a.todos.inProgress > 0 || a.todos.pending > 0
                ? ` | todos: ${a.todos.inProgress} in-progress, ${a.todos.pending} pending`
                : '';
              output += `  - ${a.name} [${a.status}] (${a.role})${todoInfo}${taskInfo}\n`;
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

        // ── Process @agents_on_project commands ─────────────────────────
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
              const todoInfo = a.todos.inProgress > 0 || a.todos.pending > 0
                ? ` | todos: ${a.todos.inProgress} in-progress, ${a.todos.pending} pending`
                : '';
              output += `  - ${a.name} [${a.status}] (${a.role})${todoInfo}${taskInfo}\n`;
            }
            console.log(`📁 [Agents On Project] ${agents.length} agents on "${cmd.projectName}"`);
            if (streamCallback) streamCallback(output);
          } else {
            console.log(`📁 [Agents On Project] No agents assigned to "${cmd.projectName}"`);
            if (streamCallback) streamCallback(`\n📁 No agents are currently assigned to project "${cmd.projectName}"\n`);
          }
        }
      }

      this.setStatus(id, 'idle');
      this.abortControllers.delete(id); // Clean up abort controller
      return fullResponse;
    } catch (err) {
      // ── Reactive compaction: context exceeded → compact and retry once ──
      if (this._isContextExceededError(err.message) && !agent._compactionRetried) {
        console.log(`🗜️  [Reactive Compact] "${agent.name}": context exceeded — compacting and retrying`);
        agent._compactionRetried = true;  // Prevent infinite retry loop
        try {
          if (streamCallback) streamCallback(`\n⚠️ *Context limit exceeded — compacting conversation and retrying...*\n`);
          await this._compactHistory(agent, 6);
          agent._compactionArmed = false;
          // Retry the same message (it's already in conversationHistory, so remove the last entry to avoid duplication)
          agent.conversationHistory.pop();
          const retryResult = await this.sendMessage(id, userMessage, streamCallback, delegationDepth, messageMeta);
          delete agent._compactionRetried;
          return retryResult;
        } catch (retryErr) {
          delete agent._compactionRetried;
          // Retry also failed — fall through to normal error handling
          console.error(`🗜️  [Reactive Compact] "${agent.name}": retry after compaction also failed: ${retryErr.message}`);
          this.abortControllers.delete(id);
          agent.metrics.errors += 1;
          agent.currentThinking = '';
          this.setStatus(id, 'error', retryErr.message);
          saveAgent(agent);
          throw retryErr;
        }
      }

      // ── Transient stream error → retry with backoff ──
      // Covers: network drops, LLM stream timeouts, server-side 5xx, idle timeouts.
      // Do NOT retry on: user abort, context exceeded (handled above), auth errors.
      const isUserStop = err.message === 'Agent stopped by user';
      const isAuthError = err.status === 401 || err.status === 403;
      const isTransient = !isUserStop && !isAuthError && !this._isContextExceededError(err.message);
      const MAX_STREAM_RETRIES = 3;
      const retryCount = agent._streamRetryCount || 0;

      if (isTransient && retryCount < MAX_STREAM_RETRIES && !abortController.signal.aborted) {
        agent._streamRetryCount = retryCount + 1;
        const delay = 2000 * Math.pow(2, retryCount); // 2s, 4s, 8s
        console.log(`🔄 [Stream Retry] "${agent.name}": ${err.message} — retry ${retryCount + 1}/${MAX_STREAM_RETRIES} in ${delay}ms`);
        if (streamCallback) streamCallback(`\n⚠️ *Connection lost, retrying (${retryCount + 1}/${MAX_STREAM_RETRIES})...*\n`);
        await new Promise(r => setTimeout(r, delay));
        // Remove the user message we already pushed to avoid duplication
        agent.conversationHistory.pop();
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
          throw retryErr;
        }
      }
      delete agent._streamRetryCount;

      this.abortControllers.delete(id); // Clean up abort controller
      agent.metrics.errors += 1;
      agent.currentThinking = '';
      this.setStatus(id, isUserStop ? 'idle' : 'error', err.message);
      saveAgent(agent); // Persist error count
      throw err;
    }
  }

  // ─── Tool Execution ────────────────────────────────────────────────
  async _processToolCalls(agentId, response, streamCallback, depth = 0) {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    const toolCalls = parseToolCalls(response);
    
    console.log(`\n🔧 [Tools] Parsing response from "${agent.name}" (depth=${depth}, length=${response.length})`);
    
    if (toolCalls.length === 0) {
      // Log if we see tool-like patterns that didn't parse
      const rawCount = (response.match(/@(read_file|write_file|list_dir|search_files|run_command|append_file)/gi) || []).length;
      const tagCount = (response.match(/<tool_call>/gi) || []).length;
      if (rawCount > 0 || tagCount > 0) {
        console.warn(`⚠️  [Tools] Agent "${agent.name}": found ${rawCount} @tool mention(s) and ${tagCount} <tool_call> tag(s) but parseToolCalls returned 0 matches`);
        // Log lines containing tool patterns for debugging
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
    
    console.log(`🔧 Agent ${agent.name} executing ${toolCalls.length} tool(s) (project=${agent.project})`);

    // Ensure sandbox container is running with the correct project (or workspace-only)
    if (this.sandboxManager) {
      try {
        if (agent.project) {
          const gitUrl = await getProjectGitUrl(agent.project);
          if (gitUrl) {
            await this.sandboxManager.ensureSandbox(agentId, agent.project, gitUrl);
          } else {
            console.warn(`⚠️  [Sandbox] No git URL found for project "${agent.project}"`);
          }
        } else {
          // No project — ensure sandbox exists at workspace root (access to all projects)
          await this.sandboxManager.ensureSandbox(agentId);
        }
      } catch (err) {
        console.error(`⚠️  [Sandbox] Failed to ensure sandbox for ${agent.name}:`, err.message);
      }
    }

    const results = [];
    for (const call of toolCalls) {
      // ── Handle @report_error() specially ─────────────────────────────
      if (call.tool === 'report_error') {
        const errorDescription = call.args[0] || 'Unknown error';
        console.log(`🚨 [Error Report] Agent "${agent.name}" reports: ${errorDescription.slice(0, 200)}`);
        
        // Emit error report event for UI notifications
        this._emit('agent:error:report', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          description: errorDescription,
          timestamp: new Date().toISOString()
        });

        // Also push into stream so the user can see it inline
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

      // ── Handle @update_todo() — update own task status ──────────────
      if (call.tool === 'update_todo') {
        const [todoId, newStatus] = call.args;
        const validStatuses = ['in_progress', 'done', 'error'];
        if (!validStatuses.includes(newStatus)) {
          results.push({ tool: 'update_todo', args: call.args, success: false, error: `Invalid status "${newStatus}". Valid: ${validStatuses.join(', ')}` });
          continue;
        }
        const todo = agent.todoList?.find(t => t.id === todoId);
        if (!todo) {
          results.push({ tool: 'update_todo', args: call.args, success: false, error: `Todo not found: ${todoId}` });
          continue;
        }
        todo.status = newStatus;
        if (newStatus === 'in_progress') todo.startedAt = new Date().toISOString();
        if (newStatus === 'done') todo.completedAt = new Date().toISOString();
        saveAgent(agent);
        this._emit('agent:updated', this._sanitize(agent));
        console.log(`📋 [Todo] Agent "${agent.name}" updated todo "${todo.text.slice(0, 50)}" → ${newStatus}`);
        results.push({ tool: 'update_todo', args: call.args, success: true, result: `Todo "${todo.text}" updated to ${newStatus}` });
        continue;
      }

      // ── Handle @list_my_tasks() — list agent's own tasks ────────────
      if (call.tool === 'list_my_tasks') {
        const todos = agent.todoList || [];
        const header = `Agent: ${agent.name} | Project: ${agent.project || 'none'} | Status: ${agent.status}`;
        if (todos.length === 0) {
          results.push({ tool: 'list_my_tasks', args: [], success: true, result: `${header}\nNo tasks assigned.` });
        } else {
          const statusIcons = { pending: '[ ]', in_progress: '[~]', done: '[x]', error: '[!]' };
          const lines = todos.map(t => `${statusIcons[t.status] || '[ ]'} ${t.id} — ${t.text}`);
          results.push({ tool: 'list_my_tasks', args: [], success: true, result: `${header}\n${lines.join('\n')}` });
        }
        continue;
      }

      // ── Handle @check_status() — agent checks its own detailed status ─
      if (call.tool === 'check_status') {
        const todoList = agent.todoList || [];
        const pendingTodos = todoList.filter(t => t.status === 'pending').length;
        const inProgressTodos = todoList.filter(t => t.status === 'in_progress').length;
        const doneTodos = todoList.filter(t => t.status === 'done').length;
        const errorTodos = todoList.filter(t => t.status === 'error').length;
        const totalTodos = todoList.length;
        const msgCount = (agent.conversationHistory || []).length;
        const hasSandbox = this.sandboxManager ? this.sandboxManager.hasSandbox(agent.id) : false;
        const inProgressTodo = todoList.find(t => t.status === 'in_progress');
        const currentTaskInfo = agent.currentTask
          ? agent.currentTask.slice(0, 120)
          : inProgressTodo
            ? inProgressTodo.text.slice(0, 120)
            : 'none';
        const projectAssignedAt = agent.projectChangedAt
          ? new Date(agent.projectChangedAt).toLocaleString()
          : 'n/a';

        const lines = [
          `Name: ${agent.name}`,
          `Status: ${agent.status}`,
          `Role: ${agent.role || 'worker'}`,
          `Project: ${agent.project || 'none'}${agent.project ? ` (assigned ${projectAssignedAt})` : ''}`,
          `Current task: ${currentTaskInfo}`,
          `Provider: ${agent.provider || 'unknown'}/${agent.model || 'unknown'}`,
          `Sandbox: ${hasSandbox ? 'running' : 'not running'}`,
          `Todos: ${inProgressTodos} in-progress, ${pendingTodos} pending, ${doneTodos} done, ${errorTodos} error / ${totalTodos} total`,
          `Messages: ${msgCount}`,
          `Last active: ${agent.metrics?.lastActiveAt || 'never'}`,
          `Errors: ${agent.metrics?.errors || 0}`,
        ];
        // Show active todo details
        const activeTodos = todoList.filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'error');
        if (activeTodos.length > 0) {
          lines.push(`Active todos:`);
          for (const t of activeTodos.slice(0, 10)) {
            const mark = t.status === 'in_progress' ? '~' : t.status === 'error' ? '!' : ' ';
            lines.push(`  [${mark}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '...' : ''}`);
          }
          if (activeTodos.length > 10) lines.push(`  ... and ${activeTodos.length - 10} more`);
        }

        console.log(`📊 [Check Status] Agent "${agent.name}": ${agent.status} | project=${agent.project || 'none'} | task=${currentTaskInfo}`);
        results.push({ tool: 'check_status', args: [], success: true, result: lines.join('\n') });
        continue;
      }

      // ── Handle @mcp_call() — delegate to MCP server ────────────────
      if (call.tool === 'mcp_call') {
        const [serverName, toolName, argsJson] = call.args;
        const mcpLabel = `MCP: ${serverName} → ${toolName}`;
        agent.currentThinking = mcpLabel;
        this._emit('agent:thinking', { agentId, thinking: mcpLabel });
        this._emit('agent:tool:start', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args });

        try {
          const parsedArgs = typeof argsJson === 'string' ? JSON.parse(argsJson) : (argsJson || {});
          const mcpResult = await this.mcpManager.callToolByName(serverName, toolName, parsedArgs);

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

      try {
        // Update thinking indicator with a descriptive message showing file paths
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

        // Emit structured tool-start event (not raw text into stream)
        this._emit('agent:tool:start', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          tool: call.tool,
          args: call.args
        });

        const result = await executeTool(call.tool, call.args, agent.project, this.sandboxManager, agentId);
        results.push({
          tool: call.tool,
          args: call.args,
          ...result
        });

        // Stream a one-liner per tool execution into the chat
        if (streamCallback) {
          const statusIcon = result.success ? '✓' : '✗';
          streamCallback(`\n${statusIcon} ${toolLabel}\n`);
        }

        if (result.success) {
          // Emit structured tool-result event
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
          // ── Tool returned an error ─────────────────────────────────
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

          // Push error visibly into the stream (include actual output when available)
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
  }

  // ─── Delegation Processing (for Leader agents) ────────────────────

  /**
   * Pure parser: extract all complete @delegate(Agent, "task") commands from text.
   * Returns array of { agentName, task }.
   */
  _parseDelegations(text) {
    // Build code-block ranges to skip @delegate inside examples/docs
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const delegations = [];
    const delegateRe = /@delegate\s*\(/gi;
    let reMatch;
    while ((reMatch = delegateRe.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;

      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const agentName = text.slice(startAfterParen, commaIdx).trim();

      let i = commaIdx + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quoteChar = text[i];
      if (quoteChar !== '"' && quoteChar !== "'") continue;
      i++;

      let taskContent = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          taskContent += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quoteChar) {
          let j = i + 1;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (j < text.length && text[j] === ')') {
            found = true;
            break;
          }
          taskContent += text[i];
          i++;
          continue;
        }
        taskContent += text[i];
        i++;
      }

      if (found && agentName && taskContent.trim()) {
        delegations.push({ agentName, task: taskContent.trim() });
      }
    }
    return delegations;
  }

  /**
   * Parse @assign_project(AgentName, "project_name") commands from leader output.
   * Returns array of { targetAgentName, projectName }.
   */
  _parseProjectAssignments(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const assignments = [];
    const re = /@assign_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;

      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, commaIdx).trim();

      let i = commaIdx + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quoteChar = text[i];
      if (quoteChar !== '"' && quoteChar !== "'") continue;
      i++;

      let projectName = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          projectName += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quoteChar) {
          let j = i + 1;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (j < text.length && text[j] === ')') {
            found = true;
            break;
          }
          projectName += text[i];
          i++;
          continue;
        }
        projectName += text[i];
        i++;
      }

      if (found && targetAgentName && projectName.trim()) {
        assignments.push({ targetAgentName, projectName: projectName.trim() });
      }
    }
    return assignments;
  }

  /**
   * Parse @get_project(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseGetProject(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@get_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @clear_context(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseClearContext(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@clear_context\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @agent_status(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseAgentStatus(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@agent_status\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @get_available_agent(role) commands from leader output.
   * Returns array of { role }.
   */
  _parseGetAvailableAgent(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@get_available_agent\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const role = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (role) {
        results.push({ role });
      }
    }
    return results;
  }

  /**
   * Parse @agents_on_project(projectName) commands from leader output.
   * Returns array of { projectName }.
   */
  _parseAgentsOnProject(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@agents_on_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const projectName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (projectName) {
        results.push({ projectName });
      }
    }
    return results;
  }

  /**
   * Parse @stop_agent(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseStopAgent(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@stop_agent\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @rollback(AgentName, X) commands from leader output.
   * Returns array of { targetAgentName, count }.
   */
  _parseRollback(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@rollback\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, commaIdx).trim().replace(/^["']|["']$/g, '');
      const closeIdx = text.indexOf(')', commaIdx + 1);
      if (closeIdx === -1) continue;
      const countStr = text.slice(commaIdx + 1, closeIdx).trim();
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count <= 0) continue;
      if (targetAgentName) {
        results.push({ targetAgentName, count });
      }
    }
    return results;
  }

  /**
   * List available project directories (same logic as projects.js route).
   */
  async _listAvailableProjects() {
    try {
      const repos = await listStarredRepos();
      return repos.map(r => r.name).sort();
    } catch {
      return [];
    }
  }

  /**
   * Execute a single delegation: find target agent, create todo, send message, mark done.
   * Returns { agentId, agentName, task, response, error }.
   */
  async _executeSingleDelegation(leaderId, delegation, streamCallback, delegationDepth) {
    const leader = this.agents.get(leaderId);
    const targetAgent = Array.from(this.agents.values()).find(
      a => a.name.toLowerCase() === delegation.agentName.toLowerCase() && a.id !== leaderId
    );

    if (!targetAgent) {
      console.log(`⚠️  Agent "${delegation.agentName}" not found in swarm`);
      if (streamCallback) streamCallback(`\n⚠️ Agent "${delegation.agentName}" not found in swarm\n`);
      return { agentName: delegation.agentName, response: null, error: `Agent "${delegation.agentName}" not found in swarm` };
    }

    try {
      console.log(`📨 Delegating to ${targetAgent.name}: ${delegation.task.slice(0, 80)}...`);
      if (streamCallback) streamCallback(`\n\n--- 📨 Delegating to ${targetAgent.name} ---\n`);

      this._emit('agent:delegation', {
        from: { id: leaderId, name: leader.name, project: leader.project || null },
        to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
        task: delegation.task
      });

      const todo = this.addTodo(targetAgent.id, `[From ${leader.name}] ${delegation.task}`);

      // Mark todo as in_progress
      if (todo) {
        const t = targetAgent.todoList.find(t => t.id === todo.id);
        if (t) {
          t.status = 'in_progress';
          t.startedAt = new Date().toISOString();
          saveAgent(targetAgent);
          this._emit('agent:updated', this._sanitize(targetAgent));
        }
      }

      let delegateStreamStarted = false;
      const agentResponse = await this.sendMessage(
        targetAgent.id,
        `[TASK from ${leader.name}]: ${delegation.task}`,
        (chunk) => {
          if (streamCallback) {
            if (!delegateStreamStarted) {
              delegateStreamStarted = true;
              streamCallback(`\n**[${targetAgent.name}]:**\n`);
            }
            streamCallback(chunk);
          }
        },
        delegationDepth + 1,
        { type: 'delegation-task', fromAgent: leader.name }
      );

      if (todo) {
        const t = targetAgent.todoList.find(t => t.id === todo.id);
        if (t) {
          t.status = 'done';
          t.completedAt = new Date().toISOString();
          saveAgent(targetAgent);
          this._emit('agent:updated', this._sanitize(targetAgent));
        }
      }

      return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
    } catch (err) {
      return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: null, error: err.message };
    }
  }

  // ─── Global Broadcast (tmux-style) ─────────────────────────────────
  async broadcastMessage(message, streamCallback) {
    const agents = Array.from(this.agents.values()).filter(a => a.enabled !== false);
    const results = [];

    const promises = agents.map(async (agent) => {
      try {
        const response = await this.sendMessage(
          agent.id,
          message,
          (chunk) => streamCallback && streamCallback(agent.id, chunk)
        );
        results.push({ agentId: agent.id, agentName: agent.name, response, error: null });
      } catch (err) {
        results.push({ agentId: agent.id, agentName: agent.name, response: null, error: err.message });
      }
    });

    await Promise.all(promises);
    return results;
  }

  // ─── Handoff ────────────────────────────────────────────────────────
  async handoff(fromId, toId, context, streamCallback) {
    const fromAgent = this.agents.get(fromId);
    const toAgent = this.agents.get(toId);
    if (!fromAgent || !toAgent) throw new Error('Agent not found');

    const handoffMessage = `[HANDOFF from ${fromAgent.name}]: ${context}\n\nPrevious conversation context:\n${
      fromAgent.conversationHistory.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n')
    }`;

    this._emit('agent:handoff', {
      from: { id: fromId, name: fromAgent.name, project: fromAgent.project || null },
      to: { id: toId, name: toAgent.name, project: toAgent.project || null },
      context
    });

    // File system transfer between agents
    const fileTransferResult = await transferUserFiles(fromId, toId);

    const response = await this.sendMessage(toId, handoffMessage, streamCallback);

    return {
      ...response,
      fileTransfer: fileTransferResult
    };
  }

  // ─── Action Logs ──────────────────────────────────────────────────
  static MAX_ACTION_LOGS = 200;

  addActionLog(agentId, type, message, errorDetail = null) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const now = new Date();

    // Compute duration for the previous log entry (how long that state lasted)
    if (agent.actionLogs.length > 0) {
      const lastLog = agent.actionLogs[agent.actionLogs.length - 1];
      if (!lastLog.durationMs) {
        lastLog.durationMs = now.getTime() - new Date(lastLog.timestamp).getTime();
      }
    }

    const entry = {
      id: uuidv4(),
      type,
      message,
      error: errorDetail,
      timestamp: now.toISOString()
    };

    agent.actionLogs.push(entry);
    if (agent.actionLogs.length > AgentManager.MAX_ACTION_LOGS) {
      agent.actionLogs = agent.actionLogs.slice(-AgentManager.MAX_ACTION_LOGS);
    }

    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return entry;
  }

  clearActionLogs(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.actionLogs = [];
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Todo Management ───────────────────────────────────────────────
  addTodo(agentId, text) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const todo = { id: uuidv4(), text, status: 'pending', createdAt: new Date().toISOString() };
    agent.todoList.push(todo);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return todo;
  }

  toggleTodo(agentId, todoId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const todo = agent.todoList.find(t => t.id === todoId);
    if (!todo) return null;
    todo.status = todo.status === 'done' ? 'pending' : 'done';
    if (todo.status === 'done') todo.completedAt = new Date().toISOString();
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return todo;
  }

  setTodoStatus(agentId, todoId, status) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const todo = agent.todoList.find(t => t.id === todoId);
    if (!todo) return null;
    todo.status = status;
    if (status === 'done') todo.completedAt = new Date().toISOString();
    if (status === 'in_progress') todo.startedAt = new Date().toISOString();
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return todo;
  }

  deleteTodo(agentId, todoId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.todoList = agent.todoList.filter(t => t.id !== todoId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // Execute a single todo — sends it as a chat message to the agent
  async executeTodo(agentId, todoId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const todo = agent.todoList.find(t => t.id === todoId);
    if (!todo) throw new Error('Todo not found');
    if (todo.status === 'done') throw new Error('Todo already completed');
    if (todo.status === 'in_progress') throw new Error('Todo already in progress');

    console.log(`▶️  Executing todo for ${agent.name}: "${todo.text.slice(0, 80)}"`);

    // Mark as in_progress
    todo.status = 'in_progress';
    todo.startedAt = new Date().toISOString();
    delete todo.error;
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    this._emit('agent:todo:executing', { agentId, todoId, text: todo.text });

    try {
      const response = await this.sendMessage(
        agentId,
        `[TASK] ${todo.text}`,
        streamCallback
      );

      // Mark as done
      todo.status = 'done';
      todo.completedAt = new Date().toISOString();
      saveAgent(agent);
      this._emit('agent:updated', this._sanitize(agent));

      return { todoId, response };
    } catch (err) {
      // Mark as error
      todo.status = 'error';
      todo.error = err.message;
      saveAgent(agent);
      this._emit('agent:updated', this._sanitize(agent));
      this._emit('agent:todo:error', { agentId, todoId, error: err.message });
      throw err;
    }
  }

  // Execute all pending todos sequentially
  async executeAllTodos(agentId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    const pending = agent.todoList.filter(t => t.status === 'pending' || t.status === 'error');
    if (pending.length === 0) throw new Error('No pending tasks');

    console.log(`▶️  Executing ${pending.length} pending todo(s) for ${agent.name}`);
    this._emit('agent:todo:executeAll:start', { agentId, count: pending.length });

    const results = [];
    for (const todo of pending) {
      try {
        const result = await this.executeTodo(agentId, todo.id, streamCallback);
        results.push({ todoId: todo.id, text: todo.text, success: true, response: result.response });
      } catch (err) {
        results.push({ todoId: todo.id, text: todo.text, success: false, error: err.message });
        // Continue with next todo
      }
    }

    this._emit('agent:todo:executeAll:complete', { agentId, results: results.map(r => ({ todoId: r.todoId, success: r.success })) });
    return results;
  }

  // ─── RAG Document Management ───────────────────────────────────────
  addRagDocument(agentId, name, content) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const doc = { id: uuidv4(), name, content, addedAt: new Date().toISOString() };
    agent.ragDocuments.push(doc);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return doc;
  }

  deleteRagDocument(agentId, docId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.ragDocuments = agent.ragDocuments.filter(d => d.id !== docId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Skills ────────────────────────────────────────────────────────
  assignSkill(agentId, skillId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    if (!agent.skills) agent.skills = [];
    if (agent.skills.includes(skillId)) return agent.skills;
    agent.skills.push(skillId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.skills;
  }

  removeSkill(agentId, skillId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.skills) agent.skills = [];
    agent.skills = agent.skills.filter(id => id !== skillId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── MCP Servers ──────────────────────────────────────────────────
  assignMcpServer(agentId, serverId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    if (!agent.mcpServers) agent.mcpServers = [];
    if (agent.mcpServers.includes(serverId)) return agent.mcpServers;
    agent.mcpServers.push(serverId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.mcpServers;
  }

  removeMcpServer(agentId, serverId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.mcpServers) agent.mcpServers = [];
    agent.mcpServers = agent.mcpServers.filter(id => id !== serverId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Voice Agent Instructions ────────────────────────────────────
  buildVoiceInstructions(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    let instructions = agent.instructions || 'You are a helpful voice assistant.';

    // Inject available agents for delegation
    const availableAgents = Array.from(this.agents.values())
      .filter(a => a.id !== agentId && a.enabled !== false)
      .map(a => `- ${a.name} (${a.role}): ${a.description || 'No description'}`);

    if (availableAgents.length > 0) {
      instructions += `\n\n--- Available Swarm Agents ---\nYou can delegate tasks to these agents using the "delegate" function. Call it with the agent's name and a detailed task description.\n${availableAgents.join('\n')}\n\nWhen you need an agent to work on something, use the delegate function. The result will be provided back to you and you should summarize it vocally.`;
    }

    // Append RAG context
    if (agent.ragDocuments && agent.ragDocuments.length > 0) {
      instructions += '\n\n--- Reference Documents ---\n';
      for (const doc of agent.ragDocuments) {
        instructions += `\n[${doc.name}]:\n${doc.content}\n`;
      }
    }

    // Append Skills context
    const agentSkills = agent.skills || [];
    if (agentSkills.length > 0 && this.skillManager) {
      const resolvedSkills = agentSkills.map(sid => this.skillManager.getById(sid)).filter(Boolean);
      if (resolvedSkills.length > 0) {
        instructions += '\n\n--- Active Skills ---\n';
        for (const skill of resolvedSkills) {
          instructions += `\n[${skill.name}]:\n${skill.instructions}\n`;
        }
      }
    }

    // Append todo list context
    if (agent.todoList && agent.todoList.length > 0) {
      instructions += '\n\n--- Current Todo List ---\n';
      for (const todo of agent.todoList) {
        const mark = todo.status === 'done' ? 'x' : todo.status === 'in_progress' ? '~' : todo.status === 'error' ? '!' : ' ';
        instructions += `- [${mark}] ${todo.text}\n`;
      }
    }

    return instructions;
  }

  // ─── Clear Conversation ────────────────────────────────────────────
  clearHistory(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.conversationHistory = [];
    agent.currentThinking = '';
    delete agent._compactionArmed;
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Truncate Conversation (keep messages 0..afterIndex, remove the rest) ──
  truncateHistory(agentId, afterIndex) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const idx = parseInt(afterIndex, 10);
    if (isNaN(idx) || idx < 0) return null;
    // Keep messages from 0 to afterIndex (inclusive)
    agent.conversationHistory = agent.conversationHistory.slice(0, idx + 1);
    // Remove any stale compaction summary — it refers to messages that may no longer exist
    agent.conversationHistory = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
    delete agent._compactionArmed;
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.conversationHistory;
  }

  // ─── Project Context Switching ──────────────────────────────────────
  /**
   * Save the current conversation context keyed by oldProject,
   * then restore any previously saved context for newProject.
   * If no saved context exists for newProject, start with a clean history.
   */
  _switchProjectContext(agent, oldProject, newProject) {
    if (!agent.projectContexts) agent.projectContexts = {};

    // Save current context under the OLD project key (if there is one)
    if (oldProject) {
      agent.projectContexts[oldProject] = {
        conversationHistory: [...agent.conversationHistory],
        _compactionArmed: agent._compactionArmed,
        savedAt: new Date().toISOString()
      };
      console.log(`💾 [Context Switch] Saved context for "${agent.name}" on project "${oldProject}" (${agent.conversationHistory.length} messages)`);
    }

    // Restore context for the NEW project (if one was previously saved)
    if (newProject && agent.projectContexts[newProject]) {
      const saved = agent.projectContexts[newProject];
      agent.conversationHistory = [...saved.conversationHistory];
      agent._compactionArmed = saved._compactionArmed;
      delete agent.projectContexts[newProject];
      console.log(`📂 [Context Switch] Restored context for "${agent.name}" on project "${newProject}" (${agent.conversationHistory.length} messages)`);
    } else {
      // No saved context for the new project: start fresh
      agent.conversationHistory = [];
      agent.currentThinking = '';
      delete agent._compactionArmed;
      console.log(`🆕 [Context Switch] Clean slate for "${agent.name}" on project "${newProject || '(none)'}"`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * Rough token estimation (~4 chars per token for English, ~3 for code).
   * This is a fast heuristic — not exact, but good enough for compaction triggers.
   */
  _estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) {
      chars += (m.content || '').length;
    }
    return Math.ceil(chars / 3.5);
  }

  /**
   * Detect if an error message indicates the context window was exceeded.
   */
  _isContextExceededError(errMsg) {
    const lower = (errMsg || '').toLowerCase();
    return [
      'context length', 'context_length', 'num_ctx', 'context window',
      'too long', 'maximum context', 'exceeds', 'token limit',
      'kv cache full', 'prompt is too long', 'input too long',
      'context_length_exceeded'
    ].some(kw => lower.includes(kw));
  }

  /**
   * Compact (summarize) the conversation history to free up context space.
   *
   * Strategy:
   *  1. Keep the system prompt (always first)
   *  2. Keep the last `keepRecent` messages untouched (most relevant)
   *  3. Summarize everything in between into a single assistant message
   *  4. Replace the agent's conversationHistory with: [summary, ...recentMessages]
   *
   * The summarization is done via a short non-streaming LLM call with a
   * very compact system prompt.  If summarization itself fails, we fall back
   * to a hard truncation (drop oldest messages).
   */
  async _compactHistory(agent, keepRecent = 10) {
    const history = agent.conversationHistory;
    if (history.length <= keepRecent + 2) {
      // Not enough to compact — fall back to hard truncation: keep last keepRecent
      agent.conversationHistory = history.slice(-keepRecent);
      saveAgent(agent);
      console.log(`🗜️  [Compact] "${agent.name}": hard truncation to ${agent.conversationHistory.length} msgs (history too short for summary)`);
      return;
    }

    // Split: messages to summarize vs messages to keep
    const toSummarize = history.slice(0, history.length - keepRecent);
    const toKeep = history.slice(-keepRecent);

    // Build a compact representation of messages to summarize
    const summaryInput = toSummarize.map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages in the summary input
      const content = (m.content || '').length > 2000
        ? (m.content || '').slice(0, 2000) + '... [truncated]'
        : (m.content || '');
      return `[${role}]: ${content}`;
    }).join('\n\n');

    try {
      const provider = createProvider({
        provider: agent.provider,
        model: agent.model,
        endpoint: agent.endpoint,
        apiKey: agent.apiKey
      });

      console.log(`🗜️  [Compact] "${agent.name}": summarizing ${toSummarize.length} messages, keeping ${toKeep.length} recent`);

      const summaryResponse = await provider.chat([
        {
          role: 'system',
          content: 'You are a conversation summarizer. Produce a concise but complete summary of the conversation below. Preserve: key decisions made, files modified, errors encountered, current task status, and any important context the assistant needs to continue working. Be factual and structured. Use bullet points. Maximum 500 words.'
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${summaryInput.slice(0, 12000)}`
        }
      ], {
        temperature: 0.2,
        maxTokens: 1024,
        contextLength: agent.contextLength || 0
      });

      const summaryText = summaryResponse.content || '';
      if (!summaryText.trim()) throw new Error('Empty summary');

      // Replace history: one summary message + recent messages
      agent.conversationHistory = [
        {
          role: 'assistant',
          content: `[CONVERSATION SUMMARY — earlier messages were compacted to save context]\n\n${summaryText}`,
          timestamp: new Date().toISOString(),
          type: 'compaction-summary'
        },
        ...toKeep
      ];

      saveAgent(agent);
      console.log(`🗜️  [Compact] "${agent.name}": compacted ${history.length} → ${agent.conversationHistory.length} messages`);

    } catch (summaryErr) {
      // Summarization failed — hard truncation fallback
      console.warn(`🗜️  [Compact] "${agent.name}": summarization failed (${summaryErr.message}), falling back to hard truncation`);
      agent.conversationHistory = toKeep;
      saveAgent(agent);
    }

    this._emit('agent:updated', this._sanitize(agent));
  }

  // ─── Automatic Task Loop ───────────────────────────────────────────
  // Periodically scans idle+enabled agents for pending todos and executes the first one.

  startTaskLoop(intervalMs = 5000) {
    if (this._taskLoopInterval) return;
    this._loopProcessing = new Set();
    this._taskLoopInterval = setInterval(() => this._processNextPendingTasks(), intervalMs);
    console.log(`🔄 Task loop started (every ${intervalMs / 1000}s)`);
  }

  stopTaskLoop() {
    if (this._taskLoopInterval) {
      clearInterval(this._taskLoopInterval);
      this._taskLoopInterval = null;
      console.log('🔄 Task loop stopped');
    }
  }

  _processNextPendingTasks() {
    for (const [agentId, agent] of this.agents) {
      // Skip disabled, non-idle, or already being processed by the loop
      if (agent.enabled === false) continue;
      if (agent.status !== 'idle') continue;
      if (this._loopProcessing.has(agentId)) continue;

      // Find the first pending todo
      const todo = agent.todoList?.find(t => t.status === 'pending');
      if (!todo) continue;

      // Mark as being processed by the loop to avoid double-pickup on next tick
      this._loopProcessing.add(agentId);

      // Build a streamCallback that broadcasts to all connected clients
      const streamCallback = (chunk) => {
        this._emit('agent:stream:chunk', { agentId, chunk });
        this._emit('agent:thinking', {
          agentId,
          thinking: agent.currentThinking || ''
        });
      };

      this._emit('agent:stream:start', { agentId });

      this.executeTodo(agentId, todo.id, streamCallback)
        .then(() => {
          this._emit('agent:stream:end', { agentId });
          this._emit('agent:updated', this._sanitize(agent));
        })
        .catch((err) => {
          console.error(`🔄 Task loop error for ${agent.name}:`, err.message);
          this._emit('agent:stream:error', { agentId, error: err.message });
        })
        .finally(() => {
          this._loopProcessing.delete(agentId);
        });
    }
  }

  /**
   * Per-agent sequential task queue.
   * Tasks are added instantly (returns a Promise) but execute one at a time.
   * Multiple callers can enqueue concurrently — the queue serialises execution.
   */
  _enqueueAgentTask(agentId, taskFn) {
    if (!this._taskQueues.has(agentId)) {
      this._taskQueues.set(agentId, Promise.resolve());
    }

    // Chain the new task after whatever is currently running/queued
    const resultPromise = this._taskQueues.get(agentId).then(
      () => taskFn(),
      () => taskFn()   // If the previous task rejected, still run the next one
    );

    // Update the queue tail (ignore rejections so the chain never breaks)
    this._taskQueues.set(agentId, resultPromise.catch(() => {}));

    return resultPromise;
  }

  _sanitize(agent) {
    const { apiKey, ...rest } = agent;
    return { ...rest, hasApiKey: !!apiKey };
  }

  _emit(event, data) {
    if (this.io) this.io.emit(event, data);
  }

  _randomColor() {
    const colors = [
      '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
      '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }
}