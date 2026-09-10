import { errorMessage } from '../lib/errors.js';
import type { ExecutionProvider } from './execution/executionProvider.js';

// Tool definitions that will be injected into agent prompts
// Sanitize a tool argument: only strip a matching pair of surrounding quotes.
function sanitizeArg(arg: string): string {
  if (!arg) return arg;
  arg = arg.trim();
  if (arg.length >= 2) {
    const first = arg[0],
      last = arg[arg.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      arg = arg.slice(1, -1);
    }
  }
  return arg.trim();
}

// Normalize path: strip absolute prefixes and prevent traversal attacks
function normalizePath(pathArg: string): string {
  let p = sanitizeArg(pathArg);
  // Decode any URL-encoded characters that could bypass path checks
  try {
    p = decodeURIComponent(p);
  } catch {}
  // Strip /workspace/<project>/ or /projects/<project>/ prefixes
  p = p.replace(/^\/workspace\/[^/]+\//, '');
  p = p.replace(/^\/projects\/[^/]+\//, '');
  // Strip any remaining leading slashes
  if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  // Remove ALL path traversal segments (.. in any form)
  p = p
    .split('/')
    .filter(seg => seg !== '..' && seg !== '.')
    .join('/');
  // Block null bytes (classic injection vector)
  p = p.replace(/\0/g, '');
  // Validate the result stays within project — no absolute paths after normalization
  if (p.startsWith('/') || p.includes('/../') || p.endsWith('/..')) {
    console.warn(`🛡️ [Security] Path traversal blocked: ${pathArg}`);
    return '__blocked_path__';
  }
  return p || '.';
}

/**
 * Accident guardrail for the `run_command` tool — NOT a security boundary.
 *
 * These patterns match the literal command string before any shell has expanded
 * it, so they are bypassable by anyone who tries (`/bin/sh -c 'shutdow'"n"`,
 * `eval "$(printf …)"`, a wrapper script, a Makefile target). They also only
 * cover this tool: an agent CLI driven through the interactive PTY spawns its
 * own processes and never reaches this function. The point is to stop a
 * well-behaved model from *accidentally* rebooting the host or reformatting a
 * disk mid-task — nothing more should be gated on it, and "the list missed X"
 * is not a vulnerability.
 *
 * Real containment lives in the runner: a per-agent UID with a 0700 HOME
 * (`runner-service/src/agent_user.py`), `cap_drop: ALL` +
 * `no-new-privileges:true` in `docker-compose.yml`, environment sanitisation in
 * `runner-service/src/command_security.py`, and the per-agent
 * `execution.shellAccess` permission. See SECURITY.md.
 */
const BLOCKED_COMMAND_PATTERNS = [
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  /\bhalt\b/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\biptables\b/,
  /\bnft\b/,
  /\bufw\b/,
  /\buseradd\b/,
  /\buserdel\b/,
  /\busermod\b/,
  /\bpasswd\b/,
  /\bcrontab\b/,
  /\bsystemctl\b/,
  /\bservice\s/,
  /\/proc\/self\/environ/,
  /\/proc\/\d+\/environ/,
  /\/dev\/tcp\//,
  /\/dev\/udp\//,
  /\bbash\s+-i\s+>&/,
  /\bnc\s+-l/,
  /\bncat\s+-l/,
  /\bsocat\s/,
  /\bnmap\s/,
  /\bmasscan\s/,
  /\btcpdump\b/,
  /\btshark\b/,
  /\bmkfifo\s/,
  /\bmknod\s/,
];

/**
 * Screen a command against the guardrail above. `null` means "no known footgun
 * in the literal string", not "safe to run".
 */
function validateCommand(command: string): string | null {
  if (!command?.trim()) return 'Empty command';
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      console.warn(`🛡️ [Guardrail] Refused command from agent: ${command.slice(0, 100)}`);
      return 'Command refused by the safety guardrail';
    }
  }
  return null;
}

/**
 * Per-tool extras attached to a tool result. `path` / `query` / `command` are
 * declared because consumers read them back; everything else a tool chooses to
 * report (sizes, line ranges, truncation flags) rides on the index signature as
 * `unknown`, so reading one has to narrow it first.
 */
export interface ToolResultMeta {
  /** File or directory the tool touched. */
  path?: string;
  /** Search term — search_files. */
  query?: string;
  /** Shell command that ran — run_command. */
  command?: string;
  [key: string]: unknown;
}

/**
 * What every tool hands back.
 *
 * `result` and `error` are both optional rather than split into a discriminated
 * union on `success`: the failure branch frequently carries partial output in
 * `result` too (a command that failed still produced stdout), and this tsc does
 * not narrow the negative branch of such a union anyway.
 */
export interface ToolResult {
  success: boolean;
  /** Tool output — the command's stdout, the file's contents, ... */
  result?: string;
  /** Failure reason, set whenever `success` is false. */
  error?: string;
  meta?: ToolResultMeta;
}

/**
 * Execute a tool command using the execution provider (sandbox or coder-service).
 * @param {string} toolName
 * @param {string[]} args
 * @param {string} projectPath - project name
 * @param {import('./execution/executionProvider.js').ExecutionProvider} provider
 * @param {string} agentId
 */
export async function executeTool(
  toolName: string,
  args: string[],
  projectPath: string | null,
  provider: ExecutionProvider,
  agentId: string
): Promise<ToolResult> {
  if (!provider || !agentId) {
    return { success: false, error: 'Execution provider not available' };
  }

  if (!provider.hasEnvironment(agentId)) {
    // Attempt lazy initialization instead of just returning an error
    try {
      await provider.ensureProject(agentId, projectPath || null);
    } catch (initErr) {
      console.error(
        `⚠️  [Tool] Provider lazy init failed for agent ${agentId.slice(0, 8)}: ${errorMessage(initErr)}`
      );
    }
    if (!provider.hasEnvironment(agentId)) {
      return {
        success: false,
        error: 'Execution environment is not available. Please report this error.',
      };
    }
  }

  // Verify execution environment matches the expected project
  const envProject = provider.getProject(agentId);
  if (projectPath && envProject && envProject !== projectPath) {
    console.error(
      `🚫 [Tool] Project mismatch! Agent ${agentId.slice(0, 8)} expects "${projectPath}" but execution env has "${envProject}". Blocking tool to prevent wrong-project execution.`
    );
    return {
      success: false,
      error: `Project mismatch: expected "${projectPath}" but execution environment is on "${envProject}". The task cannot safely execute. Please report this error.`,
    };
  }

  const cleanArgs = args.map(a => sanitizeArg(a));

  console.log(
    `🔧 [Tool] ${toolName}(${cleanArgs.map(a => (a?.length > 100 ? a.slice(0, 100) + '...' : a)).join(', ')}) | agent=${agentId.slice(0, 8)} project=${projectPath}`
  );

  try {
    switch (toolName) {
      case 'read_file':
        return await toolReadFile(
          provider,
          agentId,
          normalizePath(cleanArgs[0]),
          cleanArgs[1],
          cleanArgs[2]
        );

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
    return { success: false, error: errorMessage(err) };
  }
}

// ─── Tool implementations (all via execution provider) ──────────────────

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
]);

function getFileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

async function toolReadFile(
  provider: ExecutionProvider,
  agentId: string,
  filePath: string,
  startLineArg: string,
  endLineArg: string
) {
  if (filePath === '__blocked_path__') {
    return { success: false, error: 'Path blocked: detected path traversal attempt' };
  }
  try {
    const ext = getFileExtension(filePath);
    if (IMAGE_EXTENSIONS.has(ext) && ext !== '.svg') {
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
      };
      const mediaType = mimeMap[ext] || 'image/png';
      try {
        const result = await provider.exec(
          agentId,
          `base64 -w0 "${filePath.replace(/"/g, '\\"')}"`,
          { timeout: 30000 }
        );
        const b64 = ((result.stdout || '') + (result.stderr || '')).trim();
        if (b64 && b64.length < 10 * 1024 * 1024) {
          return {
            success: true,
            result: `[Image file: ${filePath} (${mediaType}, ${Math.round((b64.length * 3) / 4 / 1024)}KB)]`,
            images: [{ data: b64, mediaType }],
            meta: { path: filePath, isImage: true },
          };
        }
      } catch {}
      return {
        success: true,
        result: `[Binary image file: ${filePath} — too large to display or base64 failed]`,
        meta: { path: filePath, isImage: true },
      };
    }

    const content = await provider.readFile(agentId, filePath);
    const allLines = content.split('\n');

    // Parse optional line range: (path, startLine[, endLine])
    const startLine = parseInt(startLineArg, 10);
    const endLine = parseInt(endLineArg, 10);

    if (!isNaN(startLine) && startLine > 0) {
      const start = Math.max(0, startLine - 1);
      const end =
        !isNaN(endLine) && endLine >= startLine
          ? Math.min(endLine, allLines.length)
          : allLines.length;
      const sliced = allLines.slice(start, end);
      return {
        success: true,
        result: sliced.join('\n'),
        meta: { path: filePath, startLine, endLine: end, totalLines: allLines.length },
      };
    }

    // Auto-truncate large files and hint the agent to use line ranges
    const MAX_LINES = 500;
    if (allLines.length > MAX_LINES) {
      const truncated = allLines.slice(0, MAX_LINES).join('\n');
      return {
        success: true,
        result: `${truncated}\n\n--- TRUNCATED: showing ${MAX_LINES}/${allLines.length} lines. Use read_file with path, start_line, and end_line to read specific sections. ---`,
        meta: { path: filePath, size: content.length, lines: allLines.length, truncated: true },
      };
    }

    return {
      success: true,
      result: content,
      meta: { path: filePath, size: content.length, lines: allLines.length },
    };
  } catch (err) {
    if (errorMessage(err).includes('No such file')) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    throw err;
  }
}

async function toolWriteFile(
  provider: ExecutionProvider,
  agentId: string,
  filePath: string,
  content: string
) {
  if (filePath === '__blocked_path__') {
    return { success: false, error: 'Path blocked: detected path traversal attempt' };
  }
  await provider.writeFile(agentId, filePath, content);
  return {
    success: true,
    result: `File written: ${filePath} (${content.length} bytes)`,
    meta: { path: filePath, size: content.length },
  };
}

async function toolListDir(provider: ExecutionProvider, agentId: string, dirPath: string) {
  const output = await provider.listDir(agentId, dirPath);
  return {
    success: true,
    result: output || '(empty directory)',
    meta: { path: dirPath },
  };
}

async function toolSearchFiles(
  provider: ExecutionProvider,
  agentId: string,
  pattern: string,
  query: string
) {
  const output = await provider.searchFiles(agentId, pattern, query);
  return {
    success: true,
    result: output || 'No matches found',
    meta: { query },
  };
}

// ─── RTK (Rust Token Killer) — automatic command rewriting ──────────────────
// RTK wraps common CLI commands to produce compressed output that saves 60-90%
// tokens when sent back to the LLM.  Only safe, read-only commands are rewritten.

const RTK_REWRITE_RULES: { pattern: RegExp; rewrite: (cmd: string) => string }[] = [
  // git commands (read-only)
  { pattern: /^git\s+status\b/, rewrite: cmd => cmd.replace(/^git\s+status/, 'rtk git status') },
  { pattern: /^git\s+diff\b/, rewrite: cmd => cmd.replace(/^git\s+diff/, 'rtk git diff') },
  { pattern: /^git\s+log\b/, rewrite: cmd => cmd.replace(/^git\s+log/, 'rtk git log') },
  // file listing
  { pattern: /^ls\b/, rewrite: cmd => cmd.replace(/^ls/, 'rtk ls') },
  { pattern: /^tree\b/, rewrite: cmd => cmd.replace(/^tree/, 'rtk ls') },
  // search
  { pattern: /^grep\s/, rewrite: cmd => cmd.replace(/^grep/, 'rtk grep') },
  { pattern: /^rg\s/, rewrite: cmd => cmd.replace(/^rg/, 'rtk grep') },
  // find
  { pattern: /^find\s/, rewrite: cmd => cmd.replace(/^find/, 'rtk find') },
  // test runners — failures-only output
  {
    pattern: /^(npm\s+test|npx\s+jest|npx\s+vitest|npx\s+mocha|pytest|cargo\s+test|go\s+test)\b/,
    rewrite: cmd => `rtk test ${cmd}`,
  },
  // build commands
  { pattern: /^(npm\s+run\s+build|cargo\s+build|go\s+build|make)\b/, rewrite: cmd => `rtk ${cmd}` },
  // linting
  { pattern: /^(npx\s+eslint|eslint|golangci-lint)\b/, rewrite: cmd => `rtk lint ${cmd}` },
];

// Commands that should NEVER be rewritten (write operations, interactive, piped)
const RTK_SKIP_PATTERNS = [
  /\|/, // piped commands — RTK can't wrap pipelines
  /&&/, // chained commands
  /;/, // sequential commands
  /^git\s+(add|commit|push|pull|merge|rebase|checkout|reset|stash|clone)\b/,
  /^(npm\s+install|npm\s+ci|yarn|pnpm|pip|apt|apk)\b/,
  /^(docker|kubectl|curl|wget)\b/,
  /^(cat|head|tail|echo|printf|mkdir|rm|cp|mv|touch|chmod|chown)\b/,
  /^rtk\b/, // already rewritten
];

/**
 * Attempt to rewrite a command with RTK prefix for token-optimized output.
 * Returns the original command if RTK is not applicable.
 */
function rtkRewrite(command: string): string {
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

/**
 * A failed `exec` rejects with an error that also carries the captured streams
 * and the exit status. Read them off the caught `unknown` without assuming the
 * shape: a rejection from anywhere else simply yields empty output.
 */
function execFailure(err: unknown): {
  stdout: string;
  stderr: string;
  code: string | number | undefined;
} {
  if (err !== null && typeof err === 'object') {
    const source = err as Record<string, unknown>;
    const code = source.code;
    return {
      stdout: typeof source.stdout === 'string' ? source.stdout : '',
      stderr: typeof source.stderr === 'string' ? source.stderr : '',
      code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    };
  }
  return { stdout: '', stderr: '', code: undefined };
}

async function toolRunCommand(provider: ExecutionProvider, agentId: string, command: string) {
  // Accident guardrail, not a boundary — the runner's UID/capability isolation is
  // what actually contains this command. See BLOCKED_COMMAND_PATTERNS above.
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
    const { stdout, stderr } = await provider.exec(agentId, effectiveCommand, {
      timeout: COMMAND_TIMEOUT,
    });
    const output = ([stdout, stderr].filter(Boolean).join('\n') || '(no output)').slice(0, 10000);
    return {
      success: true,
      result: output,
      meta: { command, rtk: useRtk, truncated: (stdout || '').length > 10000 },
    };
  } catch (err) {
    // If RTK command failed, retry with original command
    if (useRtk) {
      console.log(
        `⚡ [RTK] Rewritten command failed, falling back to original: "${command.slice(0, 80)}"`
      );
      try {
        const { stdout, stderr } = await provider.exec(agentId, command, {
          timeout: COMMAND_TIMEOUT,
        });
        const output = ([stdout, stderr].filter(Boolean).join('\n') || '(no output)').slice(
          0,
          10000
        );
        return {
          success: true,
          result: output,
          meta: {
            command,
            rtk: false,
            rtkFallback: true,
            truncated: (stdout || '').length > 10000,
          },
        };
      } catch (fallbackErr) {
        const fallbackFailure = execFailure(fallbackErr);
        const output = fallbackFailure.stdout + fallbackFailure.stderr;
        if (output.trim()) {
          return {
            success: true,
            result: output.slice(0, 10000),
            meta: { command, exitCode: fallbackFailure.code || 1 },
          };
        }
        return { success: false, error: errorMessage(fallbackErr), result: '' };
      }
    }
    // Original command error handling (non-RTK path)
    const failure = execFailure(err);
    const output = failure.stdout + failure.stderr;
    if (output.trim()) {
      return {
        success: true,
        result: output.slice(0, 10000),
        meta: { command, exitCode: failure.code || 1 },
      };
    }
    return {
      success: false,
      error: errorMessage(err),
      result: '',
    };
  }
}

async function toolAppendFile(
  provider: ExecutionProvider,
  agentId: string,
  filePath: string,
  content: string
) {
  if (filePath === '__blocked_path__') {
    return { success: false, error: 'Path blocked: detected path traversal attempt' };
  }
  await provider.appendFile(agentId, filePath, content);
  return {
    success: true,
    result: `Content appended to: ${filePath}`,
    meta: { path: filePath },
  };
}
