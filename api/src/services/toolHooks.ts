export interface ToolHookRule {
  id: string;
  name: string;
  enabled: boolean;
  pattern: string;
  action: 'block' | 'warn';
  tools: string[]; // e.g. ['run_command', 'mcp_call'] or ['*'] for all
  description?: string;
}

export interface ToolHooksConfig {
  enabled?: boolean;
  rules?: ToolHookRule[];
}

export interface HookCheckResult {
  allowed: boolean;
  matchedRule?: ToolHookRule;
  message?: string;
}

export function checkToolHooks(
  config: ToolHooksConfig | undefined,
  toolName: string,
  args: string[]
): HookCheckResult {
  if (!config?.enabled || !config.rules?.length) {
    return { allowed: true };
  }

  const input = buildCheckString(toolName, args);

  for (const rule of config.rules) {
    if (!rule.enabled) continue;

    if (!rule.tools.includes('*') && !rule.tools.includes(toolName)) continue;

    try {
      const regex = new RegExp(rule.pattern, 'i');
      if (regex.test(input)) {
        const message = `[ToolHook] Rule "${rule.name}" matched: ${rule.description || rule.pattern}`;
        console.log(`🛡️ ${message} | tool=${toolName} action=${rule.action}`);

        if (rule.action === 'block') {
          return {
            allowed: false,
            matchedRule: rule,
            message: `⛔ Blocked by security rule "${rule.name}": ${rule.description || 'This operation is not allowed.'}`,
          };
        }
        // warn: log but allow
        return {
          allowed: true,
          matchedRule: rule,
          message: `⚠️ Warning from rule "${rule.name}": ${rule.description || rule.pattern}`,
        };
      }
    } catch {
      console.error(`[ToolHook] Invalid regex in rule "${rule.name}": ${rule.pattern}`);
    }
  }

  return { allowed: true };
}

function buildCheckString(toolName: string, args: string[]): string {
  return `${toolName}(${args.join(', ')})`;
}

export const BUILTIN_RULES: ToolHookRule[] = [
  {
    id: 'block-drop-database',
    name: 'Block DROP DATABASE',
    enabled: true,
    pattern: 'DROP\\s+DATABASE',
    action: 'block',
    tools: ['run_command', 'mcp_call'],
    description: 'Prevents dropping entire databases',
  },
  {
    id: 'block-drop-table',
    name: 'Block DROP TABLE',
    enabled: true,
    pattern: 'DROP\\s+TABLE',
    action: 'block',
    tools: ['run_command', 'mcp_call'],
    description: 'Prevents dropping database tables',
  },
  {
    id: 'block-truncate-table',
    name: 'Block TRUNCATE TABLE',
    enabled: true,
    pattern: 'TRUNCATE\\s+TABLE',
    action: 'block',
    tools: ['run_command', 'mcp_call'],
    description: 'Prevents truncating database tables',
  },
  {
    id: 'block-rm-rf-root',
    name: 'Block rm -rf /',
    enabled: true,
    pattern: 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\\s+(/|/\\*|~|\\$HOME)',
    action: 'block',
    tools: ['run_command'],
    description: 'Prevents recursive deletion of root or home directory',
  },
  {
    id: 'block-format-disk',
    name: 'Block disk formatting',
    enabled: true,
    pattern: '(mkfs|fdisk|dd\\s+if=|wipefs)',
    action: 'block',
    tools: ['run_command'],
    description: 'Prevents disk formatting operations',
  },
  {
    id: 'block-delete-all-rows',
    name: 'Block DELETE without WHERE',
    enabled: true,
    pattern: 'DELETE\\s+FROM\\s+\\S+\\s*;',
    action: 'block',
    tools: ['run_command', 'mcp_call'],
    description: 'Prevents DELETE statements without a WHERE clause',
  },
  {
    id: 'warn-sudo',
    name: 'Warn on sudo usage',
    enabled: false,
    pattern: '\\bsudo\\b',
    action: 'warn',
    tools: ['run_command'],
    description: 'Warns when commands use sudo',
  },
  {
    id: 'block-docker-system-prune',
    name: 'Block docker system prune',
    enabled: false,
    pattern: 'docker\\s+(system|volume)\\s+prune',
    action: 'block',
    tools: ['run_command'],
    description: 'Prevents docker system/volume prune operations',
  },
  {
    id: 'block-git-force-push',
    name: 'Block git force push',
    enabled: false,
    pattern: 'git\\s+push\\s+.*--force',
    action: 'block',
    tools: ['run_command'],
    description: 'Prevents force-pushing to git remotes',
  },
  {
    id: 'block-chmod-777',
    name: 'Block chmod 777',
    enabled: false,
    pattern: 'chmod\\s+777',
    action: 'warn',
    tools: ['run_command'],
    description: 'Warns when setting world-writable permissions',
  },
];
