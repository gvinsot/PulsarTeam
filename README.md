# 🐝 Agent Swarm UI

A professional, real-time web interface for managing a swarm of AI agents. Built with the **Swarm pattern** (lightweight multi-agent orchestration with handoffs), supporting multiple LLM providers including Ollama and Claude (Anthropic).

## Features

### Agent Management
- **Add/Remove agents** in real time with visual feedback
- **8 pre-built agent templates**: Developer, Architect, QA Engineer, Marketing, DevOps, Data Analyst, Product Manager, Security Analyst
- **Custom agent creation** with full LLM configuration
- **Color-coded** agent cards with status indicators (idle/busy/error)

### Real-Time Capabilities
- **Live streaming** of agent responses via WebSocket
- **Real-time thinking indicator** showing the agent's current output as it generates
- **Status updates** propagated to all connected clients instantly
- **Metrics tracking**: messages, tokens in/out, errors, last active time

### Chat & Interaction
- **Per-agent chat** with full markdown rendering
- **Conversation history** with timestamps
- **Streaming responses** with typing indicators

### Global Broadcast (tmux-style)
- **Broadcast a message to ALL agents simultaneously**
- See all responses side-by-side

### Agent Handoffs (Swarm Pattern)
- **Transfer conversations** between agents with context

### Task Management (Todo Lists)
- **Per-agent todo lists** with progress tracking

### RAG (Retrieval-Augmented Generation)
- **Attach reference documents** to any agent
- Upload text files (.txt, .md, .json, .csv, .yaml)

### Security
- **JWT-based authentication** with login page
- Default credentials: `admin` / `swarm2026`

## Quick Start

```bash
# Install server
cd server && npm install

# Install client
cd ../client && npm install

# Start server (terminal 1)
cd server && npm start

# Start client (terminal 2)
cd client && npm run dev
```

Open **http://localhost:5173** — login: `admin` / `swarm2026`

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO, JWT
- **Frontend**: React 19, Vite 6, Tailwind CSS, Lucide Icons
- **LLM**: Anthropic SDK, Ollama API
## Swarm Leader Tool: Read Agent Last Messages

A new management API is available for the Swarm Leader to inspect the latest messages from any agent.

### Endpoint

`GET /api/leader-tools/last-messages`

Query parameters:
- `agentId` (optional if `agentName` provided): target agent id
- `agentName` (optional if `agentId` provided): target agent name (case-insensitive)
- `limit` (optional): number of last messages to return (default `1`, max `50`)

### Example

```bash
curl -H "Authorization: Bearer <JWT>" \
  "http://localhost:3001/api/leader-tools/last-messages?agentName=Developer&limit=3"
```

Response shape:

```json
{
  "agentId": "uuid",
  "agentName": "Developer",
  "totalMessages": 42,
  "returned": 3,
  "limit": 3,
  "messages": [
    {
      "index": 39,
      "role": "assistant",
      "content": "…",
      "timestamp": "2026-03-02T10:00:00.000Z",
      "type": null
    }
  ]
}
```## Task List Status (Real-time)

The agent task list now shows each task status directly, without requiring users to click "Execute this task".

Supported statuses:
- `pending`
- `in_progress`
- `error`
- `done` (displayed as **Completed**)

### Real-time updates

Task status updates are pushed through existing agent update events over Socket.IO and reflected immediately in the UI.