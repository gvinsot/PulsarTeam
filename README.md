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
curl -H "Authorization: Bearer <JWT>" \\
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

Task status updates are pushed through existing agent update events over Socket.IO and reflected immediately in the UI.## ZVEC-Powered Code Indexing API

The backend now ships with a code exploration service inspired by jCodeMunch and backed by **ZVEC** (with an automatic in-memory fallback if ZVEC is unavailable on the host).

### What it does

- Indexes a **local source folder**
- Extracts **symbols** (classes, functions, methods) for JS/TS and Python
- Stores metadata plus vector embeddings for **semantic search**
- Exposes authenticated HTTP endpoints for:
  - repo listing
  - file tree
  - file outline
  - exact symbol retrieval
  - lexical symbol search
  - semantic search
  - text search
  - repo invalidation

### Endpoints

All endpoints require the usual JWT auth and are mounted under:

- `POST /api/code-index/index-folder`
- `GET /api/code-index/repos`
- `GET /api/code-index/repos/:repoId`
- `GET /api/code-index/repos/:repoId/file-tree`
- `GET /api/code-index/repos/:repoId/file-outline?filePath=src/file.js`
- `GET /api/code-index/repos/:repoId/symbol?symbolId=...&verify=true&contextLines=2`
- `GET /api/code-index/repos/:repoId/search-symbols?query=token`
- `GET /api/code-index/repos/:repoId/search-semantic?query=jwt+validation`
- `GET /api/code-index/repos/:repoId/search-text?query=startsWith`
- `DELETE /api/code-index/repos/:repoId`

### Example

```bash
curl -X POST http://localhost:3001/api/code-index/index-folder \\
  -H "Authorization: Bearer <JWT>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "path": "./server/src",
    "repoName": "server-src"
  }'
```

### Environment variables

- `CODE_SEARCH_ALLOWED_ROOTS` — comma-separated list of roots that can be indexed
- `CODE_SEARCH_INDEX_ROOT` — override on-disk index storage location
- `CODE_SEARCH_VECTOR_BACKEND` — `auto` (default), `zvec`, or `memory`
- `CODE_SEARCH_MAX_FILES` — max files per indexed folder
- `CODE_SEARCH_MAX_FILE_SIZE` — max file size in bytes

### Notes

- Current extraction is an MVP optimized for **JavaScript/TypeScript** and **Python**
- The semantic layer uses local hashed embeddings, while **ZVEC** provides the vector index/query engine
- Indexed metadata is stored under `server/.data/` by default### Built-in plugin: Code Index

The code indexing MVP is also exposed as a **built-in plugin** backed by an internal MCP server named **Code Index**.

To use it:
1. Open an agent
2. Go to the **Plugins** tab
3. Assign the **Code Index** plugin
4. The agent will then receive Code Index MCP tools in its prompt automatically

Typical flow for an agent:
- `@mcp_call(Code Index, index_workspace, {"subpath": "server/src", "repoName": "server-src"})`
- `@mcp_call(Code Index, search_symbols, {"repoId": "...", "query": "authenticateToken", "topK": 5})`
- `@mcp_call(Code Index, get_file_outline, {"repoId": "...", "filePath": "src/middleware/auth.js"})`
- `@mcp_call(Code Index, get_symbol, {"repoId": "...", "symbolId": "...", "verify": true})`
- `@mcp_call(Code Index, search_semantic, {"repoId": "...", "query": "JWT authentication middleware"})`

The plugin uses the internal MCP server URL `__internal__code_index`, which is resolved by the backend to `/api/code-index/mcp`.