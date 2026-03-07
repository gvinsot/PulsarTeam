// Tool definitions that will be injected into agent prompts
export const TOOL_DEFINITIONS = `
--- AVAILABLE TOOLS ---
You can interact with project files using these commands. Use the exact format shown.

@read_file(path) - Read contents of a file
  Example: @read_file(src/index.js)

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

@update_todo(todoId, status) - Update the status of one of your tasks
  Valid statuses: in_progress, done, error
  Use this to mark a task as in_progress when you start working on it, or done when finished.
  Example: @update_todo(abc-123, in_progress)
  Example: @update_todo(abc-123, done)

@check_status() - Check your own detailed status including project assignment, task counts, and metrics
  Use this to see which project you are working on and your current state.
  Example: @check_status()

@report_error(description) - Report an error or problem back to the leader/manager agent
  Use this when you encounter a blocking issue you cannot resolve yourself.
  Example: @report_error(Cannot compile: missing dependency 'express'.)

@git_commit_push(message) - Stage all changes, commit with the given message, and push to remote
  Example: @git_commit_push(feat: add user authentication)

IMPORTANT:
- File paths are relative to the project root
- Always read files before modifying them
- Use multi-line content with triple quotes """content"""
- After making changes, verify by reading the file
- Each tool call MUST be on its own line, with an empty line before and after it
- Do NOT add decorative text like "Editing file..." or "Now I'll read..." before tool calls — just call the tool directly
- NEVER stop yourself with messages like "[Agent stopped after N turns]" or "I'll stop here" — you have NO turn limit. Keep working until the task is fully complete.
- Your workspace is EPHEMERAL. Always @git_commit_push(message) after completing changes to preserve your work.
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
 * Execute a tool command using the sandbox container.
 * @param {string} toolName
 * @param {string[]} args
 * @param {string} projectPath - project name
 * @param {import('./sandboxManager.js').SandboxManager} sandboxMgr
 * @param {string} agentId
 */
export async function executeTool(toolName, args, projectPath, sandboxMgr, agentId) {
  // report_error and update_todo don't need sandbox access
  if (toolName === 'report_error') {
    const description = args[0] || 'Unknown error';
    return { success: true, result: `Error reported: ${description}`, isErrorReport: true };
  }
  if (toolName === 'update_todo') {
    return { success: true, result: `Todo update: ${args[0]} → ${args[1]}`, isTodoUpdate: true };
  }
  if (toolName === 'list_my_tasks') {
    return { success: true, result: 'Tasks listed', isTaskList: true };
  }
  if (toolName === 'check_status') {
    return { success: true, result: 'Status checked', isStatusCheck: true };
  }

  if (!sandboxMgr || !agentId) {
    return { success: false, error: 'Sandbox not available' };
  }

  if (!sandboxMgr.hasSandbox(agentId)) {
    return { success: false, error: 'No sandbox running. The sandbox will be initialized on the next tool call.' };
  }

  const cleanArgs = args.map(a => sanitizeArg(a));

  console.log(`🔧 [Tool] ${toolName}(${cleanArgs.map(a => a?.length > 100 ? a.slice(0, 100) + '...' : a).join(', ')}) | agent=${agentId.slice(0, 8)} project=${projectPath}`);

  try {
    switch (toolName) {
      case 'read_file':
        return await toolReadFile(sandboxMgr, agentId, normalizePath(cleanArgs[0]));

      case 'write_file':
        return await toolWriteFile(sandboxMgr, agentId, normalizePath(cleanArgs[0]), cleanArgs[1]);

      case 'list_dir':
        return await toolListDir(sandboxMgr, agentId, normalizePath(cleanArgs[0] || '.'));

      case 'search_files':
        return await toolSearchFiles(sandboxMgr, agentId, cleanArgs[0], cleanArgs[1]);

      case 'run_command':
        return await toolRunCommand(sandboxMgr, agentId, cleanArgs[0]);

      case 'append_file':
        return await toolAppendFile(sandboxMgr, agentId, normalizePath(cleanArgs[0]), cleanArgs[1]);

      case 'git_commit_push':
        return await toolGitCommitPush(sandboxMgr, agentId, cleanArgs[0]);

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Tool implementations (all via sandbox) ────────────────────────────────

async function toolReadFile(sandboxMgr, agentId, filePath) {
  try {
    const content = await sandboxMgr.readFile(agentId, filePath);
    const lines = content.split('\n').length;
    return {
      success: true,
      result: content,
      meta: { path: filePath, size: content.length, lines }
    };
  } catch (err) {
    if (err.message.includes('No such file')) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    throw err;
  }
}

async function toolWriteFile(sandboxMgr, agentId, filePath, content) {
  await sandboxMgr.writeFile(agentId, filePath, content);
  return {
    success: true,
    result: `File written: ${filePath} (${content.length} bytes)`,
    meta: { path: filePath, size: content.length }
  };
}

async function toolListDir(sandboxMgr, agentId, dirPath) {
  const output = await sandboxMgr.listDir(agentId, dirPath);
  return {
    success: true,
    result: output || '(empty directory)',
    meta: { path: dirPath }
  };
}

async function toolSearchFiles(sandboxMgr, agentId, pattern, query) {
  const output = await sandboxMgr.searchFiles(agentId, pattern, query);
  return {
    success: true,
    result: output || 'No matches found',
    meta: { query }
  };
}

async function toolRunCommand(sandboxMgr, agentId, command) {
  // 5 minutes — long-running commands like npm install, builds, test suites
  const COMMAND_TIMEOUT = 5 * 60 * 1000;
  try {
    const { stdout, stderr } = await sandboxMgr.exec(agentId, command, { timeout: COMMAND_TIMEOUT });
    const output = (stdout || stderr || '(no output)').slice(0, 10000);
    return {
      success: true,
      result: output,
      meta: { command, truncated: (stdout || '').length > 10000 }
    };
  } catch (err) {
    // When the command ran but exited non-zero (e.g. git commit with nothing
    // to commit, grep with no matches, diff with differences), execAsync
    // rejects even though the command executed fine.  If we have stdout/stderr,
    // the command DID run — return the output as success and let the agent
    // interpret the result.  Only report failure for infrastructure errors
    // (Docker unavailable, timeout, etc.) where there's no useful output.
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

async function toolAppendFile(sandboxMgr, agentId, filePath, content) {
  await sandboxMgr.appendFile(agentId, filePath, content);
  return {
    success: true,
    result: `Content appended to: ${filePath}`,
    meta: { path: filePath }
  };
}

/**
 * Sanitize a commit message for safe use in a shell command.
 * Strips shell metacharacters that could allow command injection:
 * backticks, $, newlines, null bytes, and other dangerous chars.
 * The result is safe to embed in single quotes after also escaping
 * single quotes themselves.
 */
function sanitizeCommitMessage(msg) {
  if (!msg || typeof msg !== 'string') return 'update';
  return msg
    .replace(/[\x00]/g, '')          // null bytes
    .replace(/[`$\\!]/g, '')         // shell expansion chars: backtick, $, \, !
    .replace(/\r?\n/g, ' ')          // newlines -> spaces
    .replace(/'/g, "'\\''")          // escape single quotes for single-quoted string
    .slice(0, 500);                  // limit length
}

async function toolGitCommitPush(sandboxMgr, agentId, message) {
  const safeMsg = sanitizeCommitMessage(message);
  try {
    const { stdout, stderr } = await sandboxMgr.exec(
      agentId,
      `git add -A && git commit -m '${safeMsg}' && git push`,
      { timeout: 60000 }
    );
    return { success: true, result: (stdout + '\n' + stderr).trim().slice(0, 10000) };
  } catch (err) {
    return { success: false, error: err.message, result: (err.stderr || err.stdout || '').slice(0, 5000) };
  }
}

// ─── Tool Call Parsing ──────────────────────────────────────────────────────

const KNOWN_TOOLS = ['read_file', 'write_file', 'list_dir', 'search_files', 'run_command', 'append_file', 'report_error', 'git_commit_push', 'update_todo', 'list_my_tasks', 'check_status', 'mcp_call'];

// Convert a JSON-format tool call (from <tool_call> blocks) to our internal format
function jsonToToolCall(name, args) {
  if (!args || typeof args !== 'object') args = {};
  switch (name) {
    case 'read_file':
      return { tool: 'read_file', args: [args.path || args.file || args.filename || ''] };
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
      return { tool: 'git_commit_push', args: [args.message || args.msg || ''] };
    case 'update_todo':
      return { tool: 'update_todo', args: [args.todoId || args.todo_id || args.id || '', args.status || ''] };
    case 'list_my_tasks':
      return { tool: 'list_my_tasks', args: [] };
    case 'check_status':
      return { tool: 'check_status', args: [] };
    case 'mcp_call':
      return { tool: 'mcp_call', args: [args.server || args.serverName || '', args.tool || args.toolName || '', JSON.stringify(args.arguments || args.args || {})] };
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

  const SINGLE_ARG_TOOLS = ['read_file', 'list_dir', 'run_command', 'report_error', 'git_commit_push', 'list_my_tasks', 'check_status'];
  const MULTI_ARG_TOOLS = ['write_file', 'append_file', 'search_files', 'update_todo'];
  const THREE_ARG_TOOLS = ['mcp_call'];
  const ALL_TOOL_NAMES = [...SINGLE_ARG_TOOLS, ...MULTI_ARG_TOOLS, ...THREE_ARG_TOOLS];
  const toolStartPattern = new RegExp(`@(${ALL_TOOL_NAMES.join('|')})\\s*\\(`, 'gi');
  let startMatch;

  while ((startMatch = toolStartPattern.exec(cleaned)) !== null) {
    const toolName = startMatch[1].toLowerCase();
    const argsStart = startMatch.index + startMatch[0].length;
    const closeIdx = _findBalancedClose(cleaned, argsStart);
    if (closeIdx === -1) continue;

    const argsString = cleaned.slice(argsStart, closeIdx);
    let args;

    if (SINGLE_ARG_TOOLS.includes(toolName)) {
      args = [sanitizeArg(argsString.trim())];
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
