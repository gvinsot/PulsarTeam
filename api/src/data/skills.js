export const BUILTIN_SKILLS = [
  {
    "id": "skill-swarm-devops",
    "name": "Swarm DevOps",
    "description": "Deploy projects to the Docker Swarm cluster using the standard build & deploy pipeline",
    "category": "devops",
    "icon": "🚀",
    "builtin": true,
    "mcpServerIds": [
      "mcp-swarm-manager"
    ],
    "instructions": "You know how to integrate and deploy projects on the Swarm cluster.\n\nBuild and deploy operations are managed via MCP tools. The MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\nCall them using the @mcp_call(ServerName, tool_name, {\"param\": \"value\"}) syntax shown there.\n\n## DEPLOYMENT WORKFLOW\n\nFIRST TIME SETUP — If the project has no devops/ folder yet:\n   - Read the existing project structure and understand what needs to be containerized\n   - Create the devops/ folder with docker-compose.swarm.yml, .env, and optional pre/post scripts\n   - Commit and push: @git_commit_push(feat: add deployment config)\n\nIf you are asked to build:\n   - Use @mcp_call to call the build_stack tool with the repo name, ssh_url, and version\n   - Images are built from devops/docker-compose.swarm.yml\n   - Tagged with semantic version and pushed to the registry\n   - Check build progress with get_action_status\n   - Fix any build errors before proceeding\n\nIf you are asked to deploy a specific version:\n   - Use @mcp_call to call the deploy_stack tool with the repo name, ssh_url, and version\n   - Check deploy progress with get_action_status\n   - Verify services are running with list_stacks or list_containers\n\n## MONITORING\n- Use list_stacks to check service health\n- Use list_containers to check running containers\n- Use search_logs to investigate issues\n- Use list_computers to check node availability\n\n## IMPORTANT\n- Your workspace is EPHEMERAL. Always @git_commit_push(message) after completing changes to preserve your work."
  },
  {
    "id": "skill-basic-tools",
    "name": "Basic Tools",
    "description": "Essential tools for reading, writing, searching files and running commands",
    "category": "general",
    "icon": "🔧",
    "builtin": true,
    "instructions": "## TOOLS — USE THEM, DON'T JUST TALK\n- @read_file(path) — examine existing code\n- @list_dir(path) — explore project structure\n- @write_file(path, \"\"\"content\"\"\") — create or update files\n- @search_files(pattern, query) — find relevant code\n- @run_command(command) — run tests, builds, git commands, etc.\n- @list_my_tasks() — list your assigned tasks with their status and ID\n- @update_todo(todoId, status) — update a task status (in_progress, done, error)\n- Use @run_command to execute git commands\n\nWORKFLOW:\n1. Always start by exploring the project structure with @list_dir(.)\n2. Study existing files and code conventions BEFORE writing anything — match naming, formatting, patterns, and folder organization already in use\n3. Read existing files before modifying them with @read_file(path)\n4. Write changes with @write_file(path, \"\"\"content\"\"\") — follow the existing code style\n5. Verify your changes by reading the file back\n6. Run tests or builds with @run_command(npm test) or similar\n7. Use @search_files(*.js, keyword) to find relevant code across the project\n\nIMPORTANT:\n- Each tool call MUST be on its own line\n- Do NOT add decorative text before tool calls — just call the tool directly\n- NEVER stop yourself — keep working until the task is fully complete\n- Your workspace is EPHEMERAL. Always @git_commit_push(message) after completing changes to preserve your work.\n- GIT COMMITS: Always include your agent name in the commit message. Format: \"message (by YourName)\" — e.g. @git_commit_push(feat: add login page (by Developer))"
  },
  {
    "id": "skill-delegation",
    "name": "Delegation & Management",
    "description": "Delegate tasks to other agents, assign projects, and manage agent context",
    "category": "general",
    "icon": "👥",
    "builtin": true,
    "instructions": "You can delegate tasks to other agents and manage them.\n\n## DELEGATION\n@delegate(AgentName, \"detailed task description with specific file paths when possible\")\n\nExamples:\n@delegate(Developer, \"Read the auth module at src/auth/ and implement password reset functionality\")\n@delegate(Security Analyst, \"Scan the codebase for SQL injection vulnerabilities and fix any found\")\n@delegate(QA Engineer, \"Write unit tests for the user service and run them\")\n\nPlease do one delegate per task.\nAfter delegations complete, you will receive the results and should synthesize them.\n\n## PROJECT ASSIGNMENT\n@assign_project(AgentName, \"project_name\") — Assign an agent to a project so they can use file and command tools on it. Context is automatically saved and restored per-project.\n\nExample:\n@assign_project(Developer, \"MyWebApp\")\n\n## AGENT MANAGEMENT\n@get_project(AgentName) — Check which project an agent is currently working on.\n@clear_context(AgentName) — Clear an agent's conversation history for a fresh start.\n@rollback(AgentName, X) — Remove the last X messages from an agent's history.\n@stop_agent(AgentName) — Stop an agent's current task immediately.\n@list_projects() — List all available projects.\n@list_agents() — List all enabled agents with their current status, project, role, and current task (if busy).\n@agent_status(AgentName) — Check a specific agent's status (busy/idle/error), project, current task, pending todos, and message count.\n@clear_all_chats() — Clear ALL agents' conversation histories at once.\n@clear_all_action_logs() — Clear ALL agents' action logs at once.\n@get_available_agent(role) — Get the first idle agent with the specified role (e.g. \"developer\"). Returns agent name, status, and project.\n\nExamples:\n@get_project(Developer)\n@clear_context(QA Engineer)\n@rollback(Developer, 4)\n@stop_agent(Developer)\n@list_projects()\n@list_agents()\n@agent_status(Developer)\n@clear_all_chats()\n@clear_all_action_logs()\n@get_available_agent(developer)"
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
    "instructions": "You can interact with Microsoft OneDrive files using the OneDrive MCP tools.\n\n## AVAILABLE TOOLS\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\nCall them using the @mcp_call(ServerName, tool_name, {\"param\": \"value\"}) syntax shown there.\n\n## OneDrive MCP Tools Reference\n\n@mcp_call(OneDrive, list_files, {\"path\": \"/\", \"top\": 50})\n  — List files and folders at a given path. Use \"/\" for the root directory.\n\n@mcp_call(OneDrive, search_files, {\"query\": \"keyword\", \"top\": 25})\n  — Search for files by name or content across the entire OneDrive.\n\n@mcp_call(OneDrive, read_file, {\"path\": \"/Documents/notes.txt\"})\n  — Read the text content of a file. Works best with text-based files (txt, json, md, csv, etc.).\n\n@mcp_call(OneDrive, get_file_info, {\"path\": \"/Documents/report.pdf\"})\n  — Get detailed metadata about a file or folder (size, type, modified date, web URL).\n\n@mcp_call(OneDrive, create_folder, {\"parentPath\": \"/\", \"name\": \"NewFolder\"})\n  — Create a new folder. parentPath is where to create it.\n\n@mcp_call(OneDrive, upload_file, {\"path\": \"/Documents/file.txt\", \"content\": \"Hello World\"})\n  — Upload or create a text file (up to 4MB).\n\n@mcp_call(OneDrive, delete_item, {\"path\": \"/Documents/old-file.txt\"})\n  — Delete a file or folder (moves to recycle bin).\n\n@mcp_call(OneDrive, get_share_link, {\"path\": \"/Documents/report.pdf\", \"type\": \"view\"})\n  — Create a sharing link. type can be \"view\" (read-only) or \"edit\" (read-write).\n\n@mcp_call(OneDrive, get_drive_info, {})\n  — Get OneDrive storage info (space used, remaining, owner).\n\n## USAGE GUIDELINES\n- Always start by listing the root directory to orient yourself: @mcp_call(OneDrive, list_files, {\"path\": \"/\"})\n- Use search_files to find specific files when you don't know the exact path\n- Use get_file_info to check file details before reading large files\n- Paths use forward slashes and start from the root: /Documents/subfolder/file.txt\n- When the user asks about \"my files\" or \"my documents\", start by listing the root\n- For binary files (images, PDFs), provide the web URL or share link instead of reading content\n- Be cautious with delete_item — always confirm with the user before deleting"
  },
  {
    "id": "skill-agents-direct-access",
    "name": "Agents Direct Access",
    "description": "Ask quick questions to other agents without creating tasks",
    "category": "general",
    "icon": "💬",
    "builtin": true,
    "instructions": "You can ask questions directly to other agents in the swarm.\n\n## DIRECT QUESTIONS\n@ask(AgentName, \"your question here\")\n\nUse this for quick answers — no task is created on the target agent.\nThe target agent will receive your question and respond concisely.\nTheir answer will be provided back to you inline.\n\nWHEN TO USE @ask vs @delegate:\n- @ask: quick questions (\"What framework is used?\", \"Did the tests pass?\")\n- @delegate (leaders only): full tasks requiring work\n\nExamples:\n@ask(Developer, \"What testing framework is configured in this project?\")\n@ask(Security Analyst, \"Are there known vulnerabilities in express 4.21?\")\n@ask(QA Engineer, \"Did the last test run pass?\")\n\nRULES:\n- One @ask per question\n- Keep questions concise and specific\n- The target agent will give a brief answer — this is not for delegating work",
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
    "instructions": "You can use the internal Code Index plugin to explore codebases faster than raw grep alone.\n\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\nCall them using the @mcp_call(Code Index, tool_name, {\"param\": \"value\"}) syntax.\n\nRECOMMENDED WORKFLOW:\n1. BEFORE any search, call @mcp_call(Code Index, list_repos, {}) to check if your current project is already indexed.\n2. If the current project appears in the list, reuse its repoId — do NOT re-index.\n3. If the current project is NOT in the list, index it first:\n   - @mcp_call(Code Index, index_folder, {\"path\": \"/projects/YOUR_PROJECT_NAME\", \"repoName\": \"YOUR_PROJECT_NAME\"})\n   - Use the project name from the PROJECT CONTEXT section of your prompt.\n4. Search symbols or semantics first, then fetch outlines/source for the best matches.\n5. Fall back to normal file tools when you need to edit files.\n\nMOST USEFUL TOOLS:\n- @mcp_call(Code Index, list_repos, {})\n  List all indexed repositories and their repoIds. ALWAYS call this first.\n- @mcp_call(Code Index, index_folder, {\"path\": \"/projects/MyProject\", \"repoName\": \"MyProject\"})\n  Index a project folder. Use the project name from your PROJECT CONTEXT.\n- @mcp_call(Code Index, index_workspace, {\"subpath\": \"server/src\", \"repoName\": \"server-src\"})\n  Index the current application workspace or a subfolder under it.\n- @mcp_call(Code Index, search_symbols, {\"repoId\": \"...\", \"query\": \"authenticateToken\", \"topK\": 5})\n  Find classes, functions, and methods by lexical match.\n- @mcp_call(Code Index, search_semantic, {\"repoId\": \"...\", \"query\": \"JWT auth middleware\", \"topK\": 5})\n  Find relevant code by meaning.\n- @mcp_call(Code Index, get_file_outline, {\"repoId\": \"...\", \"filePath\": \"src/middleware/auth.js\"})\n  Inspect all symbols in a file.\n- @mcp_call(Code Index, get_symbol, {\"repoId\": \"...\", \"symbolId\": \"...\", \"verify\": true, \"contextLines\": 2})\n  Retrieve a symbol's source and metadata.\n\nPATH GUIDANCE:\n- index_folder with \"/projects/PROJECT_NAME\" is the preferred way to index a project.\n- index_workspace resolves paths under the backend workspace root.\n- For monorepos, you can index subfolders like \"server/src\", \"client/src\".\n\nUSE CASES:\n- Quickly understand a large codebase before editing\n- Locate auth, routing, service, and data-access logic\n- Find all methods on a class\n- Search conceptually (\"rate limiting\", \"token verification\", \"file upload flow\")\n- Inspect exact source for a symbol before making changes"
  }
];
