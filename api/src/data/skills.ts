export const BUILTIN_SKILLS = [
  {
    id: 'skill-swarm-reader',
    name: 'Swarm Reader',
    description: 'Monitor Docker Swarm stacks, containers, hosts and search logs via PulsarCD Read',
    category: 'devops',
    icon: '📊',
    builtin: true,
    mcpServerIds: ['mcp-pulsarcd-read'],
    instructions: `You can monitor the Docker Swarm cluster using the PulsarCD Read MCP tools (read-only).

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Use the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.

## AVAILABLE TOOLS

the native mcp_call tool (server: PulsarCD Read; tool: list_stacks; arguments: {})
  — List all available stacks (GitHub starred repos).

the native mcp_call tool (server: PulsarCD Read; tool: list_containers; arguments: {"host": "optional", "status": "optional"})
  — List containers and their state. Filter by host or status.

the native mcp_call tool (server: PulsarCD Read; tool: list_computers; arguments: {})
  — List all monitored hosts/machines.

the native mcp_call tool (server: PulsarCD Read; tool: get_log_metadata; arguments: {})
  — Discover available services, containers, hosts, and log levels.

the native mcp_call tool (server: PulsarCD Read; tool: search_logs; arguments: {"query": "error", "last_hours": 24})
  — Search collected logs. Supports filters: query, github_project, compose_services, hosts, containers, levels, http_status_min, http_status_max, last_hours, start_time, end_time, opensearch_query, size.

the native mcp_call tool (server: PulsarCD Read; tool: get_action_status; arguments: {"action_id": "ACTION_ID"})
  — Check the status of a build/deploy action.

## MONITORING WORKFLOW
1. Use the native mcp_call tool (server: PulsarCD Read; tool: list_stacks; arguments: {}) to see all deployed projects
2. Use the native mcp_call tool (server: PulsarCD Read; tool: list_containers; arguments: {}) to check running containers
3. Use the native mcp_call tool (server: PulsarCD Read; tool: search_logs; arguments: {"query": "error", "last_hours": 24}) to investigate issues
4. Use the native mcp_call tool (server: PulsarCD Read; tool: list_computers; arguments: {}) to check node availability
5. Use the native mcp_call tool (server: PulsarCD Read; tool: get_log_metadata; arguments: {}) to discover available log sources before searching`,
  },
  {
    id: 'skill-swarm-actions',
    name: 'Swarm Actions',
    description: 'Build, test and deploy stacks on Docker Swarm via PulsarCD Actions',
    category: 'devops',
    icon: '🚀',
    builtin: true,
    mcpServerIds: ['mcp-pulsarcd-actions', 'mcp-gandi-dns'],
    instructions: `You can build, test, and deploy projects on the Docker Swarm cluster using PulsarCD Actions MCP tools.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Use the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.

## BUILD & DEPLOY TOOLS (PulsarCD Actions)

the native mcp_call tool (server: PulsarCD Actions; tool: build_stack; arguments: {"repo_name": "my-app", "ssh_url": "git@github.com:org/my-app.git", "version": "1.2.0", "branch": "main"})
  — Build a Docker image from a GitHub repo. Optional: branch, commit.

the native mcp_call tool (server: PulsarCD Actions; tool: test_stack; arguments: {"repo_name": "my-app", "ssh_url": "git@github.com:org/my-app.git", "branch": "main"})
  — Run tests for a stack (docker-compose.swarm.yml test target). Optional: branch, tag, commit.

the native mcp_call tool (server: PulsarCD Actions; tool: deploy_stack; arguments: {"repo_name": "my-app", "ssh_url": "git@github.com:org/my-app.git", "version": "1.2.0"})
  — Deploy a stack on Docker Swarm. Optional: tag.

All three tools return an action_id. Use get_action_status on the Read server to track progress.

## MONITORING TOOLS (PulsarCD Read)

the native mcp_call tool (server: PulsarCD Read; tool: get_action_status; arguments: {"action_id": "ACTION_ID"})
  — Check the status of a build/test/deploy action.

the native mcp_call tool (server: PulsarCD Read; tool: list_stacks; arguments: {})
  — List all available stacks.

the native mcp_call tool (server: PulsarCD Read; tool: list_containers; arguments: {})
  — List containers and their state.

the native mcp_call tool (server: PulsarCD Read; tool: search_logs; arguments: {"query": "error", "last_hours": 1})
  — Search logs to investigate issues after deployment.

## DEPLOYMENT WORKFLOW

FIRST TIME SETUP — If the project has no devops/ folder yet:
   - Read the existing project structure and understand what needs to be containerized
   - Create the devops/ folder with docker-compose.swarm.yml, .env, and optional pre/post scripts
   - Commit and push: use cli

BUILD:
   1. Call the native mcp_call tool (server: PulsarCD Actions; tool: build_stack; arguments: {...}) with repo_name, ssh_url, and version
   2. Track progress: the native mcp_call tool (server: PulsarCD Read; tool: get_action_status; arguments: {"action_id": "ACTION_ID"})
   3. Fix any build errors before proceeding

TEST:
   1. Call the native mcp_call tool (server: PulsarCD Actions; tool: test_stack; arguments: {...}) with repo_name and ssh_url
   2. Track progress: the native mcp_call tool (server: PulsarCD Read; tool: get_action_status; arguments: {"action_id": "ACTION_ID"})

DEPLOY:
   1. Call the native mcp_call tool (server: PulsarCD Actions; tool: deploy_stack; arguments: {...}) with repo_name, ssh_url, and version
   2. Track progress: the native mcp_call tool (server: PulsarCD Read; tool: get_action_status; arguments: {"action_id": "ACTION_ID"})
   3. Verify: the native mcp_call tool (server: PulsarCD Read; tool: list_containers; arguments: {}) to check services are running

## IMPORTANT
- Your workspace is EPHEMERAL. Always commit and push after completing changes to preserve your work.
- Always check action status after build/test/deploy — do not assume success.`,
  },
  {
    id: 'skill-basic-tools',
    name: 'Basic Tools',
    description: 'Essential tools for reading, writing, searching files and running commands',
    category: 'general',
    icon: '🔧',
    builtin: true,
    instructions: `## NATIVE TOOLS
Use the structured tools supplied with the request for every action. Never write tool syntax in chat text.

- read_file: path, optional start_line and end_line. Examine existing code before changing it.
- list_dir: path. Explore the project structure first.
- list_projects: list the available projects.
- write_file: path and complete content. Follow the existing style.
- search_files: query and optional pattern. Find relevant code before editing.
- run_command: command. Run builds, tests, and Git commands.
- list_my_tasks: list assigned tasks and their statuses.
- update_task: task_id, status, comment, and optional commits. Move the task to its final workflow column with a complete summary when the work is done.

DOCUMENT CONVERSION
Pandoc is installed. Before reading a large non-text document, use run_command with a Pandoc conversion command, then read the generated Markdown file. Supported formats include .docx, .pptx, .xlsx, .odt, .ods, .odp, .epub, .rst, .tex, .latex, .html, .rtf, .csv, .tsv, .json, and .xml.

GIT WORKFLOW
Use run_command for Git operations. Commit and push completed work, including the agent name in the commit message. If a push is rejected because of remote changes, rebase before retrying. Commits are linked to the active task automatically.

WORKFLOW
1. Explore the structure and study existing conventions.
2. Read affected files before modifying them.
3. Make each change with write_file.
4. Read back changes and run the relevant tests or builds.
5. Commit and push the verified work.
6. Use update_task to move the assigned task to its final column and record a useful summary.

CRITICAL RULES
- Work one step at a time and wait for each tool result.
- Do not claim a file changed unless write_file completed successfully.
- Keep working until the task is genuinely complete.
- For a question task, research first, then put the full answer in update_task.comment while moving it to the final column.

CODE INDEX
When the Code Index MCP server is available, use native mcp_call with server "Code Index". Start with its list_repos tool, reuse an existing repo ID when possible, and otherwise index the current project before searching symbols or semantic matches.`,
  },
  {
    id: 'skill-delegation',
    name: 'Delegation & Management',
    description: 'Manage agents and create tasks via the Swarm API MCP tools',
    category: 'general',
    icon: '👥',
    builtin: true,
    mcpServerIds: ['mcp-swarm-api'],
    instructions: `You can manage agents and delegate work using the Swarm API MCP tools.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Use the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.

## AVAILABLE TOOLS

the native mcp_call tool (server: Swarm API; tool: list_agents; arguments: {})
  — List all agents with their status, role, project, current task, and open task count.
  Optional filters: {"project": "MyApp"} or {"status": "idle"}.

the native mcp_call tool (server: Swarm API; tool: get_agent_status; arguments: {"agent_name": "Developer"})
  — Get detailed status for a specific agent: current task, full task list, metrics.
  Use agent_name or agent_id.

the native mcp_call tool (server: Swarm API; tool: list_boards; arguments: {})
  — List all task boards with their workflow columns. Use this to discover board IDs before adding tasks.

the native mcp_call tool (server: Swarm API; tool: add_task; arguments: {"board_id": "<UUID>", "task": "Implement password reset in src/auth/"})
  — Add a task to a board. board_id is REQUIRED — use list_boards first.
  Tasks are always created unassigned on the board; any agent watching the board can pick them up.
  Optional: project, status (workflow column), repo_full_name, storage_path.

the native mcp_call tool (server: Swarm API; tool: search_tasks; arguments: {"query": "password reset", "only_completed": true, "limit": 20})
  — Search the task history with optional free-text query and filters.
  Optional filters: agent_id, agent_name, project, board_id, status, repo_full_name,
    created_after / created_before, completed_after / completed_before (ISO timestamps),
    only_completed (bool), include_deleted (bool), limit (default 50, max 200), offset.
  Use to dig up past work, check whether something has already been done, audit an agent's
  history, or find tasks similar to the one you are about to delegate.

## DELEGATION WORKFLOW

1. First, check available agents:
   the native mcp_call tool (server: Swarm API; tool: list_agents; arguments: {"status": "idle"})

2. Add tasks to a board (always pass board_id). Tasks are created unassigned and any agent watching the board can pick them up:
   the native mcp_call tool (server: Swarm API; tool: add_task; arguments: {"board_id": "<UUID>", "task": "Read src/auth/ and implement password reset", "project": "MyApp"})
   the native mcp_call tool (server: Swarm API; tool: add_task; arguments: {"board_id": "<UUID>", "task": "Write unit tests for the user service", "project": "MyApp"})
   the native mcp_call tool (server: Swarm API; tool: add_task; arguments: {"board_id": "<UUID>", "task": "Investigate flaky test in src/checkout/", "project": "MyApp"})

3. Monitor progress:
   the native mcp_call tool (server: Swarm API; tool: get_agent_status; arguments: {"agent_name": "Developer"})

## IMPORTANT
- Tasks are executed asynchronously — agents pick them up from their queue and work autonomously.
- board_id is ALWAYS required on add_task. Call list_boards first to discover IDs.
- add_task creates an UNASSIGNED task on the board. To assign work to a specific agent, the agent must pick the task up from the board itself — the MCP no longer supports targeting an agent at creation time.
- Check agent status to monitor task progress and verify completion.`,
  },
  {
    id: 'skill-onedrive',
    name: 'OneDrive',
    description:
      'Browse, search, read, upload, and manage files in Microsoft OneDrive via the Graph API',
    category: 'general',
    icon: '☁️',
    builtin: true,
    mcpServerIds: ['mcp-onedrive'],
    instructions:
      'You can interact with Microsoft OneDrive files using the OneDrive MCP tools.\\n\\n## AVAILABLE TOOLS\\nThe MCP tools are listed in the "--- MCP Tools ---" section of your prompt.\\nUse the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.\\n\\n## OneDrive MCP Tools Reference\\n\\nthe native mcp_call tool (server: OneDrive; tool: list_files; arguments: {"path": "/", "top": 50})\\n  — List files and folders at a given path. Use "/" for the root directory.\\n\\nthe native mcp_call tool (server: OneDrive; tool: search_files; arguments: {"query": "keyword", "top": 25})\\n  — Search for files by name or content across the entire OneDrive.\\n\\nthe native mcp_call tool (server: OneDrive; tool: read_file; arguments: {"path": "/Documents/notes.txt"})\\n  — Read the text content of a file. Works best with text-based files (txt, json, md, csv, etc.).\\n\\nthe native mcp_call tool (server: OneDrive; tool: get_file_info; arguments: {"path": "/Documents/report.pdf"})\\n  — Get detailed metadata about a file or folder (size, type, modified date, web URL).\\n\\nthe native mcp_call tool (server: OneDrive; tool: create_folder; arguments: {"parentPath": "/", "name": "NewFolder"})\\n  — Create a new folder. parentPath is where to create it.\\n\\nthe native mcp_call tool (server: OneDrive; tool: upload_file; arguments: {"path": "/Documents/file.txt", "content": "Hello World"})\\n  — Upload or create a text file (up to 4MB).\\n\\nthe native mcp_call tool (server: OneDrive; tool: delete_item; arguments: {"path": "/Documents/old-file.txt"})\\n  — Delete a file or folder (moves to recycle bin).\\n\\nthe native mcp_call tool (server: OneDrive; tool: get_share_link; arguments: {"path": "/Documents/report.pdf", "type": "view"})\\n  — Create a sharing link. type can be "view" (read-only) or "edit" (read-write).\\n\\nthe native mcp_call tool (server: OneDrive; tool: get_drive_info; arguments: {})\\n  — Get OneDrive storage info (space used, remaining, owner).\\n\\n## USAGE GUIDELINES\\n- Always start by listing the root directory to orient yourself: the native mcp_call tool (server: OneDrive; tool: list_files; arguments: {"path": "/"})\\n- Use search_files to find specific files when you don\'t know the exact path\\n- Use get_file_info to check file details before reading large files\\n- Paths use forward slashes and start from the root: /Documents/subfolder/file.txt\\n- When the user asks about "my files" or "my documents", start by listing the root\\n- For binary files (images, PDFs), provide the web URL or share link instead of reading content\\n- Be cautious with delete_item — always confirm with the user before deleting',
  },
  {
    id: 'skill-gdrive',
    name: 'Google Drive',
    description:
      'Browse, search, read, upload, share, and manage files in Google Drive (per-agent OAuth)',
    category: 'general',
    icon: '🗂️',
    builtin: true,
    mcpServerIds: ['mcp-gdrive'],
    instructions:
      'You can interact with Google Drive using the GoogleDrive MCP tools.\n\n## AVAILABLE TOOLS\nThe MCP tools are listed in the "--- MCP Tools ---" section of your prompt.\nUse the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.\n\n## GoogleDrive MCP Tools Reference\n\nthe native mcp_call tool (server: GoogleDrive; tool: get_drive_info; arguments: {})\n  — Get the connected account email and storage quota.\n\nthe native mcp_call tool (server: GoogleDrive; tool: list_files; arguments: {"path": "/", "pageSize": 50})\n  — List items in a folder. Use "/" for root, or pass a path like "/Documents". Alternative: pass "folderId".\n\nthe native mcp_call tool (server: GoogleDrive; tool: search_files; arguments: {"query": "report", "pageSize": 25})\n  — Search by name or content. Plain strings match name/full text. You can also use Drive query syntax: "mimeType = \'application/pdf\'", "name contains \'budget\'", "modifiedTime > \'2024-01-01\'".\n\nthe native mcp_call tool (server: GoogleDrive; tool: get_file_info; arguments: {"path": "/Documents/report.pdf"})\n  — Get detailed metadata (size, MIME, owners, sharing, web link). Accepts "path" or "fileId".\n\nthe native mcp_call tool (server: GoogleDrive; tool: read_file; arguments: {"path": "/Documents/notes.txt"})\n  — Read file content. Google Docs/Sheets/Slides are exported automatically to plain text or CSV. Binary files are returned base64-encoded. Optional: "fileId", "maxBytes".\n\nthe native mcp_call tool (server: GoogleDrive; tool: create_folder; arguments: {"name": "NewFolder", "parentPath": "/"})\n  — Create a folder. Alternative: pass "parentId".\n\nthe native mcp_call tool (server: GoogleDrive; tool: upload_file; arguments: {"name": "hello.txt", "content": "Hello", "parentPath": "/"})\n  — Upload a new file. For binary uploads pass "encoding": "base64". Optional: "mimeType", "parentId".\n\nthe native mcp_call tool (server: GoogleDrive; tool: delete_item; arguments: {"path": "/Documents/old.txt"})\n  — Move a file or folder to trash. Pass "permanent": true to delete permanently. Accepts "fileId" too.\n\nthe native mcp_call tool (server: GoogleDrive; tool: get_share_link; arguments: {"path": "/Documents/report.pdf", "type": "view"})\n  — Create/retrieve a sharing link. type can be "view" or "edit". Pass "anyoneWithLink": false to skip creating a public permission and just return the existing web link.\n\n## USAGE GUIDELINES\n- Start with the native mcp_call tool (server: GoogleDrive; tool: list_files; arguments: {"path": "/"}) to orient yourself.\n- Paths use forward slashes from the root: /Folder/Subfolder/file.ext\n- Path resolution is name-based — if multiple items share a name in the same folder, use the fileId instead.\n- For Google-native formats (Docs, Sheets, Slides), read_file returns plain text/CSV. Use get_share_link if the user needs to view the document.\n- Be cautious with delete_item — confirm with the user before deleting, and use "permanent": true only when explicitly requested.',
  },
  {
    id: 'skill-gmail',
    name: 'Gmail',
    description:
      'Read, search, send, reply, and manage emails in Gmail via the Gmail API (per-agent OAuth)',
    category: 'general',
    icon: '📧',
    builtin: true,
    mcpServerIds: ['mcp-gmail'],
    instructions:
      'You can interact with Gmail using the Gmail MCP tools.\n\n## AVAILABLE TOOLS\nThe MCP tools are listed in the "--- MCP Tools ---" section of your prompt.\nUse the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.\n\n## Gmail MCP Tools Reference\n\nthe native mcp_call tool (server: Gmail; tool: get_profile; arguments: {})\n  — Get the connected Gmail account profile (email address, total messages).\n\nthe native mcp_call tool (server: Gmail; tool: list_emails; arguments: {"maxResults": 20, "labelIds": "INBOX"})\n  — List recent emails. Optional: query (Gmail search syntax), labelIds (INBOX, SENT, STARRED, UNREAD, DRAFT).\n\nthe native mcp_call tool (server: Gmail; tool: search_emails; arguments: {"query": "from:alice subject:report", "maxResults": 20})\n  — Search emails using Gmail search syntax. Supports all Gmail operators: from:, to:, subject:, has:, is:, after:, before:, etc.\n\nthe native mcp_call tool (server: Gmail; tool: read_email; arguments: {"messageId": "MESSAGE_ID"})\n  — Read the full content of a specific email (headers, body, attachments info).\n\nthe native mcp_call tool (server: Gmail; tool: send_email; arguments: {"to": "bob@example.com", "subject": "Hello", "body": "Message content"})\n  — Send a new email. Optional: cc, bcc, attachments.\n  Attach files by passing attachments: [{"filename": "report.pdf", "mimeType": "application/pdf", "content": "<base64>"}].\n  The content field must be standard base64-encoded file data.\n\nthe native mcp_call tool (server: Gmail; tool: reply_to_email; arguments: {"messageId": "MESSAGE_ID", "body": "Reply content"})\n  — Reply to an existing email, maintaining the thread. Optional: replyAll (default: false), attachments (same format as send_email).\n\nthe native mcp_call tool (server: Gmail; tool: create_draft; arguments: {"to": "bob@example.com", "subject": "Draft", "body": "Content"})\n  — Create a draft email without sending it. Optional: cc, bcc, attachments (same format as send_email).\n\nthe native mcp_call tool (server: Gmail; tool: download_attachment; arguments: {"messageId": "MSG_ID", "attachmentId": "ATTACH_ID", "filename": "file.pdf"})\n  — Download an attachment from an email. Returns the file content as base64. Get the attachmentId from read_email.\n\nthe native mcp_call tool (server: Gmail; tool: list_labels; arguments: {})\n  — List all Gmail labels (folders/categories).\n\nthe native mcp_call tool (server: Gmail; tool: modify_labels; arguments: {"messageId": "MSG_ID", "addLabelIds": "STARRED", "removeLabelIds": "UNREAD"})\n  — Add or remove labels. Use to mark read/unread, star/unstar, archive, etc.\n  Common: remove UNREAD to mark as read, remove INBOX to archive, add STARRED to star.\n\nthe native mcp_call tool (server: Gmail; tool: trash_email; arguments: {"messageId": "MESSAGE_ID"})\n  — Move an email to the trash.\n\nthe native mcp_call tool (server: Gmail; tool: get_thread; arguments: {"threadId": "THREAD_ID"})\n  — Get all messages in a conversation thread.\n\n## USAGE GUIDELINES\n- Always start by checking the profile: the native mcp_call tool (server: Gmail; tool: get_profile; arguments: {})\n- Use search_emails with Gmail search syntax for powerful filtering\n- When asked to read emails, first list_emails then read_email for specific ones\n- For conversations, use get_thread to see the full email chain\n- Always confirm with the user before sending emails\n- Be cautious with trash_email — confirm before deleting\n- Use modify_labels to organize: mark as read, star, archive, etc.',
  },
  {
    id: 'skill-agents-direct-access',
    name: 'Agents Direct Access',
    description: 'Ask quick questions to other agents without creating tasks',
    category: 'general',
    icon: '💬',
    builtin: true,
    instructions:
      'You can ask questions directly to other agents in the swarm.\\n\\n## DIRECT QUESTIONS\\nUse the native ask_agent tool with agent_name and question fields.\\n\\nUse this for quick answers — no task is created on the target agent.\\nThe target agent will receive your question and respond concisely.\\nTheir answer will be provided back to you inline.\\n\\nWHEN TO USE ask_agent:\\n- Quick questions ("What framework is used?", "Did the tests pass?")\\n- Full tasks requiring work should be created through the task-management tools.\\n\\nRULES:\\n- One question per call\\n- Keep questions concise and specific\\n- The target agent will give a brief answer — this is not for delegating work',
    mcpServerIds: [],
    createdAt: '2024-03-01T00:00:00.000Z',
    updatedAt: '2024-03-01T00:00:00.000Z',
  },
  {
    id: 'skill-code-index',
    name: 'Code Index',
    description:
      'Index source folders, inspect file outlines, and run lexical or semantic code search through the internal MCP server',
    category: 'coding',
    icon: '🧠',
    builtin: true,
    mcpServerIds: ['mcp-code-index'],
    instructions:
      'You can use the internal Code Index plugin to explore codebases faster than raw grep alone.\\n\\nThe MCP tools are listed in the "--- MCP Tools ---" section of your prompt.\\nUse the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.\\n\\nRECOMMENDED WORKFLOW:\\n1. BEFORE any search, call the native mcp_call tool (server: Code Index; tool: list_repos; arguments: {}) to check if your current project is already indexed.\\n2. If the current project appears in the list, reuse its repoId — do NOT re-index.\\n3. If the current project is NOT in the list, index it first:\\n   - the native mcp_call tool (server: Code Index; tool: index_folder; arguments: {"path": "/projects/YOUR_PROJECT_NAME", "repoName": "YOUR_PROJECT_NAME"})\\n   - Use the project name from the PROJECT CONTEXT section of your prompt.\\n4. Search symbols or semantics first, then fetch outlines/source for the best matches.\\n5. Fall back to normal file tools when you need to edit files.\\n\\nMOST USEFUL TOOLS:\\n- the native mcp_call tool (server: Code Index; tool: list_repos; arguments: {})\\n  List all indexed repositories and their repoIds. ALWAYS call this first.\\n- the native mcp_call tool (server: Code Index; tool: index_folder; arguments: {"path": "/projects/MyProject", "repoName": "MyProject"})\\n  Index a project folder. Use the project name from your PROJECT CONTEXT.\\n- the native mcp_call tool (server: Code Index; tool: index_workspace; arguments: {"subpath": "server/src", "repoName": "server-src"})\\n  Index the current application workspace or a subfolder under it.\\n- the native mcp_call tool (server: Code Index; tool: search_symbols; arguments: {"repoId": "...", "query": "authenticateToken", "topK": 5})\\n  Find classes, functions, and methods by lexical match.\\n- the native mcp_call tool (server: Code Index; tool: search_semantic; arguments: {"repoId": "...", "query": "JWT auth middleware", "topK": 5})\\n  Find relevant code by meaning.\\n- the native mcp_call tool (server: Code Index; tool: get_file_outline; arguments: {"repoId": "...", "filePath": "src/middleware/auth.js"})\\n  Inspect all symbols in a file.\\n- the native mcp_call tool (server: Code Index; tool: get_symbol; arguments: {"repoId": "...", "symbolId": "...", "verify": true, "contextLines": 2})\\n  Retrieve a symbol\'s source and metadata.\\n\\nPATH GUIDANCE:\\n- index_folder with "/projects/PROJECT_NAME" is the preferred way to index a project.\\n- index_workspace resolves paths under the backend workspace root.\\n- For monorepos, you can index subfolders like "server/src", "client/src".\\n\\nUSE CASES:\\n- Quickly understand a large codebase before editing\\n- Locate auth, routing, service, and data-access logic\\n- Find all methods on a class\\n- Search conceptually ("rate limiting", "token verification", "file upload flow")\\n- Inspect exact source for a symbol before making changes',
  },
  {
    id: 'skill-slack',
    name: 'Slack',
    description:
      'Read channels, send messages, reply in threads, list users, and react to messages in Slack (per-agent OAuth)',
    category: 'general',
    icon: '💬',
    builtin: true,
    mcpServerIds: ['mcp-slack'],
    instructions:
      'You can interact with Slack using the Slack MCP tools.\\n\\nThe MCP tools are listed in the "--- MCP Tools ---" section of your prompt.\\nUse the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.\\n\\n## Slack MCP Tools Reference\\n\\nthe native mcp_call tool (server: Slack; tool: list_channels; arguments: {"types": "public_channel", "limit": 100})\\n  — List channels the bot has access to. types: public_channel, private_channel, mpim, im.\\n\\nthe native mcp_call tool (server: Slack; tool: read_channel; arguments: {"channel": "C01234ABCDE", "limit": 20})\\n  — Read recent messages from a channel. Returns messages with timestamps and users.\\n\\nthe native mcp_call tool (server: Slack; tool: read_thread; arguments: {"channel": "C01234ABCDE", "thread_ts": "1234567890.123456", "limit": 50})\\n  — Read all replies in a message thread.\\n\\nthe native mcp_call tool (server: Slack; tool: send_message; arguments: {"channel": "C01234ABCDE", "text": "Hello!"})\\n  — Send a message to a channel or user. Supports Slack mrkdwn formatting.\\n  Optional: thread_ts (to reply in a thread).\\n\\nthe native mcp_call tool (server: Slack; tool: reply_to_message; arguments: {"channel": "C01234ABCDE", "thread_ts": "1234567890.123456", "text": "Reply content"})\\n  — Reply to a specific message in a thread.\\n\\nthe native mcp_call tool (server: Slack; tool: list_users; arguments: {"limit": 100})\\n  — List workspace members with display names, status, and IDs.\\n\\nthe native mcp_call tool (server: Slack; tool: search_messages; arguments: {"query": "keyword", "count": 20})\\n  — Search messages across the workspace. Supports Slack search operators: in:#channel, from:@user.\\n  Note: requires search:read scope, may not be available with all bot tokens.\\n\\nthe native mcp_call tool (server: Slack; tool: get_channel_info; arguments: {"channel": "C01234ABCDE"})\\n  — Get detailed info about a channel (topic, purpose, member count, etc.).\\n\\nthe native mcp_call tool (server: Slack; tool: add_reaction; arguments: {"channel": "C01234ABCDE", "timestamp": "1234567890.123456", "name": "thumbsup"})\\n  — Add an emoji reaction to a message. Use emoji name without colons.\\n\\nthe native mcp_call tool (server: Slack; tool: open_dm; arguments: {"user": "U01234ABCDE"})\\n  — Open a DM channel with a user. Returns the DM channel ID for sending messages.\\n\\n## USAGE GUIDELINES\\n- Always start by listing channels: the native mcp_call tool (server: Slack; tool: list_channels; arguments: {})\\n- Use channel IDs (not names) for all operations\\n- When asked to read a channel, use list_channels first to find the ID, then read_channel\\n- For DMs, first open_dm to get the channel ID, then send_message\\n- Always confirm with the user before sending messages\\n- Use add_reaction to acknowledge messages without cluttering the channel\\n- Use threads (reply_to_message) to keep conversations organized',
  },
  {
    id: 'skill-jira',
    name: 'Jira',
    description:
      'Search, create, update, and manage Jira issues, boards, sprints, and comments (per-agent API key)',
    category: 'general',
    icon: '🎫',
    builtin: true,
    mcpServerIds: ['mcp-jira'],
    instructions:
      'You can interact with Jira using the Jira MCP tools.\n\nThe MCP tools are listed in the "--- MCP Tools ---" section of your prompt.\nUse the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.\n\n## Jira MCP Tools Reference\n\nthe native mcp_call tool (server: Jira; tool: get_myself; arguments: {})\n  — Get the authenticated Jira user profile.\n\nthe native mcp_call tool (server: Jira; tool: list_projects; arguments: {})\n  — List all accessible Jira projects.\n\nthe native mcp_call tool (server: Jira; tool: search_issues; arguments: {"jql": "project = PROJ AND status = \'In Progress\'", "maxResults": 20})\n  — Search issues using JQL. Supports all JQL operators.\n\nthe native mcp_call tool (server: Jira; tool: get_issue; arguments: {"issueKey": "PROJ-123"})\n  — Get full issue details (description, comments, attachments, subtasks).\n\nthe native mcp_call tool (server: Jira; tool: create_issue; arguments: {"projectKey": "PROJ", "summary": "New task", "description": "Details", "issueType": "Task"})\n  — Create a new issue. issueType: Task, Bug, Story, Epic, Sub-task.\n\nthe native mcp_call tool (server: Jira; tool: update_issue; arguments: {"issueKey": "PROJ-123", "summary": "Updated title"})\n  — Update issue fields (summary, description, priority, assignee, labels).\n\nthe native mcp_call tool (server: Jira; tool: add_comment; arguments: {"issueKey": "PROJ-123", "comment": "My comment"})\n  — Add a comment to an issue.\n\nthe native mcp_call tool (server: Jira; tool: transition_issue; arguments: {"issueKey": "PROJ-123"})\n  — List available transitions. Add transitionId to execute one.\n  Example: the native mcp_call tool (server: Jira; tool: transition_issue; arguments: {"issueKey": "PROJ-123", "transitionId": "31"})\n\nthe native mcp_call tool (server: Jira; tool: list_boards; arguments: {})\n  — List all Jira boards (Scrum/Kanban).\n\nthe native mcp_call tool (server: Jira; tool: get_board_columns; arguments: {"boardId": 1})\n  — Get board columns/statuses.\n\nthe native mcp_call tool (server: Jira; tool: get_sprint; arguments: {"boardId": 1})\n  — Get active sprint with issues.\n\nthe native mcp_call tool (server: Jira; tool: assign_issue; arguments: {"issueKey": "PROJ-123", "accountId": "abc123"})\n  — Assign or unassign an issue.\n\n## USAGE GUIDELINES\n- Start by listing projects: the native mcp_call tool (server: Jira; tool: list_projects; arguments: {})\n- Use JQL for powerful searches: status, assignee, labels, sprint, dates\n- Before transitioning, call transition_issue without transitionId to see options\n- Always confirm with the user before creating issues or modifying data\n- Use get_issue to read full details before making updates',
  },
  {
    id: 'skill-github',
    name: 'GitHub',
    description:
      'Browse repos, manage issues and PRs, search code, view commits and CI workflows (per-agent OAuth)',
    category: 'devops',
    icon: '🐙',
    builtin: true,
    mcpServerIds: ['mcp-github'],
    instructions:
      'You can interact with GitHub using the GitHub MCP tools.\n\nThe MCP tools are listed in the "--- MCP Tools ---" section of your prompt.\nUse the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.\n\n## GitHub MCP Tools Reference\n\nthe native mcp_call tool (server: GitHub; tool: get_authenticated_user; arguments: {})\n  — Get the authenticated GitHub user profile.\n\nthe native mcp_call tool (server: GitHub; tool: list_repos; arguments: {"type": "all", "sort": "updated", "per_page": 30})\n  — List repositories accessible to the authenticated user.\n\nthe native mcp_call tool (server: GitHub; tool: get_repo; arguments: {"owner": "octocat", "repo": "hello-world"})\n  — Get detailed info about a specific repository.\n\nthe native mcp_call tool (server: GitHub; tool: list_issues; arguments: {"owner": "octocat", "repo": "hello-world", "state": "open"})\n  — List issues. Filter by state, labels, assignee.\n\nthe native mcp_call tool (server: GitHub; tool: get_issue; arguments: {"owner": "octocat", "repo": "hello-world", "issue_number": 1})\n  — Get full issue details with comments.\n\nthe native mcp_call tool (server: GitHub; tool: create_issue; arguments: {"owner": "octocat", "repo": "hello-world", "title": "Bug report", "body": "Details"})\n  — Create a new issue.\n\nthe native mcp_call tool (server: GitHub; tool: update_issue; arguments: {"owner": "octocat", "repo": "hello-world", "issue_number": 1, "state": "closed"})\n  — Update an issue (title, body, state, labels, assignees).\n\nthe native mcp_call tool (server: GitHub; tool: add_issue_comment; arguments: {"owner": "octocat", "repo": "hello-world", "issue_number": 1, "body": "Comment"})\n  — Add a comment to an issue or PR.\n\nthe native mcp_call tool (server: GitHub; tool: list_pull_requests; arguments: {"owner": "octocat", "repo": "hello-world", "state": "open"})\n  — List pull requests.\n\nthe native mcp_call tool (server: GitHub; tool: get_pull_request; arguments: {"owner": "octocat", "repo": "hello-world", "pull_number": 1})\n  — Get full PR details with review status.\n\nthe native mcp_call tool (server: GitHub; tool: create_pull_request; arguments: {"owner": "octocat", "repo": "hello-world", "title": "Feature", "head": "feature-branch", "base": "main"})\n  — Create a new pull request.\n\nthe native mcp_call tool (server: GitHub; tool: list_branches; arguments: {"owner": "octocat", "repo": "hello-world"})\n  — List branches in a repository.\n\nthe native mcp_call tool (server: GitHub; tool: get_file_content; arguments: {"owner": "octocat", "repo": "hello-world", "path": "README.md"})\n  — Get file or directory content.\n\nthe native mcp_call tool (server: GitHub; tool: search_code; arguments: {"query": "repo:octocat/hello-world function main"})\n  — Search for code across repos.\n\nthe native mcp_call tool (server: GitHub; tool: list_commits; arguments: {"owner": "octocat", "repo": "hello-world", "per_page": 10})\n  — List recent commits.\n\nthe native mcp_call tool (server: GitHub; tool: list_workflows; arguments: {"owner": "octocat", "repo": "hello-world"})\n  — List GitHub Actions workflows.\n\nthe native mcp_call tool (server: GitHub; tool: list_workflow_runs; arguments: {"owner": "octocat", "repo": "hello-world", "per_page": 5})\n  — List recent CI/CD workflow runs.\n\n## USAGE GUIDELINES\n- Start by listing repos: the native mcp_call tool (server: GitHub; tool: list_repos; arguments: {})\n- Use search_code for finding code across repositories\n- Check workflow runs to monitor CI/CD status\n- Always confirm with the user before creating issues, PRs, or modifying data',
  },
  {
    id: 'skill-web-browser',
    name: 'Web Browser',
    description: 'Search, crawl and extract content from the web.',
    category: 'general',
    icon: '🌍',
    builtin: true,
    mcpServerIds: ['mcp-browser'],
    instructions: `You can browse the internet using the Web Browser MCP tools.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Use the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.

## AVAILABLE TOOLS

the native mcp_call tool (server: Web Browser; tool: search_web; arguments: {"query": "best practices docker swarm 2026"})
  — Search the web (DuckDuckGo) and get the results page as clean Markdown. Use this first to discover relevant URLs.

the native mcp_call tool (server: Web Browser; tool: crawl; arguments: {"url": "https://example.com/article"})
  — Crawl a single page and return its main content as clean Markdown (boilerplate, nav, footer, ads filtered out).
  Optional: word_count_threshold (default 10) to control how aggressively short blocks are dropped.

the native mcp_call tool (server: Web Browser; tool: crawl_many; arguments: {"urls": ["https://a.com", "https://b.com"]})
  — Crawl several pages in parallel. Use this when you need to compare or aggregate sources.

the native mcp_call tool (server: Web Browser; tool: get_links; arguments: {"url": "https://example.com"})
  — List all hyperlinks on a page (internal and external), filtered to ignore nav/footer noise.

the native mcp_call tool (server: Web Browser; tool: extract; arguments: {"url": "https://example.com/products", "instruction": "Extract product name and price for each item"})
  — Use the configured LLM to extract structured information from a page.
  Optional: schema_json — provide a JSON schema string to force structured JSON output.

## RECOMMENDED WORKFLOW

1. Start with the native mcp_call tool (server: Web Browser; tool: search_web; arguments: {"query": "..."}) to find candidate URLs.
2. Pick 1–3 promising URLs from the search results, then the native mcp_call tool (server: Web Browser; tool: crawl; arguments: ...) (or crawl_many) to read their content.
3. Use the native mcp_call tool (server: Web Browser; tool: extract; arguments: ...) only when you need structured data (tables, product lists, etc.) — for prose, plain crawl + your own reading is faster.
4. Use the native mcp_call tool (server: Web Browser; tool: get_links; arguments: ...) when you need to follow references from a starting page.

## IMPORTANT
- Always cite the source URL when returning information you got from the web.
- Prefer crawl over extract when you only need to read a page — it's faster and cheaper.
- Cloudflare / bot-blocked pages are handled transparently; if a crawl fails, retry once before giving up.
- Never use this tool to perform side effects (form submissions, logins). It is read-only by design.`,
  },
  {
    id: 'skill-aws-s3',
    name: 'AWS S3',
    description:
      'Browse buckets, read/write/delete objects, generate presigned URLs, and manage files on Amazon S3',
    category: 'cloud',
    icon: '🪣',
    builtin: true,
    mcpServerIds: ['mcp-aws-s3'],
    instructions: `You can interact with Amazon S3 using the AWS S3 MCP tools.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Use the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.

## AWS S3 MCP Tools Reference

the native mcp_call tool (server: AWS S3; tool: list_buckets; arguments: {})
  — List all S3 buckets in the account.

the native mcp_call tool (server: AWS S3; tool: list_objects; arguments: {"bucket": "my-bucket", "prefix": "data/", "max_keys": 100})
  — List objects in a bucket. Filter by prefix, paginate with continuation_token.

the native mcp_call tool (server: AWS S3; tool: get_object; arguments: {"bucket": "my-bucket", "key": "data/report.json"})
  — Read the content of an object (text files). For large/binary files, use get_presigned_url.

the native mcp_call tool (server: AWS S3; tool: put_object; arguments: {"bucket": "my-bucket", "key": "data/output.json", "content": "{}", "content_type": "application/json"})
  — Upload text content to an object. Creates or overwrites.

the native mcp_call tool (server: AWS S3; tool: delete_object; arguments: {"bucket": "my-bucket", "key": "data/old-file.txt"})
  — Delete an object from a bucket.

the native mcp_call tool (server: AWS S3; tool: copy_object; arguments: {"source_bucket": "src-bucket", "source_key": "file.txt", "dest_bucket": "dst-bucket", "dest_key": "copy.txt"})
  — Copy an object within or between buckets.

the native mcp_call tool (server: AWS S3; tool: get_object_info; arguments: {"bucket": "my-bucket", "key": "data/file.pdf"})
  — Get metadata about an object (size, type, last modified) without downloading.

the native mcp_call tool (server: AWS S3; tool: get_presigned_url; arguments: {"bucket": "my-bucket", "key": "data/large-file.zip", "operation": "get", "expires_in": 3600})
  — Generate a presigned URL for download ("get") or upload ("put"). Default 1 hour.

the native mcp_call tool (server: AWS S3; tool: create_bucket; arguments: {"bucket": "new-bucket-name", "region": "eu-west-1"})
  — Create a new S3 bucket.

## USAGE GUIDELINES
- Start by listing buckets: the native mcp_call tool (server: AWS S3; tool: list_buckets; arguments: {})
- Use list_objects with prefix to browse bucket contents like a file system
- Use get_object for text files, get_presigned_url for binary/large files
- Always confirm with the user before deleting objects or creating buckets
- Bucket names must be globally unique, lowercase, 3-63 characters
- Use prefix (e.g. "folder/") to organize objects — S3 has no real folders
- For large result sets, use the continuation_token from the previous response`,
  },
  {
    id: 'skill-auto-learn',
    name: 'Auto Learn',
    description:
      'Shared skill library — agents can create, search, update, and reuse learned knowledge and procedures',
    category: 'general',
    icon: '🎓',
    builtin: true,
    mcpServerIds: ['mcp-auto-learn'],
    instructions: `You have access to a shared skill library where you can learn, store, and retrieve reusable knowledge.

The MCP tools are listed in the "--- MCP Tools ---" section of your prompt.
Use the native mcp_call tool. Set its server, tool, and arguments fields from the MCP tool reference below.

## AVAILABLE TOOLS

the native mcp_call tool (server: Auto Learn; tool: list_skills; arguments: {})
  — List all skills in the shared library.

the native mcp_call tool (server: Auto Learn; tool: search_skills; arguments: {"query": "deployment"})
  — Search for existing skills by keyword. Matches name, description, category, and instructions.

the native mcp_call tool (server: Auto Learn; tool: get_skill; arguments: {"skill_id": "agent-skill-..."})
  — Get the full details and instructions of a specific skill.

the native mcp_call tool (server: Auto Learn; tool: create_skill; arguments: {"name": "Fix CORS Issues", "description": "Step-by-step guide to diagnose and fix CORS errors", "category": "coding", "instructions": "..."})
  — Create a new skill with detailed instructions. Categories: coding, devops, writing, security, analysis, general.

the native mcp_call tool (server: Auto Learn; tool: update_skill; arguments: {"skill_id": "agent-skill-...", "instructions": "Updated instructions..."})
  — Update an existing skill (name, description, category, or instructions).

the native mcp_call tool (server: Auto Learn; tool: delete_skill; arguments: {"skill_id": "agent-skill-..."})
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
- Update skills when you discover better approaches`,
  },
];
