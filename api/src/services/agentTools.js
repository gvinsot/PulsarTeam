// Tool definitions that will be injected into agent prompts
export const TOOL_DEFINITIONS = `
--- AVAILABLE TOOLS ---
You can interact with project files using these commands. Use the exact format shown.

@read_file(path) - Read contents of a file
  @read_file(path, startLine, endLine) - Read specific line range (1-indexed, inclusive)
  Example: @read_file(src/index.js)
  Example: @read_file(src/index.js, 10, 25)

@write_file(path, content) - Write content to a file (creates directories if needed)
  Example: @write_file(src/utils/helper.js, """
  export function helper() {
    return 'Hello';
  }
  """)

@list_dir(path) - List contents of a directory
  Example: @list_dir(src)

@search_files(pattern, query) - Search for text in files matching a glob pattern
  Example: @search_files(*.js, function authenticate)

@run_command(command) - Run a shell command in the project directory
  Example: @run_command(npm test)
  Example: @run_command(grep -r "TODO" src/)

@append_file(path, content) - Append content to end of a file
  Example: @append_file(CHANGELOG.md, """
  ## v1.0.1
  - Fixed bug
  """)

@list_my_tasks() - List all your current tasks with their status and ID
  Use this to check what tasks are assigned to you and their current state.
  Example: @list_my_tasks()

@update_task(taskId, status, details) - Update the status of one of your tasks
  The status can be any workflow column ID (e.g., backlog, pending, code, build, test, deploy, done) or a system status (error).
  The details parameter is optional. When provided, the details text is appended to the task description.
  Use this to move a task between workflow columns, optionally adding context (e.g., error details, build output).
  Example: @update_task(abc-123, build)
  Example: @update_task(abc-123, done)
  Example: @update_task(abc-123, pending, Build failed: missing dependency libfoo)

@check_status() - Check your own detailed status including project assignment, task counts, and metrics
  Use this to see which project you are working on and your current state.
  Example: @check_status()

@report_error(description) - Report an error or problem back to the leader/manager agent
  Use this when you encounter a blocking issue you cannot resolve yourself.
  Example: @report_error(Cannot compile: missing dependency 'express'.)

@git_commit_push(message, taskId) - Stage all changes, commit with the given message, and push to remote
  Commits are automatically linked to your current active task.
  - message: (required) The commit message.
  - taskId: (optional) The task ID to link the commit to. If omitted, the commit is linked to your current active task.
  Example: @git_commit_push(feat: add user authentication)
  Example with explicit task: @git_commit_push(feat: add login page, abc-123)

@task_execution_complete(comment, taskId, commits) - Signal that you have finished executing your current task
  You MUST call this tool when you are done with your assigned task. Provide a brief summary of what was accomplished.
  Until you call this, the system will consider your task still in progress and will send you reminders.
  CRITICAL: This is the ONLY way the system knows your work is done. Do NOT skip this step.
  - comment: (required) A brief summary of what was accomplished.
  - taskId: (optional) The task ID to mark as complete. If omitted, the system auto-detects your current active task.
  - commits: (optional) A comma-separated list of commit hashes with messages, format: hash:message, hash:message
    IMPORTANT: The commit hashes MUST refer to commits that have already been pushed (via @git_commit_push).
    When provided, these commits are linked to the task automatically.
    If omitted, any commits already pushed via @git_commit_push are already auto-linked.
  Example: @task_execution_complete(Implemented user auth with JWT tokens, all tests passing.)
  Example with explicit task: @task_execution_complete(Implemented auth, abc-123)
  Example with commits: @task_execution_complete(Implemented user auth, abc-123, a1b2c3d:feat: add JWT auth, e4f5g6h:fix: token expiry)

IMPORTANT:
- File paths are relative to the project root
- Always read files before modifying them
- Use multi-line content with triple quotes """content"""
- After making changes, verify by reading the file
- Each tool call MUST be on its own line, with an empty line before and after it
- Do NOT add decorative text like "Editing file..." or "Now I'll read..." before tool calls — just call the tool directly
- NEVER stop yourself with messages like "[Agent stopped after N turns]" or "I'll stop here" — you have NO turn limit. Keep working until the task is fully complete.
- Your workspace is EPHEMERAL. Always @git_commit_push(message) after completing changes to preserve your work.
- WORKFLOW — You MUST follow these steps IN ORDER when executing a task:
  1. READ: Explore the codebase with @read_file, @list_dir, @search_files to understand the current state
  2. WRITE: Make all necessary changes using @write_file or @append_file
  3. VERIFY: Read back modified files to confirm correctness
  4. COMMIT: @git_commit_push(message) — save and push your work
  5. COMPLETE: @task_execution_complete(summary) — signal completion to the system
  CRITICAL: You MUST call @write_file BEFORE @git_commit_push. A commit without prior @write_file calls means NOTHING was changed.
  CRITICAL: Call tools ONE STEP AT A TIME. Do NOT batch all tools in a single response — wait for each tool result before proceeding to the next step.
`;

// Sanitize a tool argument: only strip a matching pair of surrounding quotes.
function sanitizeArg(arg) {
  if (!arg) return arg;
  arg = arg.trim();
  if (arg.length >= 2) {
    const first = arg[0], last = arg[arg.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      arg = arg.slice(1, -1);
    }
  }
  return arg.trim();
}

// Normalize path: strip absolute prefixes the LLM might hallucinate
function normalizePath(pathArg) {
  let p = sanitizeArg(pathArg);
  // Strip /workspace/<project>/ or /projects/<project>/ prefixes
  p = p.replace(/^\/workspace\/[^/]+\//, '');
  p = p.replace(/^\/projects\/[^/]+\//, '');
  // Strip any remaining leading slashes
  if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  // Prevent path traversal
  p = p.split('/').filter(seg => seg !== '..').join('/');
  return p || '.';
}

/**
 * Execute a tool command using the execution provider (sandbox or coder-service).
 * @param {string} toolName
 * @param {string[]} args
 * @param {string} projectPath - project name
 * @param {import('./execution/executionProvider.js').ExecutionProvider} provider
 * @param {string} agentId
 */
export async function executeTool(toolName, args, projectPath, provider, agentId, options = {}) {
  // report_error and update_task don't need sandbox access
  if (toolName === 'report_error') {
    const description = args[0] || 'Unknown error';
    return { success: true, result: `Error reported: ${description}`, isErrorReport: true };
  }
  if (toolName === 'update_task') {
    return { success: true, result: `Task update: ${args[0]} → ${args[1]}`, isTaskUpdate: true };
  }
  if (toolName === 'list_my_tasks') {
    return { success: true, result: 'Tasks listed', isTaskList: true };
  }
  if (toolName === 'check_status') {
    return { success: true, result: 'Status checked', isStatusCheck: true };
  }

  if (!provider || !agentId) {
    return { success: false, error: 'Execution provider not available' };
  }

  if (!provider.hasEnvironment(agentId)) {
    // Attempt lazy initialization instead of just returning an error
    try {
      await provider.ensureProject(agentId, projectPath || null);
    } catch (initErr) {
      console.error(`⚠️  [Tool] Provider lazy init failed for agent ${agentId.slice(0, 8)}: ${initErr.message}`);
    }
    if (!provider.hasEnvironment(agentId)) {
      return { success: false, error: 'Execution environment is not available. Please report this error.' };
    }
  }

  const cleanArgs = args.map(a => sanitizeArg(a));

  console.log(`🔧 [Tool] ${toolName}(${cleanArgs.map(a => a?.length > 100 ? a.slice(0, 100) + '...' : a).join(', ')}) | agent=${agentId.slice(0, 8)} project=${projectPath}`);

  try {
    switch (toolName) {
      case 'read_file':
        return await toolReadFile(provider, agentId, normalizePath(cleanArgs[0]), cleanArgs[1], cleanArgs[2]);

      case 'write_file':
        return await toolWriteFile(provider, agentId, normalizePath(cleanArgs[0]), cleanArgs[1]);

      case 'list_dir':
        return await toolListDir(provider, agentId, normalizePath(cleanArgs[0] || '.'));

      case 'search_files':
        return await toolSearchFiles(provider, agentId, cleanArgs[0], cleanArgs[1]);

      case 'run_command':
        return await toolRunCommand(provider, agentId, cleanArgs[0]);

      case 'append_file':
        return await toolAppendFile(provider, agentId, normalizePath(cleanArgs[0]), cleanArgs[1]);

      case 'git_commit_push':
        return await provider.gitCommitPush(agentId, cleanArgs[0]);

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Tool implementations (all via execution provider) ──────────────────

async function toolReadFile(provider, agentId, filePath, startLineArg, endLineArg) {
  try {
    const content = await provider.readFile(agentId, filePath);
    const allLines = content.split('\n');

    // Parse line range — handle both @read_file(path, 10, 25) and @read_file(path, "10, 25")
    let startLine = parseInt(startLineArg, 10);
    let endLine = parseInt(endLineArg, 10);
    // If startLineArg contains a comma (e.g. "10, 25" from 2-arg parser), split it
    if (isNaN(startLine) && typeof startLineArg === 'string' && startLineArg.includes(',')) {
      const parts = startLineArg.split(',').map(s => parseInt(s.trim(), 10));
      startLine = parts[0];
      endLine = parts[1];
    }

    if (!isNaN(startLine) && startLine > 0) {
      const start = Math.max(0, startLine - 1);
      const end = !isNaN(endLine) && endLine >= startLine ? Math.min(endLine, allLines.length) : allLines.length;
      const sliced = allLines.slice(start, end);
      return {
        success: true,
        result: sliced.join('\n'),
        meta: { path: filePath, startLine, endLine: end, totalLines: allLines.length }
      };
    }

    // Auto-truncate large files and hint the agent to use line ranges
    const MAX_LINES = 500;
    if (allLines.length > MAX_LINES) {
      const truncated = allLines.slice(0, MAX_LINES).join('\n');
      return {
        success: true,
        result: `${truncated}\n\n--- TRUNCATED: showing ${MAX_LINES}/${allLines.length} lines. Use @read_file(${filePath}, startLine, endLine) to read specific sections. ---`,
        meta: { path: filePath, size: content.length, lines: allLines.length, truncated: true }
      };
    }

    return {
      success: true,
      result: content,
      meta: { path: filePath, size: content.length, lines: allLines.length }
    };
  } catch (err) {
    if (err.message.includes('No such file')) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    throw err;
  }
}

async function toolWriteFile(provider, agentId, filePath, content) {
  await provider.writeFile(agentId, filePath, content);
  return {
    success: true,
    result: `File written: ${filePath} (${content.length} bytes)`,
    meta: { path: filePath, size: content.length }
  };
}

async function toolListDir(provider, agentId, dirPath) {
  const output = await provider.listDir(agentId, dirPath);
  return {
    success: true,
    result: output || '(empty directory)',
    meta: { path: dirPath }
  };
}

async function toolSearchFiles(provider, agentId, pattern, query) {
  const output = await provider.searchFiles(agentId, pattern, query);
  return {
    success: true,
    result: output || 'No matches found',
    meta: { query }
  };
}

// ─── RTK (Rust Token Killer) — automatic command rewriting ──────────────────
// RTK wraps common CLI commands to produce compressed output that saves 60-90%
// tokens when sent back to the LLM.  Only safe, read-only commands are rewritten.

const RTK_REWRITE_RULES = [
  // git commands (read-only)
  { pattern: /^git\s+status\b/, rewrite: (cmd) => cmd.replace(/^git\s+status/, 'rtk git status') },
  { pattern: /^git\s+diff\b/, rewrite: (cmd) => cmd.replace(/^git\s+diff/, 'rtk git diff') },
  { pattern: /^git\s+log\b/, rewrite: (cmd) => cmd.replace(/^git\s+log/, 'rtk git log') },
  // file listing
  { pattern: /^ls\b/, rewrite: (cmd) => cmd.replace(/^ls/, 'rtk ls') },
  { pattern: /^tree\b/, rewrite: (cmd) => cmd.replace(/^tree/, 'rtk ls') },
  // search
  { pattern: /^grep\s/, rewrite: (cmd) => cmd.replace(/^grep/, 'rtk grep') },
  { pattern: /^rg\s/, rewrite: (cmd) => cmd.replace(/^rg/, 'rtk grep') },
  // find
  { pattern: /^find\s/, rewrite: (cmd) => cmd.replace(/^find/, 'rtk find') },
  // test runners — failures-only output
  { pattern: /^(npm\s+test|npx\s+jest|npx\s+vitest|npx\s+mocha|pytest|cargo\s+test|go\s+test)\b/, rewrite: (cmd) => `rtk test ${cmd}` },
  // build commands
  { pattern: /^(npm\s+run\s+build|cargo\s+build|go\s+build|make)\b/, rewrite: (cmd) => `rtk ${cmd}` },
  // linting
  { pattern: /^(npx\s+eslint|eslint|golangci-lint)\b/, rewrite: (cmd) => `rtk lint ${cmd}` },
];

// Commands that should NEVER be rewritten (write operations, interactive, piped)
const RTK_SKIP_PATTERNS = [
  /\|/,              // piped commands — RTK can't wrap pipelines
  /&&/,              // chained commands
  /;/,               // sequential commands
  /^git\s+(add|commit|push|pull|merge|rebase|checkout|reset|stash|clone)\b/,
  /^(npm\s+install|npm\s+ci|yarn|pnpm|pip|apt|apk)\b/,
  /^(docker|kubectl|curl|wget)\b/,
  /^(cat|head|tail|echo|printf|mkdir|rm|cp|mv|touch|chmod|chown)\b/,
  /^rtk\b/,          // already rewritten
];

/**
 * Attempt to rewrite a command with RTK prefix for token-optimized output.
 * Returns the original command if RTK is not applicable.
 */
function rtkRewrite(command) {
  const trimmed = command.trim();
  // Skip if any exclusion pattern matches
  if (RTK_SKIP_PATTERNS.some(p => p.test(trimmed))) return trimmed;
  // Try rewrite rules in order
  for (const rule of RTK_REWRITE_RULES) {
    if (rule.pattern.test(trimmed)) {
      return rule.rewrite(trimmed);
    }
  }
  return trimmed;
}

async function toolRunCommand(provider, agentId, command) {
  // 5 minutes — long-running commands like npm install, builds, test suites
  const COMMAND_TIMEOUT = 5 * 60 * 1000;

  // Try RTK-rewritten command first, fall back to original on failure
  const rewritten = rtkRewrite(command);
  const useRtk = rewritten !== command.trim();
  const effectiveCommand = useRtk ? rewritten : command;

  if (useRtk) {
    console.log(`⚡ [RTK] Rewriting: "${command.slice(0, 80)}" → "${rewritten.slice(0, 80)}"`);
  }

  try {
    const { stdout, stderr } = await provider.exec(agentId, effectiveCommand, { timeout: COMMAND_TIMEOUT });
    const output = (stdout || stderr || '(no output)').slice(0, 10000);
    return {
      success: true,
      result: output,
      meta: { command, rtk: useRtk, truncated: (stdout || '').length > 10000 }
    };
  } catch (err) {
    // If RTK command failed, retry with original command
    if (useRtk) {
      console.log(`⚡ [RTK] Rewritten command failed, falling back to original: "${command.slice(0, 80)}"`);
      try {
        const { stdout, stderr } = await provider.exec(agentId, command, { timeout: COMMAND_TIMEOUT });
        const output = (stdout || stderr || '(no output)').slice(0, 10000);
        return {
          success: true,
          result: output,
          meta: { command, rtk: false, rtkFallback: true, truncated: (stdout || '').length > 10000 }
        };
      } catch (fallbackErr) {
        const output = (fallbackErr.stdout || '') + (fallbackErr.stderr || '');
        if (output.trim()) {
          return {
            success: true,
            result: output.slice(0, 10000),
            meta: { command, exitCode: fallbackErr.code || 1 }
          };
        }
        return { success: false, error: fallbackErr.message, result: '' };
      }
    }
    // Original command error handling (non-RTK path)
    const output = (err.stdout || '') + (err.stderr || '');
    if (output.trim()) {
      return {
        success: true,
        result: output.slice(0, 10000),
        meta: { command, exitCode: err.code || 1 }
      };
    }
    return {
      success: false,
      error: err.message,
      result: ''
    };
  }
}

async function toolAppendFile(provider, agentId, filePath, content) {
  await provider.appendFile(agentId, filePath, content);
  return {
    success: true,
    result: `Content appended to: ${filePath}`,
    meta: { path: filePath }
  };
}

// ─── Tool Call Parsing ──────────────────────────────────────────────────────

const KNOWN_TOOLS = ['read_file', 'write_file', 'list_dir', 'search_files', 'run_command', 'append_file', 'report_error', 'git_commit_push', 'update_task', 'list_my_tasks', 'check_status', 'mcp_call', 'get_action_status', 'build_stack', 'test_stack', 'deploy_stack', 'list_stacks', 'list_containers', 'list_computers', 'search_logs', 'get_log_metadata', 'task_execution_complete'];

// Convert a JSON-format tool call (from <tool_call> blocks) to our internal format
function jsonToToolCall(name, args) {
  if (!args || typeof args !== 'object') args = {};
  switch (name) {
    case 'read_file':
      return { tool: 'read_file', args: [args.path || args.file || args.filename || '', args.start_line || args.startLine || '', args.end_line || args.endLine || ''] };
    case 'list_dir':
      return { tool: 'list_dir', args: [args.path || args.directory || args.dir || '.'] };
    case 'run_command':
      return { tool: 'run_command', args: [args.command || args.cmd || ''] };
    case 'write_file':
      return { tool: 'write_file', args: [args.path || args.file || '', args.content || ''] };
    case 'append_file':
      return { tool: 'append_file', args: [args.path || args.file || '', args.content || ''] };
    case 'search_files':
      return { tool: 'search_files', args: [args.pattern || args.glob || '*', args.query || args.search || ''] };
    case 'report_error':
      return { tool: 'report_error', args: [args.description || args.message || args.error || ''] };
    case 'git_commit_push':
      return { tool: 'git_commit_push', args: [args.message || args.msg || '', args.taskId || args.task_id || ''] };
    case 'update_task':
      return { tool: 'update_task', args: [args.taskId || args.task_id || args.id || '', args.status || '', args.details || args.detail || args.message || ''] };
    case 'list_my_tasks':
      return { tool: 'list_my_tasks', args: [] };
    case 'check_status':
      return { tool: 'check_status', args: [] };
    case 'task_execution_complete':
      return { tool: 'task_execution_complete', args: [args.comment || args.message || args.summary || '', args.taskId || args.task_id || '', args.commits || ''] };
    case 'mcp_call':
      return { tool: 'mcp_call', args: [args.server || args.serverName || '', args.tool || args.toolName || '', JSON.stringify(args.arguments || args.args || {})] };
    // Convenience aliases for PulsarCD tools
    case 'get_action_status':
    case 'build_stack':
    case 'test_stack':
    case 'deploy_stack':
    case 'list_stacks':
    case 'list_containers':
    case 'list_computers':
    case 'search_logs':
    case 'get_log_metadata':
      return { tool: toolName, args: [JSON.stringify(args)] };

    default:
      return null;
  }
}

// ── Balanced parsing helpers ─────────────────────────────────────────────────

function _findBalancedClose(text, start) {
  let depth = 1;
  let inTripleQuote = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = start; i < text.length; i++) {
    if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      if (inTripleQuote) { inTripleQuote = false; i += 2; continue; }
      if (!inDoubleQuote && !inSingleQuote) { inTripleQuote = true; i += 2; continue; }
    }
    if (inTripleQuote) continue;
    if (text[i] === '\\' && (inDoubleQuote || inSingleQuote) && i + 1 < text.length) { i++; continue; }
    if (text[i] === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue; }
    if (text[i] === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue; }
    if (!inDoubleQuote && !inSingleQuote) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function _findTopLevelComma(text) {
  let inTripleQuote = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      if (inTripleQuote) { inTripleQuote = false; i += 2; continue; }
      if (!inDoubleQuote && !inSingleQuote) { inTripleQuote = true; i += 2; continue; }
    }
    if (inTripleQuote) continue;
    if (text[i] === '\\' && (inDoubleQuote || inSingleQuote)) { i++; continue; }
    if (text[i] === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue; }
    if (text[i] === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue; }
    if (!inDoubleQuote && !inSingleQuote) {
      if (text[i] === '(') parenDepth++;
      else if (text[i] === ')') parenDepth--;
      else if (text[i] === '{') braceDepth++;
      else if (text[i] === '}') braceDepth--;
      else if (text[i] === '[') bracketDepth++;
      else if (text[i] === ']') bracketDepth--;
      if (text[i] === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return i;
    }
  }
  return -1;
}

// Parse tool calls from agent response
export function parseToolCalls(response) {
  const toolCalls = [];

  // ── Phase 1: Parse <tool_call> JSON blocks ──────────────────────────
  const jsonCallPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let jm;
  while ((jm = jsonCallPattern.exec(response)) !== null) {
    const content = jm[1].trim();
    if (content.startsWith('@')) continue;
    try {
      const parsed = JSON.parse(content);
      const name = parsed.name || parsed.function?.name || parsed.tool;
      let args = parsed.arguments || parsed.function?.arguments || parsed.parameters || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      if (name && KNOWN_TOOLS.includes(name)) {
        const tc = jsonToToolCall(name, args);
        if (tc) {
          console.log(`🔧 [ToolParse] Matched <tool_call> JSON: ${name}(${JSON.stringify(args).slice(0, 80)})`);
          toolCalls.push(tc);
        }
      }
    } catch {
      // Not valid JSON
    }
  }

  // ── Phase 2: Parse @tool(args) with balanced parenthesis tracking ───
  const cleaned = response
    .replace(/<\|?\/?tool_call\|?>/gi, '')
    .replace(/<\|?\/?tool_use\|?>/gi, '')
    .replace(/\[TOOL_CALLS?\]/gi, '');

  const SINGLE_ARG_TOOLS = ['list_dir', 'run_command', 'report_error', 'list_my_tasks', 'list_projects', 'check_status', 'get_action_status', 'build_stack', 'test_stack', 'deploy_stack', 'list_stacks', 'list_containers', 'list_computers', 'search_logs', 'get_log_metadata'];
  const READ_FILE_TOOLS = ['read_file'];  // 1-arg or 3-arg (path, startLine, endLine)
  const MULTI_ARG_TOOLS = ['write_file', 'append_file', 'search_files', 'git_commit_push'];
  const THREE_ARG_TOOLS = ['mcp_call', 'update_task', 'task_execution_complete'];
  const ALL_TOOL_NAMES = [...SINGLE_ARG_TOOLS, ...READ_FILE_TOOLS, ...MULTI_ARG_TOOLS, ...THREE_ARG_TOOLS];
  const toolStartPattern = new RegExp(`@(${ALL_TOOL_NAMES.join('|')})\\s*\\(`, 'gi');
  let startMatch;

  while ((startMatch = toolStartPattern.exec(cleaned)) !== null) {
    const toolName = startMatch[1].toLowerCase();
    const argsStart = startMatch.index + startMatch[0].length;
    let closeIdx = _findBalancedClose(cleaned, argsStart);
    // Fallback: if balanced paren tracking fails (free-text args containing unbalanced parens
    // like "Build successful (action_id: abc, version: 1.0)"), find last ')' before next newline
    if (closeIdx === -1) {
      const lineEnd = cleaned.indexOf('\n', argsStart);
      const searchEnd = lineEnd === -1 ? cleaned.length : lineEnd;
      const lastParen = cleaned.lastIndexOf(')', searchEnd);
      if (lastParen >= argsStart) {
        closeIdx = lastParen;
      }
    }
    if (closeIdx === -1) continue;

    const argsString = cleaned.slice(argsStart, closeIdx);
    let args;

    if (SINGLE_ARG_TOOLS.includes(toolName)) {
      args = [sanitizeArg(argsString.trim())];
    } else if (READ_FILE_TOOLS.includes(toolName)) {
      // @read_file(path) or @read_file(path, startLine, endLine)
      const firstComma = _findTopLevelComma(argsString);
      if (firstComma !== -1) {
        const first = argsString.slice(0, firstComma).trim();
        const rest = argsString.slice(firstComma + 1).trim();
        const secondComma = _findTopLevelComma(rest);
        if (secondComma !== -1) {
          const second = rest.slice(0, secondComma).trim();
          const third = rest.slice(secondComma + 1).trim();
          args = [sanitizeArg(first), sanitizeArg(second), sanitizeArg(third)];
        } else {
          // @read_file(path, "10, 25") — legacy format
          args = [sanitizeArg(first), sanitizeArg(rest)];
        }
      } else {
        args = [sanitizeArg(argsString.trim())];
      }
    } else if (THREE_ARG_TOOLS.includes(toolName)) {
      // @mcp_call(server, tool, {json}) — split into 3 args
      const trimmedMcp = argsString.trim();
      const firstComma = _findTopLevelComma(argsString);
      if (firstComma !== -1) {
        const first = argsString.slice(0, firstComma).trim();
        const rest = argsString.slice(firstComma + 1).trim();
        const secondComma = _findTopLevelComma(rest);
        if (secondComma !== -1) {
          const second = rest.slice(0, secondComma).trim();
          const third = rest.slice(secondComma + 1).trim();
          args = [sanitizeArg(first), sanitizeArg(second), third];
        } else {
          args = [sanitizeArg(first), sanitizeArg(rest), '{}'];
        }
      } else if (trimmedMcp.startsWith('{')) {
        // Model passed a single JSON object instead of positional args — try to extract fields
        try {
          const parsed = JSON.parse(trimmedMcp);
          const srv = parsed.server || parsed.serverName || parsed.server_name || '';
          const tl = parsed.tool || parsed.toolName || parsed.tool_name || '';
          const tArgs = parsed.arguments || parsed.args || parsed.parameters || {};
          args = [srv, tl, JSON.stringify(tArgs)];
        } catch {
          args = ['', '', trimmedMcp];
        }
      } else {
        args = [sanitizeArg(trimmedMcp), '', '{}'];
      }
    } else {
      const commaIdx = _findTopLevelComma(argsString);
      if (commaIdx !== -1) {
        const first = argsString.slice(0, commaIdx).trim();
        let second = argsString.slice(commaIdx + 1).trim();
        if (second.startsWith('"""') && second.endsWith('"""')) {
          second = second.slice(3, -3);
        }
        args = [sanitizeArg(first), second];
      } else {
        args = [sanitizeArg(argsString.trim())];
      }
    }

    const isDuplicate = toolCalls.some(
      tc => tc.tool === toolName && tc.args[0] === args[0]
    );
    if (!isDuplicate) {
      toolCalls.push({ tool: toolName, args });
    }
    toolStartPattern.lastIndex = closeIdx + 1;
  }

  // Log summary
  if (toolCalls.length > 0) {
    console.log(`🔧 [ToolParse] Found ${toolCalls.length} tool call(s): ${toolCalls.map(t => `@${t.tool}(${(t.args[0] || '').slice(0, 60)}${(t.args[0] || '').length > 60 ? '...' : ''})`).join(', ')}`);
  } else {
    const rawToolMentions = (response.match(/@(read_file|write_file|list_dir|search_files|run_command|append_file)/gi) || []).length;
    const toolCallTags = (response.match(/<tool_call>/gi) || []).length;
    if (rawToolMentions > 0 || toolCallTags > 0) {
      console.warn(`⚠️  [ToolParse] Response contains ${rawToolMentions} @tool mention(s) and ${toolCallTags} <tool_call> tag(s) but no tool calls were parsed. Response preview:\n${response.slice(0, 500)}`);
    }
  }

  return toolCalls;
}
