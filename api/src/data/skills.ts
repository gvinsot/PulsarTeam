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

DOCUMENT CONVERSION — pandoc is installed. Before reading large non-text documents, convert them to markdown first:
  @run_command(pandoc document.docx -t markdown -o document.md)
  Supported formats: .docx, .pptx, .xlsx, .odt, .ods, .odp, .epub, .rst, .tex, .latex, .html, .rtf, .csv, .tsv, .json, .xml
  After conversion, use @read_file(document.md) to read the content.
  For spreadsheets (.xlsx, .ods, .csv), the output will be markdown tables.

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
    "id": "skill-gmail",
    "name": "Gmail",
    "description": "Read, search, send, reply, and manage emails in Gmail via the Gmail API (per-agent OAuth)",
    "category": "general",
    "icon": "📧",
    "builtin": true,
    "mcpServerIds": [
      "mcp-gmail"
    ],
    "instructions": "You can interact with Gmail using the Gmail MCP tools.\n\n## AVAILABLE TOOLS\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\nCall them using the @mcp_call(ServerName, tool_name, {\"param\": \"value\"}) syntax shown there.\n\n## Gmail MCP Tools Reference\n\n@mcp_call(Gmail, get_profile, {})\n  — Get the connected Gmail account profile (email address, total messages).\n\n@mcp_call(Gmail, list_emails, {\"maxResults\": 20, \"labelIds\": \"INBOX\"})\n  — List recent emails. Optional: query (Gmail search syntax), labelIds (INBOX, SENT, STARRED, UNREAD, DRAFT).\n\n@mcp_call(Gmail, search_emails, {\"query\": \"from:alice subject:report\", \"maxResults\": 20})\n  — Search emails using Gmail search syntax. Supports all Gmail operators: from:, to:, subject:, has:, is:, after:, before:, etc.\n\n@mcp_call(Gmail, read_email, {\"messageId\": \"MESSAGE_ID\"})\n  — Read the full content of a specific email (headers, body, attachments info).\n\n@mcp_call(Gmail, send_email, {\"to\": \"bob@example.com\", \"subject\": \"Hello\", \"body\": \"Message content\"})\n  — Send a new email. Optional: cc, bcc, attachments.\n  Attach files by passing attachments: [{\"filename\": \"report.pdf\", \"mimeType\": \"application/pdf\", \"content\": \"<base64>\"}].\n  The content field must be standard base64-encoded file data.\n\n@mcp_call(Gmail, reply_to_email, {\"messageId\": \"MESSAGE_ID\", \"body\": \"Reply content\"})\n  — Reply to an existing email, maintaining the thread. Optional: replyAll (default: false), attachments (same format as send_email).\n\n@mcp_call(Gmail, create_draft, {\"to\": \"bob@example.com\", \"subject\": \"Draft\", \"body\": \"Content\"})\n  — Create a draft email without sending it. Optional: cc, bcc, attachments (same format as send_email).\n\n@mcp_call(Gmail, download_attachment, {\"messageId\": \"MSG_ID\", \"attachmentId\": \"ATTACH_ID\", \"filename\": \"file.pdf\"})\n  — Download an attachment from an email. Returns the file content as base64. Get the attachmentId from read_email.\n\n@mcp_call(Gmail, list_labels, {})\n  — List all Gmail labels (folders/categories).\n\n@mcp_call(Gmail, modify_labels, {\"messageId\": \"MSG_ID\", \"addLabelIds\": \"STARRED\", \"removeLabelIds\": \"UNREAD\"})\n  — Add or remove labels. Use to mark read/unread, star/unstar, archive, etc.\n  Common: remove UNREAD to mark as read, remove INBOX to archive, add STARRED to star.\n\n@mcp_call(Gmail, trash_email, {\"messageId\": \"MESSAGE_ID\"})\n  — Move an email to the trash.\n\n@mcp_call(Gmail, get_thread, {\"threadId\": \"THREAD_ID\"})\n  — Get all messages in a conversation thread.\n\n## USAGE GUIDELINES\n- Always start by checking the profile: @mcp_call(Gmail, get_profile, {})\n- Use search_emails with Gmail search syntax for powerful filtering\n- When asked to read emails, first list_emails then read_email for specific ones\n- For conversations, use get_thread to see the full email chain\n- Always confirm with the user before sending emails\n- Be cautious with trash_email — confirm before deleting\n- Use modify_labels to organize: mark as read, star, archive, etc."
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
  },
  {
    "id": "skill-slack",
    "name": "Slack",
    "description": "Read channels, send messages, reply in threads, list users, and react to messages in Slack (per-agent OAuth)",
    "category": "general",
    "icon": "💬",
    "builtin": true,
    "mcpServerIds": [
      "mcp-slack"
    ],
    "instructions": "You can interact with Slack using the Slack MCP tools.\\n\\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\\nCall them using the @mcp_call(Slack, tool_name, {\"param\": \"value\"}) syntax shown there.\\n\\n## Slack MCP Tools Reference\\n\\n@mcp_call(Slack, list_channels, {\"types\": \"public_channel\", \"limit\": 100})\\n  — List channels the bot has access to. types: public_channel, private_channel, mpim, im.\\n\\n@mcp_call(Slack, read_channel, {\"channel\": \"C01234ABCDE\", \"limit\": 20})\\n  — Read recent messages from a channel. Returns messages with timestamps and users.\\n\\n@mcp_call(Slack, read_thread, {\"channel\": \"C01234ABCDE\", \"thread_ts\": \"1234567890.123456\", \"limit\": 50})\\n  — Read all replies in a message thread.\\n\\n@mcp_call(Slack, send_message, {\"channel\": \"C01234ABCDE\", \"text\": \"Hello!\"})\\n  — Send a message to a channel or user. Supports Slack mrkdwn formatting.\\n  Optional: thread_ts (to reply in a thread).\\n\\n@mcp_call(Slack, reply_to_message, {\"channel\": \"C01234ABCDE\", \"thread_ts\": \"1234567890.123456\", \"text\": \"Reply content\"})\\n  — Reply to a specific message in a thread.\\n\\n@mcp_call(Slack, list_users, {\"limit\": 100})\\n  — List workspace members with display names, status, and IDs.\\n\\n@mcp_call(Slack, search_messages, {\"query\": \"keyword\", \"count\": 20})\\n  — Search messages across the workspace. Supports Slack search operators: in:#channel, from:@user.\\n  Note: requires search:read scope, may not be available with all bot tokens.\\n\\n@mcp_call(Slack, get_channel_info, {\"channel\": \"C01234ABCDE\"})\\n  — Get detailed info about a channel (topic, purpose, member count, etc.).\\n\\n@mcp_call(Slack, add_reaction, {\"channel\": \"C01234ABCDE\", \"timestamp\": \"1234567890.123456\", \"name\": \"thumbsup\"})\\n  — Add an emoji reaction to a message. Use emoji name without colons.\\n\\n@mcp_call(Slack, open_dm, {\"user\": \"U01234ABCDE\"})\\n  — Open a DM channel with a user. Returns the DM channel ID for sending messages.\\n\\n## USAGE GUIDELINES\\n- Always start by listing channels: @mcp_call(Slack, list_channels, {})\\n- Use channel IDs (not names) for all operations\\n- When asked to read a channel, use list_channels first to find the ID, then read_channel\\n- For DMs, first open_dm to get the channel ID, then send_message\\n- Always confirm with the user before sending messages\\n- Use add_reaction to acknowledge messages without cluttering the channel\\n- Use threads (reply_to_message) to keep conversations organized"
  },
  {
    "id": "skill-jira",
    "name": "Jira",
    "description": "Search, create, update, and manage Jira issues, boards, sprints, and comments (per-agent API key)",
    "category": "general",
    "icon": "🎫",
    "builtin": true,
    "mcpServerIds": [
      "mcp-jira"
    ],
    "instructions": "You can interact with Jira using the Jira MCP tools.\n\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\nCall them using the @mcp_call(Jira, tool_name, {\"param\": \"value\"}) syntax shown there.\n\n## Jira MCP Tools Reference\n\n@mcp_call(Jira, get_myself, {})\n  — Get the authenticated Jira user profile.\n\n@mcp_call(Jira, list_projects, {})\n  — List all accessible Jira projects.\n\n@mcp_call(Jira, search_issues, {\"jql\": \"project = PROJ AND status = 'In Progress'\", \"maxResults\": 20})\n  — Search issues using JQL. Supports all JQL operators.\n\n@mcp_call(Jira, get_issue, {\"issueKey\": \"PROJ-123\"})\n  — Get full issue details (description, comments, attachments, subtasks).\n\n@mcp_call(Jira, create_issue, {\"projectKey\": \"PROJ\", \"summary\": \"New task\", \"description\": \"Details\", \"issueType\": \"Task\"})\n  — Create a new issue. issueType: Task, Bug, Story, Epic, Sub-task.\n\n@mcp_call(Jira, update_issue, {\"issueKey\": \"PROJ-123\", \"summary\": \"Updated title\"})\n  — Update issue fields (summary, description, priority, assignee, labels).\n\n@mcp_call(Jira, add_comment, {\"issueKey\": \"PROJ-123\", \"comment\": \"My comment\"})\n  — Add a comment to an issue.\n\n@mcp_call(Jira, transition_issue, {\"issueKey\": \"PROJ-123\"})\n  — List available transitions. Add transitionId to execute one.\n  Example: @mcp_call(Jira, transition_issue, {\"issueKey\": \"PROJ-123\", \"transitionId\": \"31\"})\n\n@mcp_call(Jira, list_boards, {})\n  — List all Jira boards (Scrum/Kanban).\n\n@mcp_call(Jira, get_board_columns, {\"boardId\": 1})\n  — Get board columns/statuses.\n\n@mcp_call(Jira, get_sprint, {\"boardId\": 1})\n  — Get active sprint with issues.\n\n@mcp_call(Jira, assign_issue, {\"issueKey\": \"PROJ-123\", \"accountId\": \"abc123\"})\n  — Assign or unassign an issue.\n\n## USAGE GUIDELINES\n- Start by listing projects: @mcp_call(Jira, list_projects, {})\n- Use JQL for powerful searches: status, assignee, labels, sprint, dates\n- Before transitioning, call transition_issue without transitionId to see options\n- Always confirm with the user before creating issues or modifying data\n- Use get_issue to read full details before making updates"
  },
  {
    "id": "skill-github",
    "name": "GitHub",
    "description": "Browse repos, manage issues and PRs, search code, view commits and CI workflows (per-agent OAuth)",
    "category": "devops",
    "icon": "🐙",
    "builtin": true,
    "mcpServerIds": [
      "mcp-github"
    ],
    "instructions": "You can interact with GitHub using the GitHub MCP tools.\n\nThe MCP tools are listed in the \"--- MCP Tools ---\" section of your prompt.\nCall them using the @mcp_call(GitHub, tool_name, {\"param\": \"value\"}) syntax shown there.\n\n## GitHub MCP Tools Reference\n\n@mcp_call(GitHub, get_authenticated_user, {})\n  — Get the authenticated GitHub user profile.\n\n@mcp_call(GitHub, list_repos, {\"type\": \"all\", \"sort\": \"updated\", \"per_page\": 30})\n  — List repositories accessible to the authenticated user.\n\n@mcp_call(GitHub, get_repo, {\"owner\": \"octocat\", \"repo\": \"hello-world\"})\n  — Get detailed info about a specific repository.\n\n@mcp_call(GitHub, list_issues, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"state\": \"open\"})\n  — List issues. Filter by state, labels, assignee.\n\n@mcp_call(GitHub, get_issue, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"issue_number\": 1})\n  — Get full issue details with comments.\n\n@mcp_call(GitHub, create_issue, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"title\": \"Bug report\", \"body\": \"Details\"})\n  — Create a new issue.\n\n@mcp_call(GitHub, update_issue, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"issue_number\": 1, \"state\": \"closed\"})\n  — Update an issue (title, body, state, labels, assignees).\n\n@mcp_call(GitHub, add_issue_comment, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"issue_number\": 1, \"body\": \"Comment\"})\n  — Add a comment to an issue or PR.\n\n@mcp_call(GitHub, list_pull_requests, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"state\": \"open\"})\n  — List pull requests.\n\n@mcp_call(GitHub, get_pull_request, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"pull_number\": 1})\n  — Get full PR details with review status.\n\n@mcp_call(GitHub, create_pull_request, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"title\": \"Feature\", \"head\": \"feature-branch\", \"base\": \"main\"})\n  — Create a new pull request.\n\n@mcp_call(GitHub, list_branches, {\"owner\": \"octocat\", \"repo\": \"hello-world\"})\n  — List branches in a repository.\n\n@mcp_call(GitHub, get_file_content, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"path\": \"README.md\"})\n  — Get file or directory content.\n\n@mcp_call(GitHub, search_code, {\"query\": \"repo:octocat/hello-world function main\"})\n  — Search for code across repos.\n\n@mcp_call(GitHub, list_commits, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"per_page\": 10})\n  — List recent commits.\n\n@mcp_call(GitHub, list_workflows, {\"owner\": \"octocat\", \"repo\": \"hello-world\"})\n  — List GitHub Actions workflows.\n\n@mcp_call(GitHub, list_workflow_runs, {\"owner\": \"octocat\", \"repo\": \"hello-world\", \"per_page\": 5})\n  — List recent CI/CD workflow runs.\n\n## USAGE GUIDELINES\n- Start by listing repos: @mcp_call(GitHub, list_repos, {})\n- Use search_code for finding code across repositories\n- Check workflow runs to monitor CI/CD status\n- Always confirm with the user before creating issues, PRs, or modifying data"
  },
  {
    "id": "skill-web-browser",
    "name": "Web Browser",
    "description": "Search, crawl and extract content from the web. Cloudflare-protected pages are bypassed via FlareSolverr.",
    "category": "general",
    "icon": "🌍",
    "builtin": true,
    "mcpServerIds": [
      "mcp-browser"
    ],
    "instructions": `You can browse the internet using the Web Browser MCP tools. Pages protected by Cloudflare or other bot-detection systems are automatically bypassed via FlareSolverr.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Call them using the @mcp_call(Web Browser, tool_name, {"param": "value"}) syntax shown there.

## AVAILABLE TOOLS

@mcp_call(Web Browser, search_web, {"query": "best practices docker swarm 2026"})
  — Search the web (DuckDuckGo) and get the results page as clean Markdown. Use this first to discover relevant URLs.

@mcp_call(Web Browser, crawl, {"url": "https://example.com/article"})
  — Crawl a single page and return its main content as clean Markdown (boilerplate, nav, footer, ads filtered out).
  Optional: word_count_threshold (default 10) to control how aggressively short blocks are dropped.

@mcp_call(Web Browser, crawl_many, {"urls": ["https://a.com", "https://b.com"]})
  — Crawl several pages in parallel. Use this when you need to compare or aggregate sources.

@mcp_call(Web Browser, get_links, {"url": "https://example.com"})
  — List all hyperlinks on a page (internal and external), filtered to ignore nav/footer noise.

@mcp_call(Web Browser, extract, {"url": "https://example.com/products", "instruction": "Extract product name and price for each item"})
  — Use the configured LLM to extract structured information from a page.
  Optional: schema_json — provide a JSON schema string to force structured JSON output.

## RECOMMENDED WORKFLOW

1. Start with @mcp_call(Web Browser, search_web, {"query": "..."}) to find candidate URLs.
2. Pick 1–3 promising URLs from the search results, then @mcp_call(Web Browser, crawl, ...) (or crawl_many) to read their content.
3. Use @mcp_call(Web Browser, extract, ...) only when you need structured data (tables, product lists, etc.) — for prose, plain crawl + your own reading is faster.
4. Use @mcp_call(Web Browser, get_links, ...) when you need to follow references from a starting page.

## IMPORTANT
- Always cite the source URL when returning information you got from the web.
- Prefer crawl over extract when you only need to read a page — it's faster and cheaper.
- Cloudflare / bot-blocked pages are handled transparently; if a crawl fails, retry once before giving up.
- Never use this tool to perform side effects (form submissions, logins). It is read-only by design.`
  },
  {
    "id": "skill-aws-s3",
    "name": "AWS S3",
    "description": "Browse buckets, read/write/delete objects, generate presigned URLs, and manage files on Amazon S3",
    "category": "cloud",
    "icon": "🪣",
    "builtin": true,
    "mcpServerIds": [
      "mcp-aws-s3"
    ],
    "instructions": `You can interact with Amazon S3 using the AWS S3 MCP tools.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Call them using the @mcp_call(AWS S3, tool_name, {"param": "value"}) syntax shown there.

## AWS S3 MCP Tools Reference

@mcp_call(AWS S3, list_buckets, {})
  — List all S3 buckets in the account.

@mcp_call(AWS S3, list_objects, {"bucket": "my-bucket", "prefix": "data/", "max_keys": 100})
  — List objects in a bucket. Filter by prefix, paginate with continuation_token.

@mcp_call(AWS S3, get_object, {"bucket": "my-bucket", "key": "data/report.json"})
  — Read the content of an object (text files). For large/binary files, use get_presigned_url.

@mcp_call(AWS S3, put_object, {"bucket": "my-bucket", "key": "data/output.json", "content": "{}", "content_type": "application/json"})
  — Upload text content to an object. Creates or overwrites.

@mcp_call(AWS S3, delete_object, {"bucket": "my-bucket", "key": "data/old-file.txt"})
  — Delete an object from a bucket.

@mcp_call(AWS S3, copy_object, {"source_bucket": "src-bucket", "source_key": "file.txt", "dest_bucket": "dst-bucket", "dest_key": "copy.txt"})
  — Copy an object within or between buckets.

@mcp_call(AWS S3, get_object_info, {"bucket": "my-bucket", "key": "data/file.pdf"})
  — Get metadata about an object (size, type, last modified) without downloading.

@mcp_call(AWS S3, get_presigned_url, {"bucket": "my-bucket", "key": "data/large-file.zip", "operation": "get", "expires_in": 3600})
  — Generate a presigned URL for download ("get") or upload ("put"). Default 1 hour.

@mcp_call(AWS S3, create_bucket, {"bucket": "new-bucket-name", "region": "eu-west-1"})
  — Create a new S3 bucket.

## USAGE GUIDELINES
- Start by listing buckets: @mcp_call(AWS S3, list_buckets, {})
- Use list_objects with prefix to browse bucket contents like a file system
- Use get_object for text files, get_presigned_url for binary/large files
- Always confirm with the user before deleting objects or creating buckets
- Bucket names must be globally unique, lowercase, 3-63 characters
- Use prefix (e.g. "folder/") to organize objects — S3 has no real folders
- For large result sets, use the continuation_token from the previous response`
  },
  {
    "id": "skill-auto-learn",
    "name": "Auto Learn",
    "description": "Shared skill library — agents can create, search, update, and reuse learned knowledge and procedures",
    "category": "general",
    "icon": "🎓",
    "builtin": true,
    "mcpServerIds": [
      "mcp-auto-learn"
    ],
    "instructions": `You have access to a shared skill library where you can learn, store, and retrieve reusable knowledge.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Call them using the @mcp_call(Auto Learn, tool_name, {"param": "value"}) syntax shown there.

## AVAILABLE TOOLS

@mcp_call(Auto Learn, list_skills, {})
  — List all skills in the shared library.

@mcp_call(Auto Learn, search_skills, {"query": "deployment"})
  — Search for existing skills by keyword. Matches name, description, category, and instructions.

@mcp_call(Auto Learn, get_skill, {"skill_id": "agent-skill-..."})
  — Get the full details and instructions of a specific skill.

@mcp_call(Auto Learn, create_skill, {"name": "Fix CORS Issues", "description": "Step-by-step guide to diagnose and fix CORS errors", "category": "coding", "instructions": "..."})
  — Create a new skill with detailed instructions. Categories: coding, devops, writing, security, analysis, general.

@mcp_call(Auto Learn, update_skill, {"skill_id": "agent-skill-...", "instructions": "Updated instructions..."})
  — Update an existing skill (name, description, category, or instructions).

@mcp_call(Auto Learn, delete_skill, {"skill_id": "agent-skill-..."})
  — Delete a skill from the library.

## WHEN TO USE

### Learning (creating/updating skills)
- After solving a complex or non-obvious problem, capture the solution as a skill
- When you discover a project-specific pattern or convention that other agents should know
- When you find a useful debugging technique or workaround
- When a deployment or configuration procedure is not documented elsewhere

### Searching (finding existing skills)
- Before tackling a new problem, search for relevant skills that might help
- When asked to do something you haven't done before in this project
- When you need project-specific conventions or procedures

## BEST PRACTICES
- Always search before creating �� avoid duplicates
- Write clear, actionable instructions with concrete examples
- Include the "why" alongside the "how" — context helps other agents apply the skill correctly
- Keep skills focused on one topic — split broad knowledge into multiple skills
- Update skills when you discover better approaches`
  }
];