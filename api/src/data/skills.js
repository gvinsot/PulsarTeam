export const BUILTIN_SKILLS = [
  {
    "id": "skill-swarm-reader",
    "name": "Swarm Reader",
    "description": "Monitor Docker Swarm stacks, containers, hosts and search logs via PulsarCD Read",
    "category": "devops",
    "icon": "📊",
    "builtin": true,
    "mcpServerIds": [
      "mcp-pulsarcd-read"
    ],
    "instructions": `You can monitor the Docker Swarm cluster using the PulsarCD Read MCP tools (read-only).

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Call them using the @mcp_call(PulsarCD Read, tool_name, {"param": "value"}) syntax shown there.

## AVAILABLE TOOLS

@mcp_call(PulsarCD Read, list_stacks, {})
  — List all available stacks (GitHub starred repos).

@mcp_call(PulsarCD Read, list_containers, {"host": "optional", "status": "optional"})
  — List containers and their state. Filter by host or status.

@mcp_call(PulsarCD Read, list_computers, {})
  — List all monitored hosts/machines.

@mcp_call(PulsarCD Read, get_log_metadata, {})
  — Discover available services, containers, hosts, and log levels.

@mcp_call(PulsarCD Read, search_logs, {"query": "error", "last_hours": 24})
  — Search collected logs. Supports filters: query, github_project, compose_services, hosts, containers, levels, http_status_min, http_status_max, last_hours, start_time, end_time, opensearch_query, size.

@mcp_call(PulsarCD Read, get_action_status, {"action_id": "ACTION_ID"})
  — Check the status of a build/deploy action.

## MONITORING WORKFLOW
1. Use @mcp_call(PulsarCD Read, list_stacks, {}) to see all deployed projects
2. Use @mcp_call(PulsarCD Read, list_containers, {}) to check running containers
3. Use @mcp_call(PulsarCD Read, search_logs, {"query": "error", "last_hours": 24}) to investigate issues
4. Use @mcp_call(PulsarCD Read, list_computers, {}) to check node availability
5. Use @mcp_call(PulsarCD Read, get_log_metadata, {}) to discover available log sources before searching`
  },
  {
    "id": "skill-swarm-actions",
    "name": "Swarm Actions",
    "description": "Build, test and deploy stacks on Docker Swarm via PulsarCD Actions",
    "category": "devops",
    "icon": "🚀",
    "builtin": true,
    "mcpServerIds": [
      "mcp-pulsarcd-actions",
      "mcp-gandi-dns"
    ],
    "instructions": `You can build, test, and deploy projects on the Docker Swarm cluster using PulsarCD Actions MCP tools.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Call them using the @mcp_call(ServerName, tool_name, {"param": "value"}) syntax shown there.

## BUILD & DEPLOY TOOLS (PulsarCD Actions)

@mcp_call(PulsarCD Actions, build_stack, {"repo_name": "my-app", "ssh_url": "git@github.com:org/my-app.git", "version": "1.2.0", "branch": "main"})
  — Build a Docker image from a GitHub repo. Optional: branch, commit.

@mcp_call(PulsarCD Actions, test_stack, {"repo_name": "my-app", "ssh_url": "git@github.com:org/my-app.git", "branch": "main"})
  — Run tests for a stack (docker-compose.swarm.yml test target). Optional: branch, tag, commit.

@mcp_call(PulsarCD Actions, deploy_stack, {"repo_name": "my-app", "ssh_url": "git@github.com:org/my-app.git", "version": "1.2.0"})
  — Deploy a stack on Docker Swarm. Optional: tag.

All three tools return an action_id. Use get_action_status on the Read server to track progress.

## MONITORING TOOLS (PulsarCD Read)

@mcp_call(PulsarCD Read, get_action_status, {"action_id": "ACTION_ID"})
  — Check the status of a build/test/deploy action.

@mcp_call(PulsarCD Read, list_stacks, {})
  — List all available stacks.

@mcp_call(PulsarCD Read, list_containers, {})
  — List containers and their state.

@mcp_call(PulsarCD Read, search_logs, {"query": "error", "last_hours": 1})
  — Search logs to investigate issues after deployment.

## DEPLOYMENT WORKFLOW

FIRST TIME SETUP — If the project has no devops/ folder yet:
   - Read the existing project structure and understand what needs to be containerized
   - Create the devops/ folder with docker-compose.swarm.yml, .env, and optional pre/post scripts
   - Commit and push: use cli

BUILD:
   1. Call @mcp_call(PulsarCD Actions, build_stack, {...}) with repo_name, ssh_url, and version
   2. Track progress: @mcp_call(PulsarCD Read, get_action_status, {"action_id": "ACTION_ID"})
   3. Fix any build errors before proceeding

TEST:
   1. Call @mcp_call(PulsarCD Actions, test_stack, {...}) with repo_name and ssh_url
   2. Track progress: @mcp_call(PulsarCD Read, get_action_status, {"action_id": "ACTION_ID"})

DEPLOY:
   1. Call @mcp_call(PulsarCD Actions, deploy_stack, {...}) with repo_name, ssh_url, and version
   2. Track progress: @mcp_call(PulsarCD Read, get_action_status, {"action_id": "ACTION_ID"})
   3. Verify: @mcp_call(PulsarCD Read, list_containers, {}) to check services are running

## IMPORTANT
- Your workspace is EPHEMERAL. Always commit and push after completing changes to preserve your work.
- Always check action status after build/test/deploy — do not assume success.`
  },
  {
    "id": "skill-basic-tools",
    "name": "Basic Tools",
    "description": "Essential tools for reading, writing, searching files and running commands",
    "category": "general",
    "icon": "🔧",
    "builtin": true,
    "instructions": `## TOOLS — USE THEM, DON'T JUST TALK
- @read_file(path) — examine existing code
- @list_dir(path) — explore code structure
- @list_projects() — list available projects (GitHub repos)
- @write_file(path, """content""") — create or update files
- @search_files(pattern, query) — find relevant code
- @run_command(command) — run tests, builds, git commands, etc.
- @list_my_tasks() — list your assigned tasks with their status and ID
- @update_task(taskId, status) — update a task status (any workflow column ID or error)
- @task_execution_complete(comment, taskId, commits) — signal that your current task is finished (REQUIRED when executing a task). taskId is optional (auto-detected). commits is optional (format: hash:msg, hash:msg — must be already pushed).
- Use @run_command to execute git commands and any shell commands

GIT WORKFLOW — use @run_command for all git operations:
  @run_command(git add -A)
  @run_command(git commit -m "your message (by YourAgentName)")
  @run_command(git push)
  If push fails due to remote changes:
  @run_command(git pull --rebase)
  @run_command(git push)
  IMPORTANT: Always include your agent name in the commit message. Format: "message (by YourName)".
  Commits from git commands are automatically detected and linked to your current active task.

WORKFLOW:
1. Always start by exploring the project structure with @list_dir(.)
2. Study existing files and code conventions BEFORE writing anything — match naming, formatting, patterns, and folder organization already in use
3. Read existing files before modifying them with @read_file(path)
4. Write changes with @write_file(path, """content""") — follow the existing code style
5. Verify your changes by reading the file back
6. Run tests or builds with @run_command(npm test) or similar
7. Use @search_files(*.js, keyword) to find relevant code across the project

IMPORTANT:
- Each tool call MUST be on its own line
- Do NOT add decorative text before tool calls — just call the tool directly
- NEVER stop yourself — keep working until the task is fully complete
- When executing an assigned task, you MUST call @task_execution_complete(summary) when done. The system will not consider your task finished until you call this tool. The system WILL send you reminders if you forget. You can optionally specify the taskId: @task_execution_complete(summary, taskId)
- COMPLETION SEQUENCE: Always follow this order: 1) commit and push with @run_command (git add, git commit, git push), 2) @task_execution_complete(summary) to signal completion. You can also specify an explicit task: @task_execution_complete(summary, taskId)
- Your workspace is EPHEMERAL. Always commit and push after completing changes to preserve your work.

EXECUTION RULES — follow these steps strictly, one at a time:
1. EXPLORE: Use @list_dir and @read_file to understand the codebase structure and find the relevant files.
2. PLAN: Identify what files need to be created or modified.
3. IMPLEMENT: Use @write_file to create or modify each file. Call @write_file for EVERY file you want to change — the system does NOT auto-generate code.
4. VERIFY: Use @read_file to confirm your changes are correct.
5. COMMIT: Use @run_command with git commands to commit and push: git add -A, git commit -m "message (by YourName)", git push.
6. COMPLETE: Call @task_execution_complete(summary) to signal you are done.

CRITICAL RULES:
- You MUST call @write_file BEFORE committing. Without @write_file, there are NO changes to commit.
- Call tools ONE STEP AT A TIME. Wait for each tool result before calling the next tool.
- Do NOT batch multiple unrelated tools in a single response.
- Do NOT call @task_execution_complete in the same response as @read_file — finish reading first, then write, then commit.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Call them using the @mcp_call(Code Index, tool_name, {"param": "value"}) syntax.

RECOMMENDED WORKFLOW:
1. BEFORE any search, call @mcp_call(Code Index, list_repos, {}) to check if your current project is already indexed.
2. If the current project appears in the list, reuse its repoId — do NOT re-index.
3. If the current project is NOT in the list, index it first:
   - @mcp_call(Code Index, index_folder, {"path": "/projects/YOUR_PROJECT_NAME", "repoName": "YOUR_PROJECT_NAME"})
   - Use the project name from the PROJECT CONTEXT section of your prompt.
4. Search symbols or semantics first, then fetch outlines/source for the best matches.
5. Fall back to normal file tools when you need to edit files.`
  },
  {
    "id": "skill-delegation",
    "name": "Delegation & Management",
    "description": "Manage agents and create tasks via the Swarm API MCP tools",
    "category": "general",
    "icon": "👥",
    "builtin": true,
    "mcpServerIds": [
      "mcp-swarm-api"
    ],
    "instructions": `You can manage agents and delegate work using the Swarm API MCP tools.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Call them using the @mcp_call(Swarm API, tool_name, {"param": "value"}) syntax shown there.

## AVAILABLE TOOLS

@mcp_call(Swarm API, list_agents, {})
  — List all agents with their status, role, project, current task, and open task count.
  Optional filters: {"project": "MyApp"} or {"status": "idle"}.

@mcp_call(Swarm API, get_agent_status, {"agent_name": "Developer"})
  — Get detailed status for a specific agent: current task, full task list, metrics.
  Use agent_name or agent_id.

@mcp_call(Swarm API, list_boards, {})
  — List all task boards with their workflow columns. Use this to discover board IDs before adding tasks.

@mcp_call(Swarm API, add_task, {"agent_name": "Developer", "task": "Implement password reset in src/auth/"})
  — Add a task to an agent's queue. The agent will pick it up and execute it autonomously.
  Optional: project, status (workflow column), board_id.

## DELEGATION WORKFLOW

1. First, check available agents:
   @mcp_call(Swarm API, list_agents, {"status": "idle"})

2. Then assign tasks to the right agents:
   @mcp_call(Swarm API, add_task, {"agent_name": "Developer", "task": "Read src/auth/ and implement password reset", "project": "MyApp"})
   @mcp_call(Swarm API, add_task, {"agent_name": "QA Engineer", "task": "Write unit tests for the user service", "project": "MyApp"})

3. Monitor progress:
   @mcp_call(Swarm API, get_agent_status, {"agent_name": "Developer"})

## IMPORTANT
- Tasks are executed asynchronously — agents pick them up from their queue and work autonomously.
- Use list_boards to discover board IDs if you need to target a specific board.
- If multiple boards exist, you must provide board_id when adding tasks.
- Check agent status to monitor task progress and verify completion.`
  },
  {
    "id": "skill-onedrive",
    "name": "OneDrive",
    "description": "Browse, search, read, upload, and manage files in Microsoft OneDrive via the Graph API",
    "category": "general",
    "icon": "☁️",
    "builtin": true,
    "mcpServerIds": [
      "mcp-onedrive"
    ],
    "instructions": "You can interact with Microsoft OneDrive files using the OneDrive MCP tools.\\n\\n## AVAILABLE TOOLS\\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\\nCall them using the @mcp_call(ServerName, tool_name, {\"param\": \"value\"}) syntax shown there.\\n\\n## OneDrive MCP Tools Reference\\n\\n@mcp_call(OneDrive, list_files, {\"path\": \"/\", \"top\": 50})\\n  — List files and folders at a given path. Use \"/\" for the root directory.\\n\\n@mcp_call(OneDrive, search_files, {\"query\": \"keyword\", \"top\": 25})\\n  — Search for files by name or content across the entire OneDrive.\\n\\n@mcp_call(OneDrive, read_file, {\"path\": \"/Documents/notes.txt\"})\\n  — Read the text content of a file. Works best with text-based files (txt, json, md, csv, etc.).\\n\\n@mcp_call(OneDrive, get_file_info, {\"path\": \"/Documents/report.pdf\"})\\n  — Get detailed metadata about a file or folder (size, type, modified date, web URL).\\n\\n@mcp_call(OneDrive, create_folder, {\"parentPath\": \"/\", \"name\": \"NewFolder\"})\\n  — Create a new folder. parentPath is where to create it.\\n\\n@mcp_call(OneDrive, upload_file, {\"path\": \"/Documents/file.txt\", \"content\": \"Hello World\"})\\n  — Upload or create a text file (up to 4MB).\\n\\n@mcp_call(OneDrive, delete_item, {\"path\": \"/Documents/old-file.txt\"})\\n  — Delete a file or folder (moves to recycle bin).\\n\\n@mcp_call(OneDrive, get_share_link, {\"path\": \"/Documents/report.pdf\", \"type\": \"view\"})\\n  — Create a sharing link. type can be \"view\" (read-only) or \"edit\" (read-write).\\n\\n@mcp_call(OneDrive, get_drive_info, {})\\n  — Get OneDrive storage info (space used, remaining, owner).\\n\\n## USAGE GUIDELINES\\n- Always start by listing the root directory to orient yourself: @mcp_call(OneDrive, list_files, {\"path\": \"/\"})\\n- Use search_files to find specific files when you don't know the exact path\\n- Use get_file_info to check file details before reading large files\\n- Paths use forward slashes and start from the root: /Documents/subfolder/file.txt\\n- When the user asks about \"my files\" or \"my documents\", start by listing the root\\n- For binary files (images, PDFs), provide the web URL or share link instead of reading content\\n- Be cautious with delete_item — always confirm with the user before deleting"
  },
  {
    "id": "skill-agents-direct-access",
    "name": "Agents Direct Access",
    "description": "Ask quick questions to other agents without creating tasks",
    "category": "general",
    "icon": "💬",
    "builtin": true,
    "instructions": "You can ask questions directly to other agents in the swarm.\\n\\n## DIRECT QUESTIONS\\n@ask(AgentName, \"your question here\")\\n\\nUse this for quick answers — no task is created on the target agent.\\nThe target agent will receive your question and respond concisely.\\nTheir answer will be provided back to you inline.\\n\\nWHEN TO USE @ask vs @delegate:\\n- @ask: quick questions (\"What framework is used?\", \"Did the tests pass?\")\\n- @delegate (leaders only): full tasks requiring work\\n\\nExamples:\\n@ask(Developer, \"What testing framework is configured in this project?\")\\n@ask(Security Analyst, \"Are there known vulnerabilities in express 4.21?\")\\n@ask(QA Engineer, \"Did the last test run pass?\")\\n\\nRULES:\\n- One @ask per question\\n- Keep questions concise and specific\\n- The target agent will give a brief answer — this is not for delegating work",
    "mcpServerIds": [],
    "createdAt": "2024-03-01T00:00:00.000Z",
    "updatedAt": "2024-03-01T00:00:00.000Z"
  },
  {
    "id": "skill-code-index",
    "name": "Code Index",
    "description": "Index source folders, inspect file outlines, and run lexical or semantic code search through the internal MCP server",
    "category": "coding",
    "icon": "🧠",
    "builtin": true,
    "mcpServerIds": [
      "mcp-code-index"
    ],
    "instructions": "You can use the internal Code Index plugin to explore codebases faster than raw grep alone.\\n\\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\\nCall them using the @mcp_call(Code Index, tool_name, {\"param\": \"value\"}) syntax.\\n\\nRECOMMENDED WORKFLOW:\\n1. BEFORE any search, call @mcp_call(Code Index, list_repos, {}) to check if your current project is already indexed.\\n2. If the current project appears in the list, reuse its repoId — do NOT re-index.\\n3. If the current project is NOT in the list, index it first:\\n   - @mcp_call(Code Index, index_folder, {\"path\": \"/projects/YOUR_PROJECT_NAME\", \"repoName\": \"YOUR_PROJECT_NAME\"})\\n   - Use the project name from the PROJECT CONTEXT section of your prompt.\\n4. Search symbols or semantics first, then fetch outlines/source for the best matches.\\n5. Fall back to normal file tools when you need to edit files.\\n\\nMOST USEFUL TOOLS:\\n- @mcp_call(Code Index, list_repos, {})\\n  List all indexed repositories and their repoIds. ALWAYS call this first.\\n- @mcp_call(Code Index, index_folder, {\"path\": \"/projects/MyProject\", \"repoName\": \"MyProject\"})\\n  Index a project folder. Use the project name from your PROJECT CONTEXT.\\n- @mcp_call(Code Index, index_workspace, {\"subpath\": \"server/src\", \"repoName\": \"server-src\"})\\n  Index the current application workspace or a subfolder under it.\\n- @mcp_call(Code Index, search_symbols, {\"repoId\": \"...\", \"query\": \"authenticateToken\", \"topK\": 5})\\n  Find classes, functions, and methods by lexical match.\\n- @mcp_call(Code Index, search_semantic, {\"repoId\": \"...\", \"query\": \"JWT auth middleware\", \"topK\": 5})\\n  Find relevant code by meaning.\\n- @mcp_call(Code Index, get_file_outline, {\"repoId\": \"...\", \"filePath\": \"src/middleware/auth.js\"})\\n  Inspect all symbols in a file.\\n- @mcp_call(Code Index, get_symbol, {\"repoId\": \"...\", \"symbolId\": \"...\", \"verify\": true, \"contextLines\": 2})\\n  Retrieve a symbol's source and metadata.\\n\\nPATH GUIDANCE:\\n- index_folder with \"/projects/PROJECT_NAME\" is the preferred way to index a project.\\n- index_workspace resolves paths under the backend workspace root.\\n- For monorepos, you can index subfolders like \"server/src\", \"client/src\".\\n\\nUSE CASES:\\n- Quickly understand a large codebase before editing\\n- Locate auth, routing, service, and data-access logic\\n- Find all methods on a class\\n- Search conceptually (\"rate limiting\", \"token verification\", \"file upload flow\")\\n- Inspect exact source for a symbol before making changes"
  }
];