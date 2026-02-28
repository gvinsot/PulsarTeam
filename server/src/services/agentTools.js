import { readdir, readFile, writeFile, access, stat, mkdir } from 'fs/promises';
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
`;

// Sanitize a tool argument: remove surrounding quotes and normalize paths
function sanitizeArg(arg) {
  if (!arg) return arg;
  // Remove surrounding double or single quotes
  arg = arg.replace(/^["']+|["']+$/g, '').trim();
  return arg;
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

async function readFileFromProject(basePath, filePath) {
  const fullPath = join(basePath, filePath);
  
  // Security: ensure path is within project
  if (!fullPath.startsWith(basePath)) {
    return { success: false, error: 'Path traversal not allowed' };
  }
  
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
  
  // Security: ensure path is within project
  if (!fullPath.startsWith(basePath)) {
    return { success: false, error: 'Path traversal not allowed' };
  }
  
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
  
  if (!fullPath.startsWith(basePath)) {
    return { success: false, error: 'Path traversal not allowed' };
  }
  
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
  try {
    const { stdout } = await execAsync(
      `grep -r -l -i "${query.replace(/"/g, '\\"')}" --include="${pattern}" . 2>/dev/null | head -20`,
      { cwd: basePath, timeout: 10000 }
    );
    
    const files = stdout.trim().split('\n').filter(Boolean);
    
    if (files.length === 0) {
      return { success: true, result: 'No matches found' };
    }
    
    // Get context for each match (first 3 files)
    const results = [];
    for (const file of files.slice(0, 5)) {
      const cleanPath = file.replace('./', '');
      try {
        const { stdout: grepOut } = await execAsync(
          `grep -n -i "${query.replace(/"/g, '\\"')}" "${file}" | head -5`,
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
      // grep returns 1 when no matches
      return { success: true, result: 'No matches found' };
    }
    return { success: false, error: err.message };
  }
}

async function runCommand(basePath, command) {
  // Security: block dangerous commands
  const blockedPatterns = [
    /rm\s+-rf/i,
    /rm\s+.*\//i,
    /curl.*\|.*sh/i,
    /wget.*\|.*sh/i,
    />\s*\/dev/i,
    /dd\s+if=/i,
    /mkfs/i,
    /format/i,
  ];
  
  for (const pattern of blockedPatterns) {
    if (pattern.test(command)) {
      return { success: false, error: 'Command blocked for security reasons' };
    }
  }
  
  try {
    const { stdout, stderr } = await execAsync(command, { 
      cwd: basePath, 
      timeout: 30000,
      maxBuffer: 1024 * 1024, // 1MB
      shell: '/bin/bash'
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
  
  if (!fullPath.startsWith(basePath)) {
    return { success: false, error: 'Path traversal not allowed' };
  }
  
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

  // ── Phase 2: Parse @tool(args) custom format ────────────────────────
  // Strip <tool_call> / </tool_call> wrappers (some models use them as prefixes
  // around our @tool() syntax without JSON).
  const cleaned = response
    .replace(/<\|?\/?tool_call\|?>/gi, '')    // <tool_call>, </tool_call>, <|tool_call|>, etc.
    .replace(/<\|?\/?tool_use\|?>/gi, '')     // <tool_use> variants
    .replace(/\[TOOL_CALLS?\]/gi, '');        // [TOOL_CALL] / [TOOL_CALLS] markers

  let match;

  // Pattern for two-arg tools with multi-line content: @tool_name(path, """content""")
  // (parse first — most specific pattern)
  const multiLinePattern = /@(write_file|append_file)\s*\(\s*([^,]+?)\s*,\s*"""([\s\S]*?)"""\s*\)/gi;
  while ((match = multiLinePattern.exec(cleaned)) !== null) {
    toolCalls.push({
      tool: match[1].toLowerCase(),
      args: [match[2].trim(), match[3]]
    });
  }

  // Pattern for search: @search_files(pattern, query)
  const searchPattern = /@search_files\s*\(\s*([^,]+?)\s*,\s*([^)]+)\s*\)/gi;
  while ((match = searchPattern.exec(cleaned)) !== null) {
    toolCalls.push({
      tool: 'search_files',
      args: [match[1].trim(), match[2].trim()]
    });
  }

  // Pattern for single-arg tools with double-quoted args: @tool("arg")
  // Handles nested single-quotes and escaped chars inside double quotes.
  const dblQuotedPattern = /@(read_file|list_dir|run_command|report_error)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/gi;
  while ((match = dblQuotedPattern.exec(cleaned)) !== null) {
    toolCalls.push({
      tool: match[1].toLowerCase(),
      args: [match[2].trim()]
    });
  }

  // Pattern for single-arg tools with single-quoted args: @tool('arg')
  const sglQuotedPattern = /@(read_file|list_dir|run_command|report_error)\s*\(\s*'((?:[^'\\]|\\.)*)'\s*\)/gi;
  while ((match = sglQuotedPattern.exec(cleaned)) !== null) {
    toolCalls.push({
      tool: match[1].toLowerCase(),
      args: [match[2].trim()]
    });
  }

  // Pattern for single-arg tools without quotes: @tool(arg)
  // Only match if we haven't already matched this tool call via quoted patterns above.
  const unquotedPattern = /@(read_file|list_dir|run_command|report_error)\s*\(\s*([^)]+)\s*\)/gi;
  while ((match = unquotedPattern.exec(cleaned)) !== null) {
    const tool = match[1].toLowerCase();
    const rawArg = match[2].trim();
    // Strip surrounding quotes if the LLM added them (sanitizeArg also does this,
    // but we deduplicate here by checking if a quoted-pattern already captured this arg).
    const stripped = rawArg.replace(/^["']+|["']+$/g, '').trim();
    const isDuplicate = toolCalls.some(
      tc => tc.tool === tool && (tc.args[0] === stripped || tc.args[0] === rawArg)
    );
    if (!isDuplicate) {
      toolCalls.push({ tool, args: [rawArg] });
    }
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
