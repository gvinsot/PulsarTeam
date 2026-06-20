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

@update_task(taskId, status, comment, commits) - Move a task between columns AND/OR mark it finished
  The single task tool. Change a task's status, and/or record completion by adding a comment summary (plus optional commits). status, comment and commits are each optional, but provide at least one.
  - status: a workflow column ID that exists on the task's board (e.g., backlog, pending, code, build, test, deploy, done). Any other value is rejected with the list of valid columns.
  - comment: when provided, it is appended to the task description AND marks the task finished — this is how you complete a task. There is no separate completion tool.
  - commits: optional comma-separated commit hashes with messages, format: hash:message, hash:message. Must already be pushed; pushed commits are auto-linked even if omitted.
  TO FINISH A TASK: move it to its next column WITH a summary, e.g. @update_task(abc-123, done, Implemented user auth with JWT; all tests passing). Commit and push first.
  Example (move only): @update_task(abc-123, build)
  Example (move only): @update_task(abc-123, done)
  Example (move + context): @update_task(abc-123, pending, Build failed: missing dependency libfoo)
  Example (finish + commits): @update_task(abc-123, done, Implemented user auth, a1b2c3d:feat add JWT auth)

@move_task_to_board(taskId, boardId) - Move a task to a different board
  Use this to transfer a task from its current board to another board.
  The task's status will be preserved if the target board has a matching column, otherwise it will be set to the first column.
  Example: @move_task_to_board(abc-123, board-uuid-456)

@delete_task(taskId) - Delete a task
  Soft-deletes a task. The task can be restored later if needed.
  Example: @delete_task(abc-123)

@list_boards() - List all available boards
  Returns the list of boards with their IDs, names, and workflow columns.
  Use this to discover board IDs for moving tasks between boards.
  Example: @list_boards()

@list_tasks(status, boardId) - List tasks filtered by status and/or board
  Both parameters are optional. Returns tasks matching the given filters.
  - status: Filter by column/status (e.g., backlog, done, in_progress)
  - boardId: Filter by board ID
  Example: @list_tasks(backlog)
  Example: @list_tasks(, board-uuid-456)
  Example: @list_tasks(done, board-uuid-456)

@check_status() - Check your own detailed status including project assignment, task counts, and metrics
  Use this to see which project you are working on and your current state.
  Example: @check_status()

@report_error(description) - Report an error or problem back to the leader/manager agent
  Use this when you encounter a blocking issue you cannot resolve yourself.
  Example: @report_error(Cannot compile: missing dependency 'express'.)

IMPORTANT:
- File paths are relative to the project root
- Always read files before modifying them
- Use multi-line content with triple quotes """content"""
- After making changes, verify by reading the file
- Each tool call MUST be on its own line, with an empty line before and after it
- Do NOT add decorative text like "Editing file..." or "Now I'll read..." before tool calls — just call the tool directly
- NEVER stop yourself with messages like "[Agent stopped after N turns]" or "I'll stop here" — you have NO turn limit. Keep working until the task is fully complete.
- Your workspace is EPHEMERAL. Always commit and push after completing changes to preserve your work.
- WORKFLOW — You MUST follow these steps IN ORDER when executing a task:
  1. READ: Explore the codebase with @read_file, @list_dir, @search_files to understand the current state
  2. WRITE: Make all necessary changes using @write_file or @append_file
  3. VERIFY: Read back modified files to confirm correctness
  4. COMMIT: Use @run_command with git commands to commit and push your work
  5. COMPLETE: @update_task(taskId, <final column>, summary) — move the task to its final column with a summary; this signals completion
  CRITICAL: You MUST call @write_file BEFORE committing. A commit without prior @write_file calls means NOTHING was changed.
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

// Normalize path: strip absolute prefixes and prevent traversal attacks
function normalizePath(pathArg) {
  let p = sanitizeArg(pathArg);
  // Decode any URL-encoded characters that could bypass path checks
  try { p = decodeURIComponent(p); } catch {}
  // Strip /workspace/<project>/ or /projects/<project>/ prefixes
  p = p.replace(/^\/workspace\/[^/]+\//, '');
  p = p.replace(/^\/projects\/[^/]+\//, '');
  // Strip any remaining leading slashes
  if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  // Remove ALL path traversal segments (.. in any form)
  p = p.split('/').filter(seg => seg !== '..' && seg !== '.').join('/');
  // Block null bytes (classic injection vector)
  p = p.replace(/\0/g, '');
  // Validate the result stays within project — no absolute paths after normalization
  if (p.startsWith('/') || p.includes('/../') || p.endsWith('/..')) {
    console.warn(`🛡️ [Security] Path traversal blocked: ${pathArg}`);
    return '__blocked_path__';
  }
  return p || '.';
}

// Blocked shell command patterns — prevent agents from escaping sandbox or exfiltrating data
const BLOCKED_COMMAND_PATTERNS = [
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/, /\bhalt\b/,
  /\bmkfs\b/, /\bfdisk\b/,
  /\biptables\b/, /\bnft\b/, /\bufw\b/,
  /\buseradd\b/, /\buserdel\b/, /\busermod\b/, /\bpasswd\b/,
  /\bcrontab\b/,
  /\bsystemctl\b/, /\bservice\s/,
  /\/proc\/self\/environ/,
  /\/proc\/\d+\/environ/,
  /\/dev\/tcp\//,
  /\/dev\/udp\//,
  /\bbash\s+-i\s+>&/,
  /\bnc\s+-l/, /\bncat\s+-l/, /\bsocat\s/,
  /\bnmap\s/, /\bmasscan\s/,
  /\btcpdump\b/, /\btshark\b/,
  /\bmkfifo\s/, /\bmknod\s/,
];

function validateCommand(command: string): string | null {
  if (!command?.trim()) return 'Empty command';
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      console.warn(`🛡️ [Security] Blocked command from agent: ${command.slice(0, 100)}`);
      return 'Command blocked for security reasons';
    }
  }
  return null;
}

/**
 * Execute a tool command using the execution provider (sandbox or coder-service).
 * @param {string} toolName
 * @param {string[]} args
 * @param {string} projectPath - project name
 * @param {import('./execution/executionProvider.js').ExecutionProvider} provider
 * @param {string} agentId
 */
export async function executeTool(toolName, args, projectPath, provider, agentId) {
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

  // Verify execution environment matches the expected project
  const envProject = provider.getProject(agentId);
  if (projectPath && envProject && envProject !== projectPath) {
    console.error(`🚫 [Tool] Project mismatch! Agent ${agentId.slice(0, 8)} expects "${projectPath}" but execution env has "${envProject}". Blocking tool to prevent wrong-project execution.`);
    return { success: false, error: `Project mismatch: expected "${projectPath}" but execution environment is on "${envProject}". The task cannot safely execute. Please report this error.` };
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

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Tool implementations (all via execution provider) ──────────────────

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

function getFileExtension(path) {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

async function toolReadFile(provider, agentId, filePath, startLineArg, endLineArg) {
  if (filePath === '__blocked_path__') {
    return { success: false, error: 'Path blocked: detected path traversal attempt' };
  }
  try {
    const ext = getFileExtension(filePath);
    if (IMAGE_EXTENSIONS.has(ext) && ext !== '.svg') {
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
      const mediaType = mimeMap[ext] || 'image/png';
      try {
        const result = await provider.exec(agentId, `base64 -w0 "${filePath.replace(/"/g, '\\"')}"`, { timeout: 30000 });
        const b64 = ((result.stdout || '') + (result.stderr || '')).trim();
        if (b64 && b64.length < 10 * 1024 * 1024) {
          return {
            success: true,
            result: `[Image file: ${filePath} (${mediaType}, ${Math.round(b64.length * 3 / 4 / 1024)}KB)]`,
            images: [{ data: b64, mediaType }],
            meta: { path: filePath, isImage: true }
          };
        }
      } catch {}
      return { success: true, result: `[Binary image file: ${filePath} — too large to display or base64 failed]`, meta: { path: filePath, isImage: true } };
    }

    const content = await provider.readFile(agentId, filePath);
    const allLines = content.split('\n');

    // Parse optional line range: (path, startLine[, endLine])
    const startLine = parseInt(startLineArg, 10);
    const endLine = parseInt(endLineArg, 10);

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
  if (filePath === '__blocked_path__') {
    return { success: false, error: 'Path blocked: detected path traversal attempt' };
  }
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
  // Security: validate command before execution
  const blockReason = validateCommand(command);
  if (blockReason) {
    return { success: false, error: `🛡️ ${blockReason}` };
  }

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
    const output = ([stdout, stderr].filter(Boolean).join('\n') || '(no output)').slice(0, 10000);
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
        const output = ([stdout, stderr].filter(Boolean).join('\n') || '(no output)').slice(0, 10000);
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
  if (filePath === '__blocked_path__') {
    return { success: false, error: 'Path blocked: detected path traversal attempt' };
  }
  await provider.appendFile(agentId, filePath, content);
  return {
    success: true,
    result: `Content appended to: ${filePath}`,
    meta: { path: filePath }
  };
}

// ─── Tool Call Parsing ──────────────────────────────────────────────────────

// ── Tool registry ────────────────────────────────────────────────────────────
// Single source of truth for tool parsing metadata, replacing the five parallel
// lists (KNOWN_TOOLS + SINGLE_ARG/READ_FILE/MULTI_ARG/THREE_ARG + jsonToToolCall
// switch) that previously had to be kept in sync by hand.
//
//  - `arity` drives the @-syntax (phase 2) argument splitting:
//      'single' = whole-parens-as-one-arg
//      'read'   = read_file's 1/2/3-arg path
//      'multi'  = default 2-arg path (with triple-quote stripping)
//      'three'  = mcp_call / update_task 3-arg path (3rd arg keeps commas)
//  - `fromJson` maps a parsed <tool_call> JSON object to positional args.
//    KNOWN_TOOLS (the phase-1 gate) is derived from entries that have it, so a
//    tool with no `fromJson` (e.g. list_projects) is still @-syntax parseable
//    but intentionally NOT accepted in JSON form — preserving prior behavior.
//    The `||` alias chains are copied verbatim (do NOT switch to ?? — a numeric
//    0 start_line must still coerce to '').
type ToolArity = 'single' | 'read' | 'multi' | 'three';
interface ToolSpec { arity: ToolArity; fromJson?: (args: any) => any[] }

const TOOL_SPECS: Record<string, ToolSpec> = {
  read_file:               { arity: 'read',   fromJson: a => [a.path || a.file || a.filename || '', a.start_line || a.startLine || '', a.end_line || a.endLine || ''] },
  list_dir:                { arity: 'single', fromJson: a => [a.path || a.directory || a.dir || '.'] },
  run_command:             { arity: 'single', fromJson: a => [a.command || a.cmd || ''] },
  write_file:              { arity: 'multi',  fromJson: a => [a.path || a.file || '', a.content || ''] },
  append_file:             { arity: 'multi',  fromJson: a => [a.path || a.file || '', a.content || ''] },
  search_files:            { arity: 'multi',  fromJson: a => [a.pattern || a.glob || '*', a.query || a.search || ''] },
  report_error:            { arity: 'single', fromJson: a => [a.description || a.message || a.error || ''] },
  update_task:             { arity: 'three',  fromJson: a => [a.taskId || a.task_id || a.id || '', a.status || '', a.comment || a.details || a.detail || a.message || '', a.commits || ''] },
  move_task_to_board:      { arity: 'multi',  fromJson: a => [a.taskId || a.task_id || a.id || '', a.boardId || a.board_id || ''] },
  delete_task:             { arity: 'single', fromJson: a => [a.taskId || a.task_id || a.id || ''] },
  list_boards:             { arity: 'single', fromJson: () => [] },
  list_tasks:              { arity: 'multi',  fromJson: a => [a.status || '', a.boardId || a.board_id || ''] },
  list_my_tasks:           { arity: 'single', fromJson: () => [] },
  list_projects:           { arity: 'single' },
  check_status:            { arity: 'single', fromJson: () => [] },
  mcp_call:                { arity: 'three',  fromJson: a => [a.server || a.serverName || '', a.tool || a.toolName || '', JSON.stringify(a.arguments || a.args || {})] },
  // Convenience aliases for PulsarCD tools — single @-arg, whole JSON in JSON form.
  get_action_status:       { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  build_stack:             { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  test_stack:              { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  deploy_stack:            { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  list_stacks:             { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  list_containers:         { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  list_computers:          { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  search_logs:             { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  get_log_metadata:        { arity: 'single', fromJson: a => [JSON.stringify(a)] },
  // Agent skills management tools.
  search_skill:            { arity: 'single', fromJson: a => [a.query || a.search || a.keyword || ''] },
  create_skill:            { arity: 'multi',  fromJson: a => [a.name || '', JSON.stringify({ description: a.description || '', category: a.category || 'general', instructions: a.instructions || '', mcpServerIds: a.mcpServerIds || [] })] },
  update_skill:            { arity: 'multi',  fromJson: a => [a.id || '', JSON.stringify({ name: a.name, description: a.description, category: a.category, instructions: a.instructions, mcpServerIds: a.mcpServerIds })] },
  delete_skill:            { arity: 'single', fromJson: a => [a.id || ''] },
};

// Phase-1 (<tool_call> JSON) gate: only tools that define a JSON mapping.
const KNOWN_TOOLS = Object.keys(TOOL_SPECS).filter(name => TOOL_SPECS[name].fromJson);

// Convert a JSON-format tool call (from <tool_call> blocks) to our internal format
function jsonToToolCall(name, args) {
  if (!args || typeof args !== 'object') args = {};
  const spec = TOOL_SPECS[name];
  return spec?.fromJson ? { tool: name, args: spec.fromJson(args) } : null;
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

  // Phase-2 @tool names + per-tool arity both come from TOOL_SPECS.
  const ALL_TOOL_NAMES = Object.keys(TOOL_SPECS);
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
    const arity: ToolArity = TOOL_SPECS[toolName]?.arity || 'multi';
    let args;

    if (arity === 'single') {
      args = [sanitizeArg(argsString.trim())];
    } else if (arity === 'read') {
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
          // @read_file(path, startLine) — read from startLine to end of file
          args = [sanitizeArg(first), sanitizeArg(rest)];
        }
      } else {
        args = [sanitizeArg(argsString.trim())];
      }
    } else if (arity === 'three') {
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
