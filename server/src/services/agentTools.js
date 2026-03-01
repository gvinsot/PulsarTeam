import { readdir, readFile, writeFile, access, stat, mkdir, realpath } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { constants } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PROJECTS_BASE = '/projects';

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

@run_command(command) - Run a shell command in the project directory (read-only safe commands only)
  Example: @run_command(npm test)
  Example: @run_command(grep -r "TODO" src/)

@append_file(path, content) - Append content to end of a file
  Example: @append_file(CHANGELOG.md, """
  ## v1.0.1
  - Fixed bug
  """)

@report_error(description) - Report an error or problem back to the leader/manager agent
  Use this when you encounter a blocking issue you cannot resolve yourself.
  The error will be escalated to the leader agent and displayed in the UI.
  Example: @report_error(Cannot compile the project: missing dependency 'express'. Please install it or update package.json.)

IMPORTANT:
- File paths are relative to the project root
- Always read files before modifying them
- Use multi-line content with triple quotes """content"""
- After making changes, verify by reading the file
- Each tool call MUST be on its own line, with an empty line before and after it
- Do NOT add decorative text like "Editing file..." or "Now I'll read..." before tool calls — just call the tool directly
- NEVER stop yourself with messages like "[Agent stopped after N turns]" or "I'll stop here" — you have NO turn limit. Keep working until the task is fully complete. Use as many tool calls as needed.
`;

// Sanitize a tool argument: only strip a matching pair of surrounding quotes.
// e.g. "echo hello" → echo hello   (model-added wrapper)
//      echo "a,b,c" → echo "a,b,c" (quotes are part of the content — kept)
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

// Normalize a file/dir path: strip leading project base if the LLM passed an absolute path
function normalizePath(pathArg, basePath) {
  let p = sanitizeArg(pathArg);
  // If the LLM passed an absolute path like /projects/Securator/src, make it relative
  if (p.startsWith(basePath)) {
    p = relative(basePath, p) || '.';
  } else if (p.startsWith(PROJECTS_BASE + '/')) {
    p = relative(basePath, join(PROJECTS_BASE, p.slice(PROJECTS_BASE.length + 1))) || '.';
  } else if (p.startsWith('/')) {
    // Any other absolute path — try to make it relative, fallback to stripping the leading /
    p = p.replace(/^\/+/, '');
  }
  return p || '.';
}

// Execute a tool command and return the result
export async function executeTool(toolName, args, projectPath) {
  // report_error doesn't need project access — handle it early
  if (toolName === 'report_error') {
    const description = args[0] || 'Unknown error';
    return { success: true, result: `Error reported: ${description}`, isErrorReport: true };
  }

  const basePath = join(PROJECTS_BASE, projectPath);
  
  // Verify project exists
  try {
    await access(basePath, constants.R_OK);
  } catch {
    return { success: false, error: `Project path not accessible: ${projectPath}` };
  }
  
  // Sanitize all arguments
  const cleanArgs = args.map(a => sanitizeArg(a));
  
  console.log(`🔧 [Tool] ${toolName}(${cleanArgs.map(a => a?.length > 100 ? a.slice(0, 100) + '...' : a).join(', ')}) | project=${projectPath} | basePath=${basePath}`);
  
  try {
    switch (toolName) {
      case 'read_file':
        return await readFileFromProject(basePath, normalizePath(cleanArgs[0], basePath));
      
      case 'write_file':
        return await writeFileToProject(basePath, normalizePath(cleanArgs[0], basePath), cleanArgs[1]);
      
      case 'list_dir':
        return await listDirectory(basePath, normalizePath(cleanArgs[0] || '.', basePath));
      
      case 'search_files':
        return await searchInFiles(basePath, cleanArgs[0], cleanArgs[1]);
      
      case 'run_command':
        return await runCommand(basePath, cleanArgs[0]);
      
      case 'append_file':
        return await appendToFile(basePath, normalizePath(cleanArgs[0], basePath), cleanArgs[1]);
      
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Security: resolve symlinks and verify the real path is within basePath
async function assertPathWithinBase(fullPath, basePath) {
  // First check the logical path (catches ../ traversal)
  if (!fullPath.startsWith(basePath)) {
    throw new Error('Path traversal not allowed');
  }
  // Then resolve symlinks and check the real path
  try {
    const realFullPath = await realpath(fullPath);
    const realBasePath = await realpath(basePath);
    if (!realFullPath.startsWith(realBasePath)) {
      throw new Error('Path traversal not allowed (symlink escape)');
    }
  } catch (err) {
    // File doesn't exist yet (write_file) — check parent directory instead
    if (err.code === 'ENOENT') {
      const parentDir = dirname(fullPath);
      try {
        const realParent = await realpath(parentDir);
        const realBase = await realpath(basePath);
        if (!realParent.startsWith(realBase)) {
          throw new Error('Path traversal not allowed (symlink escape)');
        }
      } catch (parentErr) {
        if (parentErr.code === 'ENOENT') return; // Parent will be created by mkdir
        throw parentErr;
      }
    } else if (err.message?.includes('traversal')) {
      throw err;
    }
    // Other errors (e.g., permission denied) — let the actual operation handle them
  }
}

async function readFileFromProject(basePath, filePath) {
  const fullPath = join(basePath, filePath);

  // Security: ensure path is within project (resolves symlinks)
  await assertPathWithinBase(fullPath, basePath);
  
  try {
    const content = await readFile(fullPath, 'utf-8');
    const stats = await stat(fullPath);
    return { 
      success: true, 
      result: content,
      meta: { path: filePath, size: stats.size, lines: content.split('\n').length }
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { success: false, error: `File not found: ${filePath}` };
    }
    throw err;
  }
}

async function writeFileToProject(basePath, filePath, content) {
  const fullPath = join(basePath, filePath);

  // Security: ensure path is within project (resolves symlinks)
  await assertPathWithinBase(fullPath, basePath);
  
  // Create directory if needed
  const dir = dirname(fullPath);
  await mkdir(dir, { recursive: true });
  
  await writeFile(fullPath, content, 'utf-8');
  const stats = await stat(fullPath);
  
  return { 
    success: true, 
    result: `File written: ${filePath} (${stats.size} bytes)`,
    meta: { path: filePath, size: stats.size }
  };
}

async function listDirectory(basePath, dirPath) {
  const fullPath = join(basePath, dirPath);

  // Security: ensure path is within project (resolves symlinks)
  await assertPathWithinBase(fullPath, basePath);
  
  const entries = await readdir(fullPath, { withFileTypes: true });
  const items = entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file'
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  
  const result = items.map(i => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}`).join('\n');
  return { 
    success: true, 
    result: result || '(empty directory)',
    meta: { path: dirPath, count: items.length }
  };
}

async function searchInFiles(basePath, pattern, query) {
  // Use grep for searching (available on Linux/Docker)
  // Security: use execFile with argument arrays to prevent shell injection
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  try {
    // Phase 1: find matching files
    const { stdout } = await execFileAsync(
      'grep', ['-r', '-l', '-i', '--include', pattern, '--', query, '.'],
      { cwd: basePath, timeout: 10000, maxBuffer: 1024 * 512 }
    ).catch(err => {
      if (err.code === 1) return { stdout: '' }; // grep returns 1 when no matches
      throw err;
    });

    const files = stdout.trim().split('\n').filter(Boolean).slice(0, 20);

    if (files.length === 0) {
      return { success: true, result: 'No matches found' };
    }

    // Phase 2: get context for each match (first 5 files)
    const results = [];
    for (const file of files.slice(0, 5)) {
      const cleanPath = file.replace('./', '');
      try {
        const { stdout: grepOut } = await execFileAsync(
          'grep', ['-n', '-i', '-m', '5', '--', query, file],
          { cwd: basePath, timeout: 5000 }
        );
        results.push(`📄 ${cleanPath}:\n${grepOut.trim()}`);
      } catch {
        results.push(`📄 ${cleanPath}`);
      }
    }

    if (files.length > 5) {
      results.push(`... and ${files.length - 5} more files`);
    }

    return {
      success: true,
      result: results.join('\n\n'),
      meta: { matches: files.length, query }
    };
  } catch (err) {
    if (err.code === 1) {
      return { success: true, result: 'No matches found' };
    }
    return { success: false, error: err.message };
  }
}

async function runCommand(basePath, command) {
  // Security: block dangerous commands — comprehensive blocklist
  const blockedPatterns = [
    // Destructive file operations
    /\brm\b/i,                    // rm in any form
    /\bmkfs\b/i,                  // Format filesystem
    /\bdd\b\s+if=/i,             // Disk dump
    /\bshred\b/i,                 // Secure delete
    /\btruncate\b/i,             // Truncate files
    // Dangerous network operations (piped to shell)
    /\b(curl|wget|fetch)\b.*\|/i, // Download piped to anything
    /\|.*\b(bash|sh|zsh|dash|exec)\b/i, // Pipe into shell
    // System modification
    /\bchmod\b.*777/i,           // World-writable permissions
    /\bchown\b.*root/i,          // Change ownership to root
    /\buseradd\b/i,              // Add users
    /\buserdel\b/i,              // Delete users
    /\bpasswd\b/i,               // Change passwords
    /\bsudo\b/i,                 // Privilege escalation
    /\bsu\b\s/i,                 // Switch user
    // Device/system writes
    />\s*\/dev\//i,              // Write to device files
    />\s*\/etc\//i,              // Write to system config
    />\s*\/proc\//i,             // Write to proc
    />\s*\/sys\//i,              // Write to sys
    // Prevent escape from working directory
    /\bkill\b/i,                 // Kill processes
    /\bkillall\b/i,              // Kill all processes
    /\bshutdown\b/i,             // Shutdown system
    /\breboot\b/i,               // Reboot system
    /\bsystemctl\b/i,            // Manage services
    /\bservice\b\s/i,            // Manage services (legacy)
    // Environment/shell manipulation
    /\bexport\b.*(?:PATH|LD_)/i, // Modify critical env vars
    /\beval\b/i,                 // Dynamic code execution
    /\bsource\b\s/i,            // Source arbitrary scripts
    /\b\.\s+\//,                 // Source with dot notation
    // Crypto mining / reverse shells
    /\bnc\b\s+-[elp]/i,         // netcat listeners
    /\bncat\b/i,                 // ncat
    /\/dev\/tcp\//i,             // Bash TCP device
    /\bmkfifo\b/i,              // Named pipe (often used in reverse shells)
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(command)) {
      return { success: false, error: `Command blocked for security reasons: matches pattern ${pattern}` };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: basePath,
      timeout: 30000,
      maxBuffer: 1024 * 1024, // 1MB
      shell: '/bin/bash',
      env: { ...process.env, PATH: process.env.PATH } // Don't leak extra env vars
    });

    const output = stdout || stderr || '(no output)';
    return {
      success: true,
      result: output.slice(0, 10000), // Limit output size
      meta: { command, truncated: output.length > 10000 }
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      result: err.stderr || err.stdout
    };
  }
}

async function appendToFile(basePath, filePath, content) {
  const fullPath = join(basePath, filePath);

  // Security: ensure path is within project (resolves symlinks)
  await assertPathWithinBase(fullPath, basePath);
  
  // Create directory if needed
  const dir = dirname(fullPath);
  await mkdir(dir, { recursive: true });
  
  // Read existing content if file exists
  let existing = '';
  try {
    existing = await readFile(fullPath, 'utf-8');
  } catch {
    // File doesn't exist, that's fine
  }
  
  const newContent = existing + (existing.endsWith('\n') ? '' : '\n') + content;
  await writeFile(fullPath, newContent, 'utf-8');
  
  return { 
    success: true, 
    result: `Content appended to: ${filePath}`,
    meta: { path: filePath }
  };
}

const KNOWN_TOOLS = ['read_file', 'write_file', 'list_dir', 'search_files', 'run_command', 'append_file', 'report_error'];

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
    default:
      return null;
  }
}

// ── Balanced parsing helpers ─────────────────────────────────────────────────

/**
 * Starting right after an opening '(', find the index of the matching ')'.
 * Tracks triple-quotes ("""), double quotes, single quotes, escape sequences,
 * and nested parentheses.  Returns -1 if unbalanced.
 */
function _findBalancedClose(text, start) {
  let depth = 1;
  let inTripleQuote = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = start; i < text.length; i++) {
    // Triple-quote toggle (check before single double-quote)
    if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      if (inTripleQuote) { inTripleQuote = false; i += 2; continue; }
      if (!inDoubleQuote && !inSingleQuote) { inTripleQuote = true; i += 2; continue; }
    }
    if (inTripleQuote) continue;

    // Escape sequences inside quotes
    if (text[i] === '\\' && (inDoubleQuote || inSingleQuote) && i + 1 < text.length) {
      i++; continue;
    }

    // Double-quote toggle
    if (text[i] === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue; }
    // Single-quote toggle
    if (text[i] === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue; }

    // Parentheses tracking — only outside quotes
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

/**
 * Find the index of the first comma that sits at the top level —
 * i.e. not inside quotes or nested parentheses.
 */
function _findTopLevelComma(text) {
  let inTripleQuote = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let depth = 0;

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
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (text[i] === ',' && depth === 0) return i;
    }
  }
  return -1;
}

// Parse tool calls from agent response
export function parseToolCalls(response) {
  const toolCalls = [];

  // ── Phase 1: Parse <tool_call> JSON blocks ──────────────────────────
  // Many Ollama models (Qwen, DeepSeek, Mistral, etc.) emit tool calls as JSON
  // inside <tool_call>...</tool_call> tags.
  const jsonCallPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let jm;
  while ((jm = jsonCallPattern.exec(response)) !== null) {
    const content = jm[1].trim();
    // Skip if content looks like our @tool() format (handled in phase 2)
    if (content.startsWith('@')) continue;
    try {
      const parsed = JSON.parse(content);
      const name = parsed.name || parsed.function?.name || parsed.tool;
      let args = parsed.arguments || parsed.function?.arguments || parsed.parameters || {};
      // Some models stringify the arguments
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
      // Not valid JSON — will be handled in phase 2
    }
  }

  // ── Phase 2: Parse @tool(args) with balanced parenthesis tracking ───
  // Handles nested quotes, parentheses, and escaped characters correctly.
  const cleaned = response
    .replace(/<\|?\/?tool_call\|?>/gi, '')    // <tool_call>, </tool_call>, <|tool_call|>, etc.
    .replace(/<\|?\/?tool_use\|?>/gi, '')     // <tool_use> variants
    .replace(/\[TOOL_CALLS?\]/gi, '');        // [TOOL_CALL] / [TOOL_CALLS] markers

  const SINGLE_ARG_TOOLS = ['read_file', 'list_dir', 'run_command', 'report_error'];
  const MULTI_ARG_TOOLS = ['write_file', 'append_file', 'search_files'];
  const ALL_TOOL_NAMES = [...SINGLE_ARG_TOOLS, ...MULTI_ARG_TOOLS];
  const toolStartPattern = new RegExp(`@(${ALL_TOOL_NAMES.join('|')})\\s*\\(`, 'gi');
  let startMatch;

  while ((startMatch = toolStartPattern.exec(cleaned)) !== null) {
    const toolName = startMatch[1].toLowerCase();
    const argsStart = startMatch.index + startMatch[0].length;

    // Find the matching closing ')' using balanced tracking
    const closeIdx = _findBalancedClose(cleaned, argsStart);
    if (closeIdx === -1) continue; // unbalanced — skip

    const argsString = cleaned.slice(argsStart, closeIdx);
    let args;

    if (SINGLE_ARG_TOOLS.includes(toolName)) {
      // Single argument: the entire content between parens
      args = [sanitizeArg(argsString.trim())];
    } else {
      // Multi-arg (write_file, append_file, search_files): split at first top-level comma
      const commaIdx = _findTopLevelComma(argsString);
      if (commaIdx !== -1) {
        const first = argsString.slice(0, commaIdx).trim();
        let second = argsString.slice(commaIdx + 1).trim();
        // Strip triple-quote delimiters for write_file/append_file content
        if (second.startsWith('"""') && second.endsWith('"""')) {
          second = second.slice(3, -3);
        }
        args = [sanitizeArg(first), second];
      } else {
        args = [sanitizeArg(argsString.trim())];
      }
    }

    // Dedup: check if this tool call was already parsed in phase 1
    const isDuplicate = toolCalls.some(
      tc => tc.tool === toolName && tc.args[0] === args[0]
    );
    if (!isDuplicate) {
      toolCalls.push({ tool: toolName, args });
    }

    // Advance regex past this match to avoid partial re-matches
    toolStartPattern.lastIndex = closeIdx + 1;
  }

  // Log summary
  if (toolCalls.length > 0) {
    console.log(`🔧 [ToolParse] Found ${toolCalls.length} tool call(s): ${toolCalls.map(t => `@${t.tool}(${(t.args[0] || '').slice(0, 60)}${(t.args[0] || '').length > 60 ? '...' : ''})`).join(', ')}`);
  } else {
    // Check if there are tool-like patterns that we failed to parse
    const rawToolMentions = (response.match(/@(read_file|write_file|list_dir|search_files|run_command|append_file)/gi) || []).length;
    const toolCallTags = (response.match(/<tool_call>/gi) || []).length;
    if (rawToolMentions > 0 || toolCallTags > 0) {
      console.warn(`⚠️  [ToolParse] Response contains ${rawToolMentions} @tool mention(s) and ${toolCallTags} <tool_call> tag(s) but no tool calls were parsed. Response preview:\n${response.slice(0, 500)}`);
    }
  }

  return toolCalls;
}
