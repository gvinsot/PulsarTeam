/**
 * Native function tools exposed to every direct chat provider. This is the
 * canonical contract for the in-house chat path: providers receive these JSON
 * schemas, and the execution layer receives the normalized positional shape it
 * already understands.
 */

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  error?: string;
}

export interface ExecutionToolCall {
  id: string;
  tool: string;
  args: string[];
  nativeArguments: Record<string, unknown>;
  error?: string;
}

type JsonSchema = Record<string, unknown>;

interface NativeToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const string = (description: string): JsonSchema => ({ type: 'string', description });
const integer = (description: string): JsonSchema => ({ type: 'integer', description });

const tool = (name: string, description: string, parameters: JsonSchema): NativeToolDefinition => ({
  type: 'function',
  function: { name, description, parameters },
});

export const NATIVE_TOOL_DEFINITIONS: NativeToolDefinition[] = [
  tool(
    'read_file',
    'Read a text file from the current project. Paths are relative to the project root.',
    object(
      {
        path: string('Relative file path.'),
        start_line: integer('Optional 1-indexed first line.'),
        end_line: integer('Optional 1-indexed last line.'),
      },
      ['path']
    )
  ),
  tool(
    'write_file',
    'Create or replace a text file in the current project. Read a file before modifying it.',
    object({ path: string('Relative file path.'), content: string('Complete file contents.') }, [
      'path',
      'content',
    ])
  ),
  tool(
    'append_file',
    'Append text to a file in the current project.',
    object({ path: string('Relative file path.'), content: string('Text to append.') }, [
      'path',
      'content',
    ])
  ),
  tool(
    'list_dir',
    'List files and directories below a project-relative path.',
    object({ path: string('Relative directory path. Defaults to the project root.') })
  ),
  tool(
    'search_files',
    'Search project files for text.',
    object({ pattern: string('Glob pattern, for example *.ts.'), query: string('Text to find.') }, [
      'query',
    ])
  ),
  tool(
    'run_command',
    'Run a shell command in the current project directory.',
    object({ command: string('Shell command to run.') }, ['command'])
  ),
  tool('list_my_tasks', "List this agent's current tasks and their statuses.", object({})),
  tool(
    'update_task',
    'Move a task to a workflow column and/or finish it with a summary. Provide at least one of status, comment, or commits.',
    object(
      {
        task_id: string('Task ID.'),
        status: string('Target workflow column ID.'),
        comment: string('Completion summary appended to the task.'),
        commits: string('Optional pushed commits, formatted as hash:message entries.'),
      },
      ['task_id']
    )
  ),
  tool(
    'move_task_to_board',
    'Move a task to another board.',
    object({ task_id: string('Task ID.'), board_id: string('Target board ID.') }, [
      'task_id',
      'board_id',
    ])
  ),
  tool('delete_task', 'Soft-delete a task.', object({ task_id: string('Task ID.') }, ['task_id'])),
  tool('list_boards', 'List boards and their workflow columns.', object({})),
  tool(
    'list_tasks',
    'List tasks, optionally filtered by status and board.',
    object({
      status: string('Optional workflow column ID.'),
      board_id: string('Optional board ID.'),
    })
  ),
  tool('list_projects', 'List projects available to this agent.', object({})),
  tool('check_status', "Get this agent's detailed status and task counts.", object({})),
  tool(
    'report_error',
    'Report a blocking problem to the manager.',
    object({ description: string('Clear description of the blocking problem.') }, ['description'])
  ),
  tool(
    'mcp_call',
    'Call a tool exposed by an MCP server enabled for this agent. Use actual argument values, never an input schema.',
    object(
      {
        server: string('Enabled MCP server name.'),
        tool: string('Tool name exposed by that MCP server.'),
        arguments: {
          type: 'object',
          description: 'Arguments accepted by the MCP tool.',
          additionalProperties: true,
        },
      },
      ['server', 'tool', 'arguments']
    )
  ),
  tool(
    'search_skill',
    'Search reusable agent skills.',
    object({ query: string('Search query.') }, ['query'])
  ),
  tool(
    'create_skill',
    'Create a reusable agent skill.',
    object(
      {
        name: string('Skill name.'),
        description: string('Short description.'),
        category: string('Skill category.'),
        instructions: string('Skill instructions.'),
        mcp_server_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'MCP server IDs used by the skill.',
        },
      },
      ['name', 'instructions']
    )
  ),
  tool(
    'update_skill',
    'Update a reusable agent skill.',
    object(
      {
        id: string('Skill ID.'),
        name: string('Optional new name.'),
        description: string('Optional new description.'),
        category: string('Optional new category.'),
        instructions: string('Optional new instructions.'),
        mcp_server_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional MCP server IDs.',
        },
      },
      ['id']
    )
  ),
  tool(
    'delete_skill',
    'Delete a reusable agent skill.',
    object({ id: string('Skill ID.') }, ['id'])
  ),
  tool(
    'ask_agent',
    'Ask another enabled agent a concise question. Only available when direct agent access is enabled.',
    object(
      { agent_name: string('Name of the target agent.'), question: string('Question to ask.') },
      ['agent_name', 'question']
    )
  ),
];

function asString(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/** Convert the provider-neutral named arguments into the existing executor shape. */
export function toExecutionToolCall(call: NativeToolCall): ExecutionToolCall {
  const a = call.arguments || {};
  const pick = (...names: string[]) => {
    for (const name of names) {
      if (a[name] !== undefined) return a[name];
    }
    return undefined;
  };

  let args: string[];
  switch (call.name) {
    case 'read_file':
      args = [
        asString(pick('path', 'file', 'filename')),
        asString(pick('start_line', 'startLine')),
        asString(pick('end_line', 'endLine')),
      ];
      break;
    case 'write_file':
    case 'append_file':
      args = [asString(pick('path', 'file')), asString(pick('content'))];
      break;
    case 'list_dir':
      args = [asString(pick('path', 'directory', 'dir')) || '.'];
      break;
    case 'search_files':
      args = [asString(pick('pattern', 'glob')) || '*', asString(pick('query', 'search'))];
      break;
    case 'run_command':
      args = [asString(pick('command', 'cmd'))];
      break;
    case 'update_task':
      args = [
        asString(pick('task_id', 'taskId', 'id')),
        asString(pick('status')),
        asString(pick('comment', 'details', 'message')),
        asString(pick('commits')),
      ];
      break;
    case 'move_task_to_board':
      args = [asString(pick('task_id', 'taskId', 'id')), asString(pick('board_id', 'boardId'))];
      break;
    case 'delete_task':
      args = [asString(pick('task_id', 'taskId', 'id'))];
      break;
    case 'list_tasks':
      args = [asString(pick('status')), asString(pick('board_id', 'boardId'))];
      break;
    case 'report_error':
      args = [asString(pick('description', 'message', 'error'))];
      break;
    case 'mcp_call':
      args = [
        asString(pick('server', 'server_name', 'serverName')),
        asString(pick('tool', 'tool_name', 'toolName')),
      ];
      break;
    case 'search_skill':
      args = [asString(pick('query', 'search', 'keyword'))];
      break;
    case 'create_skill':
      args = [
        asString(pick('name')),
        json({
          description: pick('description') || '',
          category: pick('category') || 'general',
          instructions: pick('instructions') || '',
          mcpServerIds: pick('mcp_server_ids', 'mcpServerIds') || [],
        }),
      ];
      break;
    case 'update_skill':
      args = [
        asString(pick('id')),
        json({
          name: pick('name'),
          description: pick('description'),
          category: pick('category'),
          instructions: pick('instructions'),
          mcpServerIds: pick('mcp_server_ids', 'mcpServerIds'),
        }),
      ];
      break;
    case 'delete_skill':
      args = [asString(pick('id'))];
      break;
    case 'ask_agent':
      args = [asString(pick('agent_name', 'agentName')), asString(pick('question'))];
      break;
    default:
      args = [];
      break;
  }

  return {
    id: call.id,
    tool: call.name,
    args,
    nativeArguments: a,
    ...(call.error ? { error: call.error } : {}),
  };
}

export function toAnthropicTools(tools: NativeToolDefinition[]): any[] {
  return tools.map(({ function: fn }) => ({
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters,
  }));
}
