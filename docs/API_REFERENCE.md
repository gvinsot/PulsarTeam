# PulsarTeam API Reference

Complete reference for the PulsarTeam REST API, WebSocket events, and MCP endpoints.

**Base URL:** `http://localhost:3001` (or your deployment URL)

---

## Table of Contents

- [Authentication](#authentication)
- [Rate Limiting](#rate-limiting)
- [Health Check](#health-check)
- [Agents](#agents)
- [Tasks](#tasks)
- [Task History & Stats](#task-history--stats)
- [Templates](#templates)
- [Projects](#projects)
- [Project Contexts](#project-contexts)
- [Plugins](#plugins)
- [MCP Servers](#mcp-servers)
- [Code Index](#code-index)
- [Users](#users)
- [LLM Configurations](#llm-configurations)
- [Boards](#boards)
- [Budget & Token Usage](#budget--token-usage)
- [Settings](#settings)
- [API Keys](#api-keys)
- [OneDrive Integration](#onedrive-integration)
- [Jira Integration](#jira-integration)
- [Realtime Voice](#realtime-voice)
- [Leader Tools](#leader-tools)
- [Swarm External API](#swarm-external-api)
- [MCP Endpoints](#mcp-endpoints)
- [WebSocket Events](#websocket-events)

---

## Authentication

PulsarTeam uses **JWT** (JSON Web Token) authentication for internal API endpoints and **API Key** authentication for the external Swarm API.

### Login

```
POST /api/auth/login
```

**Body:**

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| `username` | string | yes      | User login  |
| `password` | string | yes      | Password    |

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "username": "admin",
  "role": "admin",
  "userId": "uuid",
  "displayName": "Admin"
}
```

**Rate limit:** 5 attempts per IP per 15 minutes.

### Verify Token

```
GET /api/auth/verify
Authorization: Bearer <jwt-token>
```

**Response:**
```json
{
  "valid": true,
  "user": {
    "userId": "uuid",
    "username": "admin",
    "role": "admin",
    "displayName": "Admin"
  }
}
```

### Impersonate User (Admin Only)

```
POST /api/auth/impersonate/:userId
Authorization: Bearer <jwt-token>
```

Returns a new JWT for the target user, with `impersonatedBy` field set to the admin's username.

### Using JWT Authentication

All authenticated endpoints require the header:
```
Authorization: Bearer <jwt-token>
```

### Roles

| Role       | Permissions                                                 |
|------------|-------------------------------------------------------------|
| `admin`    | Full access: manage users, agents, configs, impersonate     |
| `advanced` | Create/edit/delete own agents, full plugin/project access   |
| `basic`    | Read-only: view agents, send messages, manage own tasks     |

---

## Rate Limiting

| Scope               | Limit                        |
|----------------------|------------------------------|
| Global API           | 300 requests/min per IP      |
| Login                | 5 attempts/15 min per IP     |
| WebSocket (per conn) | 30 mutating events/min       |
| Swarm External API   | 100 requests/min per API key |

Rate-limited responses return `429 Too Many Requests`.

---

## Health Check

### Liveness Probe (Public)

```
GET /api/health
```

**Response:**
```json
{
  "status": "ok",
  "database": "connected"
}
```

### Detailed Status (Authenticated)

```
GET /api/health/details
Authorization: Bearer <jwt-token>
```

**Response:**
```json
{
  "status": "ok",
  "uptime": 3600.5,
  "agents": {
    "total": 10,
    "enabled": 8,
    "busy": 3,
    "idle": 4,
    "error": 1
  },
  "projects": {
    "active": 3,
    "distribution": { "my-project": 4, "other-project": 2 },
    "unassigned": 2
  }
}
```

---

## Agents

All agent endpoints require JWT authentication: `Authorization: Bearer <jwt-token>`

### List Agents

```
GET /api/agents
```

Returns all agents visible to the current user (admin sees all, others see own + unowned). Sensitive fields like `apiKey` are masked.

### List Agent Statuses (Lightweight)

```
GET /api/agents/statuses
```

**Query parameters:**

| Parameter | Type   | Description               |
|-----------|--------|---------------------------|
| `project` | string | Filter by project name   |

Returns lightweight status objects (no conversation history).

### Get Agents by Project

```
GET /api/agents/by-project/:project
```

### Get Project Summary

```
GET /api/agents/project-summary
```

Returns all projects with agent counts and assignments.

### Get Swarm Status

```
GET /api/agents/swarm-status
```

Returns comprehensive swarm status with project assignments.

### Get Single Agent

```
GET /api/agents/:id
```

### Get Single Agent Status (Lightweight)

```
GET /api/agents/:id/status
```

### Create Agent

```
POST /api/agents
```

**Requires:** `admin` or `advanced` role.

**Body:**

| Field               | Type     | Required | Description                             |
|---------------------|----------|----------|-----------------------------------------|
| `name`              | string   | yes      | Agent name (1-200 chars)                |
| `role`              | string   | no       | Agent role (max 100 chars)              |
| `description`       | string   | no       | Description (max 2000 chars)            |
| `provider`          | string   | no       | LLM provider (e.g. "anthropic")         |
| `model`             | string   | no       | Model name (e.g. "claude-sonnet-4-6") |
| `endpoint`          | string   | no       | Custom API endpoint                     |
| `apiKey`            | string   | no       | LLM API key                             |
| `instructions`      | string   | no       | System prompt (max 50K chars)           |
| `temperature`       | number   | no       | Temperature 0-2 (nullable)              |
| `maxTokens`         | number   | no       | Max output tokens (1-1M)                |
| `contextLength`     | number   | no       | Context window size                     |
| `skills`            | string[] | no       | Assigned plugin IDs                     |
| `mcpServers`        | string[] | no       | Assigned MCP server IDs                 |
| `handoffTargets`    | string[] | no       | Allowed handoff target agent IDs        |
| `project`           | string   | no       | Assigned project name                   |
| `enabled`           | boolean  | no       | Whether agent is active                 |
| `isLeader`          | boolean  | no       | Whether this is a leader agent          |
| `isVoice`           | boolean  | no       | Whether this is a voice agent           |
| `isReasoning`       | boolean  | no       | Whether extended thinking is enabled    |
| `voice`             | string   | no       | Voice ID for realtime (e.g. "alloy")    |
| `template`          | string   | no       | Template ID to base config on           |
| `color`             | string   | no       | UI color                                |
| `icon`              | string   | no       | UI icon                                 |
| `costPerInputToken` | number   | no       | Cost per input token (for budget)       |
| `costPerOutputToken`| number   | no       | Cost per output token (for budget)      |
| `copyApiKeyFromAgent`| string  | no       | UUID of agent to copy API key from      |

**Response:** `201 Created` with the created agent object.

### Update Agent

```
PUT /api/agents/:id
```

**Requires:** `admin` or `advanced` role. Non-admin users can only update their own agents.

Accepts any subset of the create agent fields.

### Delete Agent

```
DELETE /api/agents/:id
```

**Requires:** `admin` or `advanced` role. Non-admin users can only delete their own agents.

### Send Message (Chat)

```
POST /api/agents/:id/chat
```

**Body:**

| Field     | Type   | Required | Description                        |
|-----------|--------|----------|------------------------------------|
| `message` | string | yes      | Message content (max 50KB)         |

**Response:**
```json
{
  "response": "Agent's reply text..."
}
```

### Get Conversation History

```
GET /api/agents/:id/history
```

### Clear Conversation History

```
DELETE /api/agents/:id/history
```

### Truncate History After Index

```
DELETE /api/agents/:id/history/after/:index
```

Removes all messages after the specified index.

### Clear Action Logs

```
DELETE /api/agents/:id/action-logs
```

### Handoff Between Agents

```
POST /api/agents/:id/handoff
```

**Body:**

| Field           | Type   | Required | Description                        |
|-----------------|--------|----------|------------------------------------|
| `targetAgentId` | string | yes      | Target agent UUID                  |
| `context`       | string | yes      | Context to pass to the target      |

### Broadcast Message to All Agents

```
POST /api/agents/broadcast/all
```

**Body:**

| Field     | Type   | Required | Description                        |
|-----------|--------|----------|------------------------------------|
| `message` | string | yes      | Message to send to all agents      |

### Update Project for All Agents

```
PUT /api/agents/project/all
```

**Body:**

| Field     | Type   | Required | Description                        |
|-----------|--------|----------|------------------------------------|
| `project` | string | yes      | Project name (or null to unassign) |

---

## Tasks

Task endpoints are nested under agents: `/api/agents/:id/tasks`

### Add Task

```
POST /api/agents/:id/tasks
```

**Body:**

| Field     | Type   | Required | Description                                                     |
|-----------|--------|----------|-----------------------------------------------------------------|
| `text`    | string | yes      | Task description                                                |
| `project` | string | no      | Project name (auto-assigns agent to project if different)       |
| `source`  | object | no      | Source info (default `{ type: "user" }`)                        |
| `status`  | string | no      | Initial status: `idea`, `backlog`, `pending`, `in_progress`, `done`, `error` |

**Response:** `201 Created` with the task object.

### Update Task

```
PATCH /api/agents/:id/tasks/:taskId
```

**Body (one of):**

| Field     | Type   | Description                                              |
|-----------|--------|----------------------------------------------------------|
| `status`  | string | New status                                               |
| `text`    | string | Updated task text                                        |
| `project` | string | Updated task project (null to unassign)                  |

If no field is provided, the task status is toggled. The `source` field cannot be modified after creation.

If a task is moved out of `in_progress` while the agent is busy, the agent is automatically stopped.

### Delete All Tasks

```
DELETE /api/agents/:id/tasks
```

### Delete Single Task

```
DELETE /api/agents/:id/tasks/:taskId
```

If the deleted task was `in_progress`, the agent is automatically stopped.

### Transfer Task to Another Agent

```
POST /api/agents/:id/tasks/:taskId/transfer
```

**Body:**

| Field           | Type   | Required | Description           |
|-----------------|--------|----------|-----------------------|
| `targetAgentId` | string | yes      | Target agent UUID     |

**Response:** `201 Created` with the transferred task.

### Update Task Assignee

```
PATCH /api/agents/:id/tasks/:taskId/assignee
```

**Body:**

| Field        | Type   | Required | Description                       |
|--------------|--------|----------|-----------------------------------|
| `assigneeId` | string | no       | Agent UUID (or null to unassign)  |

### Link Commit to Task

```
POST /api/agents/:id/tasks/:taskId/commits
```

**Body:**

| Field     | Type   | Required | Description        |
|-----------|--------|----------|--------------------|
| `hash`    | string | yes      | Git commit hash    |
| `message` | string | no       | Commit message     |

**Response:** `201 Created` with the updated task.

### Remove Commit from Task

```
DELETE /api/agents/:id/tasks/:taskId/commits/:hash
```

### Refine Task with AI

```
POST /api/agents/:id/tasks/:taskId/refine
```

**Body:**

| Field          | Type   | Required | Description                            |
|----------------|--------|----------|----------------------------------------|
| `refineAgentId`| string | yes      | Agent UUID to use for refinement       |

The specified agent must be `idle`. It will rewrite the task text to be clearer and more actionable.

### Assign Plugin to Agent

```
POST /api/agents/:id/plugins
```

**Body:**

| Field      | Type   | Required | Description     |
|------------|--------|----------|-----------------|
| `pluginId` | string | yes      | Plugin ID       |

### Remove Plugin from Agent

```
DELETE /api/agents/:id/plugins/:pluginId
```

### Assign MCP Server to Agent

```
POST /api/agents/:id/mcp-servers
```

**Body:**

| Field      | Type   | Required | Description     |
|------------|--------|----------|-----------------|
| `serverId` | string | yes      | MCP server ID   |

### Remove MCP Server from Agent

```
DELETE /api/agents/:id/mcp-servers/:serverId
```

---

## Task History & Stats

### Task Statistics

```
GET /api/agents/tasks/stats?project=MyProject
```

Returns aggregate task statistics. Optional `project` query parameter.

### Task Time Series

```
GET /api/agents/tasks/stats/timeseries?project=MyProject&days=30
```

**Query parameters:**

| Parameter | Type   | Default | Description               |
|-----------|--------|---------|---------------------------|
| `project` | string | all    | Filter by project name    |
| `days`    | number | 30     | Number of days (1-365)    |

### Task History

```
GET /api/agents/tasks/:id/history
```

Returns the status change history for a specific task.

---

## RAG Documents

### Add RAG Document

```
POST /api/agents/:id/rag
```

**Body:**

| Field     | Type   | Required | Description           |
|-----------|--------|----------|-----------------------|
| `name`    | string | yes      | Document name         |
| `content` | string | yes      | Document content      |

**Response:** `201 Created`

### Delete RAG Document

```
DELETE /api/agents/:id/rag/:docId
```

---

## Templates

### List All Templates

```
GET /api/templates
```

Returns built-in agent templates.

### Get Single Template

```
GET /api/templates/:id
```

---

## Projects

Projects are sourced from GitHub starred repositories.

### List Projects

```
GET /api/projects
```

**Response:**
```json
[
  {
    "name": "my-project",
    "fullName": "org/my-project",
    "gitUrl": "git@github.com:org/my-project.git",
    "description": "Project description"
  }
]
```

### Refresh Project Cache

```
POST /api/projects/refresh
```

Forces a re-fetch of starred repositories from GitHub.

---

## Project Contexts

Project contexts store per-project descriptions and rules used in agent system prompts.

### List All Contexts

```
GET /api/project-contexts
```

### Get Context by Project Name

```
GET /api/project-contexts/:name
```

Returns `{ name, description: "", rules: "" }` if no context exists yet.

### Create/Update Context

```
PUT /api/project-contexts/:name
```

**Body:**

| Field         | Type   | Required | Description                     |
|---------------|--------|----------|---------------------------------|
| `description` | string | no       | Project description (max 10K)   |
| `rules`       | string | no       | Project rules/guidelines (max 10K) |

### Delete Context

```
DELETE /api/project-contexts/:name
```

---

## Plugins

Plugins combine instructions and optional MCP server connections. They are assigned to agents to extend their capabilities.

### List All Plugins

```
GET /api/plugins
```

### Get Single Plugin

```
GET /api/plugins/:id
```

### Create Plugin

```
POST /api/plugins
```

**Body:**

| Field          | Type     | Required | Description                          |
|----------------|----------|----------|--------------------------------------|
| `name`         | string   | yes      | Plugin name                          |
| `description`  | string   | no       | Description                          |
| `category`     | string   | no       | Category label                       |
| `icon`         | string   | no       | Icon emoji                           |
| `instructions` | string   | yes      | Instructions injected into agent     |
| `userConfig`   | object   | no       | User-configurable settings           |
| `mcps`         | array    | no       | Embedded MCP server configurations   |

**Response:** `201 Created`

### Update Plugin

```
PUT /api/plugins/:id
```

Accepts any subset of create fields.

### Delete Plugin

```
DELETE /api/plugins/:id
```

### Attach MCP Server to Plugin

```
POST /api/plugins/:id/mcps/:mcpId
```

### Detach MCP Server from Plugin

```
DELETE /api/plugins/:id/mcps/:mcpId
```

---

## MCP Servers

MCP (Model Context Protocol) servers provide tools that agents can use.

### List All MCP Servers

```
GET /api/mcp-servers
```

Returns all servers with their tools and connection status. API keys are masked.

### Get Single MCP Server

```
GET /api/mcp-servers/:id
```

### Create MCP Server

```
POST /api/mcp-servers
```

**Body:**

| Field         | Type    | Required | Description               |
|---------------|---------|----------|---------------------------|
| `name`        | string  | yes      | Server name               |
| `url`         | string  | yes      | Server URL (valid URL)    |
| `description` | string  | no       | Description               |
| `icon`        | string  | no       | Icon emoji                |
| `enabled`     | boolean | no       | Whether enabled           |
| `apiKey`      | string  | no       | Auth API key for server   |

**Response:** `201 Created`

### Update MCP Server

```
PUT /api/mcp-servers/:id
```

### Delete MCP Server

```
DELETE /api/mcp-servers/:id
```

### Force Reconnect

```
POST /api/mcp-servers/:id/connect
```

Reconnects and refreshes the tool list.

---

## Code Index

The code index provides symbol search and semantic code search over indexed repositories.

### Index a Folder

```
POST /api/code-index/index-folder
```

**Body:**

| Field         | Type   | Required | Description                              |
|---------------|--------|----------|------------------------------------------|
| `path`        | string | yes      | Absolute path to folder                  |
| `repoName`    | string | no       | Display name for the repository          |
| `maxFiles`    | number | no       | Max files to index (1-20000)             |
| `maxFileSize` | number | no       | Max file size in bytes (1KB-5MB)         |

**Response:** `201 Created`

### Auto-Index Project

```
POST /api/code-index/index-project
```

**Body:**

| Field         | Type   | Required | Description                     |
|---------------|--------|----------|---------------------------------|
| `projectName` | string | yes      | Project name (alphanumeric)     |

Indexes the project from `REPOS_BASE_DIR/<projectName>`. Responds immediately; indexing runs in the background.

### List Indexed Repositories

```
GET /api/code-index/repos
```

### Get Repository Summary

```
GET /api/code-index/repos/:repoId
```

### Get File Tree

```
GET /api/code-index/repos/:repoId/file-tree
```

### Get File Outline (Symbols)

```
GET /api/code-index/repos/:repoId/file-outline?filePath=src/index.js
```

### Get Symbol Details

```
GET /api/code-index/repos/:repoId/symbol?symbolId=xxx&verify=true&contextLines=2
```

**Query parameters:**

| Parameter      | Type    | Required | Description                     |
|----------------|---------|----------|---------------------------------|
| `symbolId`     | string  | yes      | Symbol identifier               |
| `verify`       | boolean | no       | Verify against source           |
| `contextLines` | number  | no       | Context lines around symbol     |

### Search Symbols (Lexical)

```
GET /api/code-index/repos/:repoId/search-symbols?query=authenticate&topK=5&kind=function
```

**Query parameters:**

| Parameter | Type   | Required | Description                            |
|-----------|--------|----------|----------------------------------------|
| `query`   | string | yes      | Search query                           |
| `topK`    | number | no       | Max results (1-50)                     |
| `kind`    | string | no       | Filter by: `function`, `class`, `method` |

### Search Semantic

```
GET /api/code-index/repos/:repoId/search-semantic?query=JWT+auth+middleware&topK=5
```

### Search Text

```
GET /api/code-index/repos/:repoId/search-text?query=TODO&topK=10
```

### Delete Repository Index

```
DELETE /api/code-index/repos/:repoId
```

---

## Users

**All user endpoints require `admin` role.**

### List Users

```
GET /api/users
```

### Get Single User

```
GET /api/users/:id
```

Password is excluded from the response.

### Create User

```
POST /api/users
```

**Body:**

| Field         | Type   | Required | Description                       |
|---------------|--------|----------|-----------------------------------|
| `username`    | string | yes      | Username (2-100 chars)            |
| `password`    | string | yes      | Password (4-200 chars)            |
| `role`        | string | no       | `admin`, `advanced`, or `basic` (default: `basic`) |
| `displayName` | string | no       | Display name                      |

**Response:** `201 Created`

### Update User

```
PUT /api/users/:id
```

Accepts any subset of create fields.

### Delete User

```
DELETE /api/users/:id
```

Cannot delete your own account.

---

## LLM Configurations

Shared LLM configurations that agents can reference. API keys are masked for non-admin users.

### List LLM Configs

```
GET /api/llm-configs
```

### Get Single LLM Config

```
GET /api/llm-configs/:id
```

### Create LLM Config (Admin Only)

```
POST /api/llm-configs
```

**Body:**

| Field               | Type    | Required | Description                     |
|---------------------|---------|----------|---------------------------------|
| `name`              | string  | no       | Config name                     |
| `provider`          | string  | no       | Provider (e.g. "anthropic")     |
| `model`             | string  | no       | Model ID                        |
| `apiKey`            | string  | no       | API key                         |
| `endpoint`          | string  | no       | Custom endpoint URL             |
| `isReasoning`       | boolean | no       | Extended thinking mode           |
| `costPerInputToken` | number  | no       | Cost per input token            |
| `costPerOutputToken`| number  | no       | Cost per output token           |

**Response:** `201 Created`

### Update LLM Config (Admin Only)

```
PUT /api/llm-configs/:id
```

### Delete LLM Config (Admin Only)

```
DELETE /api/llm-configs/:id
```

---

## Boards

User-owned Kanban boards with custom workflows.

### List Boards

```
GET /api/boards
```

Returns boards belonging to the authenticated user.

### Get Single Board

```
GET /api/boards/:id
```

Access restricted to the board owner.

### Create Board

```
POST /api/boards
```

**Body:**

| Field      | Type   | Required | Description                                    |
|------------|--------|----------|------------------------------------------------|
| `name`     | string | no       | Board name (default: "My Board", max 100)      |
| `workflow` | object | no       | Custom workflow (defaults to system workflow)   |
| `filters`  | object | no       | Board filters                                  |

**Response:** `201 Created`

### Update Board

```
PUT /api/boards/:id
```

### Update Board Workflow

```
PUT /api/boards/:id/workflow
```

**Body:** Workflow object with `columns` array. Version is auto-incremented.

### Get Tasks by Assignee

```
GET /api/boards/tasks/by-assignee/:agentId
```

Returns all tasks assigned to an agent across all boards owned by the current user.

### Delete Board

```
DELETE /api/boards/:id
```

---

## Budget & Token Usage

### Usage Summary

```
GET /api/budget/summary?days=1
```

Returns token usage summary with budget configuration.

### Usage by Agent

```
GET /api/budget/by-agent?days=30
```

### Usage Timeline

```
GET /api/budget/timeline?days=7&groupBy=day
```

**Query parameters:**

| Parameter | Type   | Default | Description                    |
|-----------|--------|---------|--------------------------------|
| `days`    | number | 7       | Number of days                 |
| `groupBy` | string | day    | Grouping: `day` or `hour`     |

### Daily Usage

```
GET /api/budget/daily?days=30
```

### Budget Configuration

```
GET /api/budget/config
```

**Default configuration:**
```json
{
  "dailyBudget": 10.00,
  "alertThreshold": 80,
  "tokenCosts": {
    "anthropic": { "input": 3.0, "output": 15.0 },
    "openai": { "input": 2.5, "output": 10.0 },
    "google": { "input": 1.25, "output": 5.0 },
    "default": { "input": 2.0, "output": 10.0 }
  }
}
```

### Update Budget Configuration

```
PUT /api/budget/config
```

**Body:** Budget configuration object (same structure as above).

### Budget Alerts

```
GET /api/budget/alerts
```

Returns active alerts when approaching or exceeding daily budget, plus per-agent breakdown.

---

## Settings

### Get General Settings

```
GET /api/settings/general
```

### Update General Settings

```
PUT /api/settings/general
```

### Workflow Configuration

#### Get Default Workflow

```
GET /api/settings/general/workflow
```

#### Update Default Workflow

```
PUT /api/settings/general/workflow
```

#### Get Project-Specific Workflow

```
GET /api/settings/general/workflow/:project
```

#### Update Project-Specific Workflow

```
PUT /api/settings/general/workflow/:project
```

#### List All Workflows

```
GET /api/settings/general/workflows
```

---

## API Keys

Manage the external Swarm API key.

### Get API Key Info

```
GET /api/settings/api-key
```

Returns only the key prefix (masked).

### Generate New API Key

```
POST /api/settings/api-key
```

Returns the full key **once** (cannot be retrieved again). Generating a new key revokes the previous one.

### Revoke API Key

```
DELETE /api/settings/api-key
```

---

## OneDrive Integration

OAuth2-based Microsoft OneDrive integration.

**Required environment variables:**
- `ONEDRIVE_CLIENT_ID`
- `ONEDRIVE_CLIENT_SECRET`
- `ONEDRIVE_REDIRECT_URI`
- `ONEDRIVE_TENANT_ID` (optional, defaults to "common")

### Connection Status

```
GET /api/onedrive/status
```

**Response:**
```json
{
  "configured": true,
  "connected": true,
  "username": "admin"
}
```

### Get Authorization URL

```
GET /api/onedrive/auth-url
```

Returns the Microsoft OAuth login URL.

### Exchange Authorization Code

```
POST /api/onedrive/callback
```

**Body:**

| Field   | Type   | Required | Description              |
|---------|--------|----------|--------------------------|
| `code`  | string | yes      | Authorization code       |
| `state` | string | yes      | OAuth state parameter    |

### Disconnect

```
POST /api/onedrive/disconnect
```

Clears stored tokens.

---

## Jira Integration

### Sync Status

```
GET /api/jira/status
```

### Board Columns

```
GET /api/jira/columns
```

Returns Jira board columns for workflow configuration.

### Manual Sync

```
POST /api/jira/sync
```

Triggers a full synchronization with Jira.

### Get Issue Details

```
GET /api/jira/issue/:jiraKey
```

### Post Comment to Issue

```
POST /api/jira/comment/:jiraKey
```

**Body:**

| Field     | Type   | Required | Description     |
|-----------|--------|----------|-----------------|
| `comment` | string | yes      | Comment text    |

### AI Analysis Comment

```
POST /api/jira/ai-comment/:jiraKey
```

**Body:**

| Field          | Type   | Required | Description                  |
|----------------|--------|----------|------------------------------|
| `instructions` | string | no       | Custom AI instructions       |
| `role`         | string | no       | Role context for AI          |

Triggers an AI agent to analyze the issue and post the analysis as a Jira comment.

### Jira Webhook (Public)

```
POST /api/jira/webhook
```

Not JWT-authenticated. Secured via `X-Automation-Webhook-Token` header (shared secret).

---

## Realtime Voice

OpenAI Realtime API integration for voice-enabled agents.

### Get Ephemeral Token

```
POST /api/realtime/token
```

**Body:**

| Field     | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| `agentId` | string | yes      | Voice agent UUID         |

The agent must have `isVoice: true`.

**Response:**
```json
{
  "token": "ek_...",
  "expiresAt": 1711234567,
  "voice": "alloy",
  "model": "gpt-realtime-1.5",
  "transcriptionModel": "gpt-4o-mini-transcribe"
}
```

**Available voice tools:** `delegate`, `ask`, `assign_project`, `get_project`, `list_agents`, `agent_status`, `get_available_agent`, `list_projects`, `clear_context`, `rollback`, `stop_agent`, `clear_all_chats`, `clear_all_action_logs`

---

## Leader Tools

Internal endpoints used by leader agents to monitor and manage the swarm.

### Get Last Messages from Agent

```
GET /api/leader-tools/last-messages?agentId=uuid&limit=5
GET /api/leader-tools/last-messages?agentName=QWEN&limit=5
```

### Get Agent Status

```
GET /api/leader-tools/agent-status?agentId=uuid
GET /api/leader-tools/agent-status?agentName=QWEN
```

### Get All Agent Statuses

```
GET /api/leader-tools/all-statuses?project=MyProject
```

### Get Swarm Status

```
GET /api/leader-tools/swarm-status
```

### Get Agents by Project

```
GET /api/leader-tools/by-project/:project
```

### Get Project Summary

```
GET /api/leader-tools/project-summary
```

---

## Swarm External API

External REST API for programmatic access, CI/CD integration, and MCP clients. Authenticated via **API key** (`Authorization: Bearer <api-key>`).

See [SWARM_API.md](SWARM_API.md) for detailed usage examples.

### List Agents

```
GET /api/swarm/agents?project=my-project&status=idle
```

### Get Agent Status

```
GET /api/swarm/agents/:id
```

The `:id` accepts a UUID or agent name (case-insensitive).

### Add Task

```
POST /api/swarm/agents/:id/tasks
```

**Body:**

| Field     | Type   | Required | Description                     |
|-----------|--------|----------|---------------------------------|
| `task`    | string | yes      | Task description (1-5000 chars) |
| `project` | string | yes      | Project name (1-200 chars)     |
| `status`  | string | no       | `backlog` or `pending`          |

**Response:** `201 Created`

---

## MCP Endpoints

### Swarm MCP (Streamable HTTP)

```
POST /api/swarm/mcp
Authorization: Bearer <api-key>
```

JSON-RPC over HTTP. Tools: `list_agents`, `get_agent_status`, `add_task`.

### Swarm MCP (SSE — Legacy)

```
GET  /api/swarm/mcp/sse         → SSE stream
POST /api/swarm/mcp/messages    → JSON-RPC messages
Authorization: Bearer <api-key>
```

### Code Index MCP

```
POST /api/code-index/mcp
Authorization: Bearer <jwt-token>
```

Internal MCP for code index tool calls.

### OneDrive MCP

```
POST /api/onedrive/mcp
Authorization: Bearer <jwt-token>
```

Internal MCP for OneDrive file operations.

---

## WebSocket Events

PulsarTeam uses Socket.IO for real-time communication. Connect with:

```javascript
import { io } from 'socket.io-client';
const socket = io('http://localhost:3001', {
  auth: { token: '<jwt-token>' }
});
```

### Client → Server Events

| Event                    | Data                                        | Description                           |
|--------------------------|---------------------------------------------|---------------------------------------|
| `agent:chat`             | `{ agentId, message, messageId }`           | Send message to agent (with streaming)|
| `broadcast:message`      | `{ message }`                               | Send message to all agents            |
| `agent:handoff`          | `{ fromId, toId, context }`                 | Handoff between agents                |
| `agents:refresh`         | —                                           | Request updated agent list            |
| `agents:swarm-status`    | —                                           | Request swarm status                  |
| `agents:statuses`        | —                                           | Request lightweight agent statuses    |
| `agent:status`           | `{ agentId }`                               | Request single agent status           |
| `agents:by-project`      | `{ project }`                               | Request agents for a project          |
| `agents:project-summary` | —                                           | Request project summary               |
| `agent:stop`             | `{ agentId }`                               | Stop an agent's current task          |
| `agent:task:execute`     | `{ agentId, taskId }`                       | Execute a single task                 |
| `agent:task:executeAll`  | `{ agentId }`                               | Execute all pending tasks             |
| `voice:delegate`         | `{ agentId, targetAgentName, task }`        | Voice: delegate task to agent         |
| `voice:ask`              | `{ agentId, targetAgentName, question }`    | Voice: ask a question to agent        |
| `voice:management`       | `{ agentId, functionName, args }`           | Voice: management tool call           |

### Server → Client Events

| Event                      | Data                                           | Description                        |
|----------------------------|------------------------------------------------|------------------------------------|
| `agents:list`              | `Agent[]`                                      | Full agent list (on connect)       |
| `agent:updated`            | `Agent`                                        | Single agent state changed         |
| `agent:stream:start`       | `{ agentId, project }`                         | Agent started generating           |
| `agent:stream:chunk`       | `{ agentId, project, chunk }`                  | Streaming text chunk               |
| `agent:stream:end`         | `{ agentId, project }`                         | Agent finished generating          |
| `agent:stream:error`       | `{ agentId, project, error }`                  | Agent generation error             |
| `agent:thinking`           | `{ agentId, project, thinking }`               | Agent's current thinking state     |
| `broadcast:start`          | `{ message }`                                  | Broadcast started                  |
| `broadcast:complete`       | `{ results }`                                  | Broadcast finished                 |
| `broadcast:error`          | `{ error }`                                    | Broadcast error                    |
| `agent:handoff:complete`   | `{ fromId, toId, response }`                   | Handoff completed                  |
| `agent:handoff:error`      | `{ error }`                                    | Handoff error                      |
| `agents:swarm-status`      | `SwarmStatus`                                  | Swarm status response              |
| `agents:statuses`          | `AgentStatus[]`                                | Lightweight statuses               |
| `agent:status`             | `AgentStatus`                                  | Single agent status                |
| `agents:by-project`        | `Agent[]`                                      | Agents for requested project       |
| `agents:project-summary`   | `ProjectSummary`                               | Project summary response           |
| `voice:delegate:result`    | `{ agentId, targetAgentName, error, result }`  | Voice delegation result            |
| `voice:ask:result`         | `{ agentId, targetAgentName, error, result }`  | Voice ask result                   |
| `voice:management:result`  | `{ agentId, functionName, error, result }`     | Voice management result            |
| `error`                    | `{ message }`                                  | General error (e.g. rate limit)    |

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "Human-readable error message"
}
```

Validation errors include details:

```json
{
  "error": "Validation failed",
  "details": [
    {
      "code": "too_small",
      "minimum": 1,
      "path": ["name"],
      "message": "String must contain at least 1 character(s)"
    }
  ]
}
```

### Common HTTP Status Codes

| Code | Description                                      |
|------|--------------------------------------------------|
| 200  | Success                                          |
| 201  | Created                                          |
| 400  | Bad request / validation error                   |
| 401  | Authentication required or invalid token         |
| 403  | Insufficient permissions                         |
| 404  | Resource not found                               |
| 409  | Conflict (e.g. agent is busy)                    |
| 429  | Rate limit exceeded                              |
| 500  | Internal server error                            |

---

## Security Headers

All responses include the following security headers:

| Header                    | Value                                                |
|---------------------------|------------------------------------------------------|
| `X-Content-Type-Options`  | `nosniff`                                            |
| `X-Frame-Options`         | `DENY`                                               |
| `X-XSS-Protection`        | `1; mode=block`                                      |
| `Referrer-Policy`         | `strict-origin-when-cross-origin`                    |
| `Content-Security-Policy` | Restrictive CSP (self + fonts + WebSocket)           |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`             |

---

## Environment Variables

| Variable                          | Description                                     | Default             |
|-----------------------------------|-------------------------------------------------|---------------------|
| `PORT`                            | Server port                                     | `3001`              |
| `JWT_SECRET`                      | Secret for JWT signing                          | **required**        |
| `ADMIN_USERNAME`                  | Initial admin username                          | `admin`             |
| `ADMIN_PASSWORD`                  | Initial admin password                          | **required in prod**|
| `CORS_ORIGINS`                    | Comma-separated allowed origins                 | `localhost:5173,3000` |
| `REPOS_BASE_DIR`                  | Base directory for project repos                | —                   |
| `OPENAI_API_KEY`                  | Default OpenAI API key                          | —                   |
| `OPENAI_REALTIME_MODEL`           | Realtime model                                  | `gpt-realtime-1.5`  |
| `OPENAI_REALTIME_VOICE`           | Default voice                                   | `alloy`             |
| `OPENAI_REALTIME_TRANSCRIBE_MODEL`| Transcription model                             | `gpt-4o-mini-transcribe` |
| `ONEDRIVE_CLIENT_ID`              | Azure App client ID                             | —                   |
| `ONEDRIVE_CLIENT_SECRET`          | Azure App client secret                         | —                   |
| `ONEDRIVE_REDIRECT_URI`           | OAuth redirect URI                              | —                   |
| `ONEDRIVE_TENANT_ID`              | Azure tenant ID                                 | `common`            |
