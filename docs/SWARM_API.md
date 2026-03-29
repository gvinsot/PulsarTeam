# Swarm External API

External API to interact with the agent swarm from any client (scripts, CI/CD, other LLMs, MCP clients...).

All requests are authenticated via **API key** using the `Authorization: Bearer <api-key>` header.

## Getting an API Key

1. Log in to the PulsarTeam web interface
2. Click the **key** icon in the header
3. Click **Generate API Key**
4. Copy the displayed key — it will no longer be visible after closing the modal

> The key can be regenerated (the previous one is automatically revoked) or deleted from the same modal.

---

## REST API

Base URL: `https://<your-domain>/api/swarm`

All requests require the header:
```
Authorization: Bearer <api-key>
```

### List Agents

```
GET /api/swarm/agents
```

**Query parameters (optional):**

| Parameter | Type   | Description                              |
|-----------|--------|------------------------------------------|
| `project` | string | Filter by project name                  |
| `status`  | string | Filter by status: `idle`, `busy`, `error` |

**Example:**
```bash
curl -H "Authorization: Bearer swarm_sk_abc123..." \
     "https://swarm.example.com/api/swarm/agents?status=idle"
```

**Response:**
```json
{
  "count": 2,
  "agents": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "QWEN",
      "role": "Developer",
      "status": "idle",
      "project": "my-project",
      "currentTask": null,
      "pendingTasks": 3,
      "totalMessages": 42
    }
  ]
}
```

---

### Detailed Agent Status

```
GET /api/swarm/agents/:id
```

The `:id` parameter accepts a **UUID** or the **agent name** (case-insensitive).

**Example:**
```bash
curl -H "Authorization: Bearer swarm_sk_abc123..." \
     "https://swarm.example.com/api/swarm/agents/QWEN"
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "QWEN",
  "role": "Developer",
  "description": "Agent specialized in Python code",
  "status": "busy",
  "project": "my-project",
  "currentTask": "Implementing authentication module",
  "enabled": true,
  "todoList": [
    {
      "id": "task-uuid",
      "text": "Write unit tests",
      "status": "pending",
      "project": "my-project",
      "createdAt": "2026-03-10T12:00:00.000Z",
      "completedAt": null
    }
  ],
  "metrics": {
    "totalMessages": 42,
    "totalTokensIn": 15000,
    "totalTokensOut": 8000,
    "totalErrors": 0
  }
}
```

---

### Add a Task to an Agent

```
POST /api/swarm/agents/:id/tasks
Content-Type: application/json
```

The `:id` parameter accepts a **UUID** or the **agent name**.

**Body:**

| Field     | Type   | Required | Description                                                    |
|-----------|--------|----------|----------------------------------------------------------------|
| `task`    | string | yes      | Task description                                               |
| `project` | string | yes      | Project to associate. The agent is automatically reassigned to this project if needed. |

**Example:**
```bash
curl -X POST \
     -H "Authorization: Bearer swarm_sk_abc123..." \
     -H "Content-Type: application/json" \
     -d '{"task": "Write unit tests for the auth module", "project": "my-project"}' \
     "https://swarm.example.com/api/swarm/agents/QWEN/tasks"
```

**Response (201 Created):**
```json
{
  "success": true,
  "task": {
    "id": "new-task-uuid",
    "text": "Write unit tests for the auth module",
    "status": "pending",
    "project": "my-project",
    "source": { "type": "api" },
    "createdAt": "2026-03-10T14:30:00.000Z"
  },
  "agent": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "QWEN"
  }
}
```

> The task is added with `pending` status. The agent is automatically assigned to the provided project if its current project differs. The agent will pick up the task as soon as it becomes `idle` (task loop runs every 5 seconds).

---

## MCP (Model Context Protocol)

The Swarm API exposes an MCP server for integration with AI assistants (Claude, Claude Code, Cursor, etc.).

### Endpoint

```
POST https://<your-domain>/api/swarm/mcp
```

The server supports **Streamable HTTP** (MCP 2025-03-26 spec) and legacy **SSE** transport.

### Configuration

#### Claude Desktop (JSON config)

```json
{
  "mcpServers": {
    "pulsar-team": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/cli"],
      "env": {
        "MCP_SERVER_URL": "https://swarm.example.com/api/swarm/mcp",
        "Authorization": "Bearer swarm_sk_abc123..."
      }
    }
  }
}
```

#### Using MCP CLI

```bash
npx -y @modelcontextprotocol/cli \
  --url https://swarm.example.com/api/swarm/mcp \
  --header "Authorization: Bearer swarm_sk_abc123..."
```

#### Programmatic (Node.js)

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://swarm.example.com/api/swarm/mcp'),
  {
    requestInit: {
      headers: { Authorization: 'Bearer swarm_sk_abc123...' }
    }
  }
);

const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);

// List agents
const result = await client.callTool({
  name: 'list_agents',
  arguments: { status: 'idle' }
});
```

### Available Tools

| Tool               | Description                                              | Parameters |
|--------------------|----------------------------------------------------------|------------|
| `list_agents`      | List agents with optional filters                        | `project` (optional), `status` (optional: `idle`, `busy`, `error`) |
| `get_agent_status` | Detailed agent status                                    | `agent_id` (optional UUID) or `agent_name` (optional string) — at least one required |
| `list_boards`      | List all task boards and their workflows                 | none |
| `add_task`         | Add a task to an agent                                   | `agent_id` or `agent_name` (one required), `task` (required), `project` (optional), `status` (optional: `backlog` or `pending`, default: `backlog`), `board_id` (optional — auto-resolved if only one board exists) |

### Tool Examples

#### list_agents

```javascript
await client.callTool({
  name: 'list_agents',
  arguments: { status: 'idle', project: 'my-project' }
});
```

**Response:**
```json
{
  "count": 2,
  "agents": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "QWEN",
      "role": "Developer",
      "status": "idle",
      "project": "my-project",
      "currentTask": null,
      "pendingTasks": 3,
      "totalMessages": 42
    }
  ]
}
```

#### get_agent_status

```javascript
await client.callTool({
  name: 'get_agent_status',
  arguments: { agent_name: 'QWEN' }
});
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "QWEN",
  "role": "Developer",
  "description": "Agent specialized in Python code",
  "status": "busy",
  "project": "my-project",
  "currentTask": "Implementing authentication module",
  "enabled": true,
  "todoList": [...],
  "metrics": {
    "totalMessages": 42,
    "totalTokensIn": 15000,
    "totalTokensOut": 8000,
    "totalErrors": 0
  }
}
```

#### list_boards

```javascript
await client.callTool({
  name: 'list_boards'
});
```

**Response:**
```json
{
  "count": 2,
  "boards": [
    {
      "id": "board-uuid-1",
      "name": "Development",
      "user": "john.doe",
      "user_id": "user-uuid",
      "columns": [
        { "id": "col-1", "label": "Backlog" },
        { "id": "col-2", "label": "In Progress" },
        { "id": "col-3", "label": "Done" }
      ]
    }
  ]
}
```

#### add_task

```javascript
await client.callTool({
  name: 'add_task',
  arguments: {
    agent_name: 'QWEN',
    task: 'Implement user authentication',
    project: 'my-project',
    status: 'pending',
    board_id: 'board-uuid-1'
  }
});
```

**Response:**
```json
{
  "success": true,
  "task": {
    "id": "new-task-uuid",
    "text": "Implement user authentication",
    "status": "pending",
    "project": "my-project",
    "boardId": "board-uuid-1",
    "createdAt": "2026-03-10T14:30:00.000Z"
  },
  "agent": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "QWEN"
  },
  "board_id": "board-uuid-1"
}
```

> **Note on `add_task`:**
> - If `board_id` is omitted and only one board exists, it is used automatically.
> - If multiple boards exist and no `board_id` is provided, the tool returns an error with available board options.
> - `status` defaults to `backlog` (agent won't auto-pick). Use `pending` for immediate execution.

---

## Error Codes

| Code | Description                                          |
|------|------------------------------------------------------|
| 401  | Missing API key (Authorization header absent)        |
| 403  | Invalid or revoked API key                           |
| 400  | Missing parameter (e.g. `task` or `project` absent)  |
| 404  | Agent not found                                      |
| 429  | Rate limit reached (100 req/min)                     |

---

## Usage Examples

### Bash script — assign a task and check status

```bash
API_KEY="swarm_sk_..."
BASE="https://swarm.example.com/api/swarm"

# Add a task
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task": "Refactor the payment module", "project": "my-project"}' \
  "$BASE/agents/QWEN/tasks"

# Wait then check status
sleep 10
curl -s -H "Authorization: Bearer $API_KEY" "$BASE/agents/QWEN" | jq '.status, .todoList'
```

### Python — list available agents

```python
import requests

API_KEY = "swarm_sk_..."
BASE = "https://swarm.example.com/api/swarm"
headers = {"Authorization": f"Bearer {API_KEY}"}

response = requests.get(f"{BASE}/agents", params={"status": "idle"}, headers=headers)
agents = response.json()["agents"]

for agent in agents:
    print(f"{agent['name']} ({agent['role']}) — {agent['pendingTasks']} pending tasks")
```

### MCP Client — list agents and add a task

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const API_KEY = 'swarm_sk_...';
const MCP_URL = 'https://swarm.example.com/api/swarm/mcp';

const transport = new StreamableHTTPClientTransport(
  new URL(MCP_URL),
  { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } }
);

const client = new Client({ name: 'my-script', version: '1.0.0' });
await client.connect(transport);

// List idle agents
const agents = await client.callTool({
  name: 'list_agents',
  arguments: { status: 'idle' }
});
console.log('Available agents:', agents);

// Add a task to the first idle agent
const firstAgent = JSON.parse(agents.content[0].text).agents[0];
if (firstAgent) {
  const task = await client.callTool({
    name: 'add_task',
    arguments: {
      agent_id: firstAgent.id,
      task: 'Review pull requests',
      project: 'my-project',
      status: 'pending'
    }
  });
  console.log('Task created:', task);
}
```

---

## Legacy SSE Transport

For clients that don't support Streamable HTTP yet, the server also exposes a legacy SSE endpoint:

- `GET /api/swarm/mcp/sse` — establishes the SSE stream
- `POST /api/swarm/mcp/messages?sessionId=<id>` — sends JSON-RPC messages

This transport is deprecated and may be removed in future versions. Prefer Streamable HTTP for new integrations.