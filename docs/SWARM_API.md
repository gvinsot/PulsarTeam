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

Endpoint: `https://<your-domain>/api/swarm/mcp`

For MCP clients (Claude, Claude Code, etc.), add the following configuration:

```json
{
  "mcpServers": {
    "pulsar-team": {
      "url": "https://swarm.example.com/api/swarm/mcp",
      "headers": {
        "Authorization": "Bearer swarm_sk_abc123..."
      }
    }
  }
}
```

### Available Tools

| Tool               | Description                                              |
|--------------------|----------------------------------------------------------|
| `list_agents`      | List agents (optional filters: `project`, `status`)      |
| `get_agent_status` | Detailed agent status (by `agent_id` or `agent_name`)    |
| `add_task`         | Add a task (params: `agent_id`/`agent_name`, `task`, `project` — required). The agent is auto-assigned to the project. |

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
