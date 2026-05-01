# Getting Started

Step-by-step guide to install and deploy PulsarTeam on your infrastructure.

## Prerequisites

Before you begin, make sure you have the following installed and running on your server:

### Required

| Component | Version | Purpose |
|-----------|---------|---------|
| **Docker Engine** | 24+ | Container runtime |
| **PostgreSQL** | 12+ | Persistent storage for agents, plugins, MCP servers, projects |
| **Git** | 2.30+ | Source code management |

### Recommended

| Component | Purpose |
|-----------|---------|
| **Traefik** | Reverse proxy with automatic HTTPS (Let's Encrypt) |
| **Docker Registry** | Private registry to store built images |
| **SSH keys** | For agents to clone/push to Git repositories |

### LLM Provider (at least one)

| Provider | What you need |
|----------|---------------|
| **Anthropic (Claude)** | API key (`sk-ant-...`) |
| **OpenAI (GPT)** | API key (`sk-...`) |
| **Mistral** | API key |
| **Ollama** | Running instance URL (e.g. `http://localhost:11434`) |
| **vLLM** | Running instance URL |

---

## Step 1 — Clone the Repository

```bash
git clone https://github.com/your-org/PulsarTeam.git
cd PulsarTeam
```

---

## Step 2 — Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and configure the following sections:

### Server & Authentication

```env
PORT=3001
NODE_ENV=production
JWT_SECRET=generate-a-long-random-string-here

ADMIN_USERNAME=admin
ADMIN_PASSWORD=swarm2026
```

> Generate a strong JWT secret: `openssl rand -hex 32`

### Database

```env
DATABASE_URL=postgresql://swarm_prod_app:your-secure-password@pg-primary:5432/swarm_prod
```

### CORS

```env
CORS_ORIGINS=https://your-domain.com
```

### Git & GitHub

```env
GIT_USER_NAME=Your Name
GIT_USER_EMAIL=you@example.com
GITHUB_TOKEN=ghp_xxx
GITHUB_USER=your-github-username
SSH_KEYS_HOST_PATH=/home/youruser/.ssh
```

### Docker Registry

```env
DOCKER_REGISTRY_URL=registry.example.com
```

### Host Paths

```env
HOST_CODE_PATH=/home/youruser
```

> This is the parent directory containing the `PulsarTeam` folder on the host.

### Sandbox

```env
SANDBOX_SHARED_CONTAINER_NAME=sandbox
SANDBOX_BASE_WORKSPACE=/workspace
```

### User Permissions

```env
RUN_AS_USER=youruser
```

> The UID/GID are auto-detected by the pre-deployment script to match your host user. This ensures agents can read/write files with correct permissions.

### Coder Service (Optional)

If you want to use the Claude Code integration:
coder-service is a wrapper to use Claude Code as a container, it allows to use your Pro or Max plan as a remote service.

```env
CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token
CLAUDE_MODEL=claude-opus-4-6
CLAUDE_MAX_TURNS=50
CODER_API_KEY=generate-a-secret-here
```

### OneDrive Integration (Optional)

```env
ONEDRIVE_CLIENT_ID=xxx
ONEDRIVE_CLIENT_SECRET=xxx
ONEDRIVE_REDIRECT_URI=https://your-domain.com/onedrive-callback.html
ONEDRIVE_TENANT_ID=xxx
```

> The redirect URI must point to the static callback page served by the
> frontend (`/onedrive-callback.html`), **not** the backend API. The page
> captures the auth code and forwards it to the API via `postMessage`.
> Register the same URL in your Azure App Registration → "Redirect URIs".

### Gmail Integration (Optional)

```env
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx
GMAIL_REDIRECT_URI=https://your-domain.com/gmail-callback.html
```

> Same principle as OneDrive: the redirect URI is the frontend callback
> page (`/gmail-callback.html`). Register it in Google Cloud Console →
> Credentials → OAuth 2.0 Client → "Authorized redirect URIs".
> For local dev use `http://localhost/gmail-callback.html` (frontend on
> port 80) or `http://localhost:5173/gmail-callback.html` (Vite dev server).

---

## Step 3 — Start PulsarTeam

A `docker-compose.yml` at the root of the repository handles everything: PostgreSQL, API, Frontend, Sandbox, and optionally the Coder Service.

### Core services (API + Frontend + Sandbox + PostgreSQL)

```bash
docker compose up -d --build
```

### With Coder Service (Claude Code integration)

```bash
docker compose --profile coder up -d --build
```

> PostgreSQL is included and auto-configured. Tables are created automatically on first startup — no manual migration needed.

---

## Step 4 — Verify

```bash
# Check all containers are running
docker compose ps

# Check API health
curl -s http://localhost:3001/api/health | jq .

# Check logs if needed
docker compose logs api --tail 50
docker compose logs frontend --tail 50
docker compose logs coder-service --tail 50
```

---

## Step 5 — First Login

1. Open your browser at `http://localhost` (or your domain if using Traefik)
2. Log in with the credentials from your `.env` file (default: `admin` / `swarm2026`)
3. You should see the agent dashboard

---

## Step 6 — Create Your First Agent

1. Click **+ Add Agent** on the dashboard
2. Choose a template (e.g. **Developer**) or create a custom agent
3. Select an LLM provider and model
4. Click **Create**

The agent is now ready to receive messages and tasks.

---

## Post-Installation

### Generate a Swarm API Key

To interact with PulsarTeam from external systems (scripts, CI/CD, other AI agents):

1. Click the **key** icon in the header
2. Click **Generate API Key**
3. Copy the key — it won't be shown again

See [SWARM_API.md](SWARM_API.md) for the full API reference.

### Configure Plugins

1. Open an agent's detail view
2. Go to the **Plugins** tab
3. Assign built-in plugins (Basic Tools, Code Index, OneDrive, etc.)
4. Or create custom plugins with your own MCP servers

### Assign Agents to a Project

1. Go to the **Projects** view
2. Create a project with an objective and rules
3. Assign agents to the project — they will auto-switch context

---

## Troubleshooting

### Services won't start

```bash
docker compose ps -a
docker compose logs api --tail 100 2>&1 | grep -i error
```

### Database connection issues

- Verify `DATABASE_URL` in `.env` is correct
- Ensure the API container is on the `postgresqlcluster_internal` network: `docker network inspect postgresqlcluster_internal`
- Check that the database user has the required privileges

### Agents can't clone Git repositories

- Verify SSH keys are correctly mounted (`SSH_KEYS_HOST_PATH` in `.env`)
- Check that GitHub SSH host keys are present: `ssh-keyscan github.com`
- Ensure `GITHUB_TOKEN` is set if using HTTPS cloning

### Permission errors on files

- Verify `RUN_AS_USER` matches your host username
- The pre-deployment script should auto-detect UID/GID — check `.env` for `RUN_AS_UID` and `RUN_AS_GID`

### Coder Service not responding

- Check OAuth token: `docker compose logs coder-service --tail 50`
- Verify `CODER_API_KEY` matches between API and Coder Service

---

## Updating PulsarTeam

```bash
cd PulsarTeam
git pull
docker compose up -d --build
```
