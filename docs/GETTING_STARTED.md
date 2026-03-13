# Getting Started

Step-by-step guide to install and deploy PulsarTeam on your infrastructure.

## Prerequisites

Before you begin, make sure you have the following installed and running on your server:

### Required

| Component | Version | Purpose |
|-----------|---------|---------|
| **Docker Engine** | 24+ | Container runtime |
| **Docker Swarm** | (built-in) | Orchestration (run `docker swarm init` if not already active) |
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

## Step 2 — Create Docker Networks

PulsarTeam requires two overlay networks. Create them if they don't already exist:

```bash
# Network for Traefik reverse proxy
docker network create --driver overlay proxy

# Network for PostgreSQL access
docker network create --driver overlay postgresqlcluster_internal
```

> If you use different network names, update them in `devops/docker-compose.swarm.yml`.

---

## Step 3 — Set Up PostgreSQL

PulsarTeam needs a PostgreSQL database. You can use an existing instance or deploy one.

**Option A — Use an existing PostgreSQL instance:**

Create a database and user for PulsarTeam:

```sql
CREATE DATABASE swarm_prod;
CREATE USER swarm_prod_app WITH PASSWORD 'your-secure-password';
GRANT ALL PRIVILEGES ON DATABASE swarm_prod TO swarm_prod_app;
```

Make sure the PostgreSQL instance is reachable from the `postgresqlcluster_internal` Docker network.

**Option B — Quick PostgreSQL with Docker:**

```bash
docker service create \
  --name pg-primary \
  --network postgresqlcluster_internal \
  -e POSTGRES_DB=swarm_prod \
  -e POSTGRES_USER=swarm_prod_app \
  -e POSTGRES_PASSWORD=your-secure-password \
  --mount type=volume,source=pgdata,target=/var/lib/postgresql/data \
  postgres:16-alpine
```

> PulsarTeam auto-creates all required tables on first startup. No manual migration is needed.

---

## Step 4 — Configure Environment Variables

```bash
cd devops
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

### LLM API Keys

Configure at least one provider:

```env
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
MISTRAL_API_KEY=xxx
OLLAMA_BASE_URL=http://ollama:11434
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

```env
CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token
CLAUDE_MODEL=claude-opus-4-6
CLAUDE_MAX_TURNS=50
CODER_API_KEY=generate-a-secret-here
CODER_PUID=1000
CODER_PGID=1000
CODER_DOMAIN=coder.your-domain.com
```

### OneDrive Integration (Optional)

```env
ONEDRIVE_CLIENT_ID=xxx
ONEDRIVE_CLIENT_SECRET=xxx
ONEDRIVE_REDIRECT_URI=https://your-domain.com/api/onedrive/callback
ONEDRIVE_TENANT_ID=xxx
```

---

## Step 5 — Set Up Traefik (Recommended)

PulsarTeam uses Traefik labels for routing and TLS. If you don't have Traefik running, here's a minimal setup:

```bash
docker service create \
  --name traefik \
  --network proxy \
  --publish 80:80 \
  --publish 443:443 \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=volume,source=traefik-certs,target=/letsencrypt \
  traefik:v3 \
    --providers.swarm=true \
    --providers.swarm.exposedByDefault=false \
    --entrypoints.web.address=:80 \
    --entrypoints.websecure.address=:443 \
    --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web \
    --certificatesresolvers.letsencrypt.acme.email=you@example.com \
    --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
```

> If you don't use Traefik, remove the Traefik labels from `docker-compose.swarm.yml` and expose ports directly.

---

## Step 6 — Update Placement Constraints

By default, all services are constrained to run on `node.hostname == server-b`. Update this in `devops/docker-compose.swarm.yml` to match your server hostname:

```bash
# Check your node hostname
docker node ls
```

Then replace all occurrences of `server-b` in the compose file with your actual hostname, or remove the placement constraints entirely for a single-node setup.

---

## Step 7 — Build and Deploy

### Build images and push to registry

```bash
cd devops
./docker-compose.pre.sh
```

This script:
1. Auto-detects your host user's UID/GID
2. Builds all Docker images (API, Frontend, Coder Service, Sandbox)
3. Pushes images to your Docker registry
4. Builds the frontend static assets

### Deploy the stack

```bash
docker stack deploy -c docker-compose.swarm.yml pulsarteam
```

### Verify deployment

```bash
./docker-compose.post.sh
```

Or check manually:

```bash
# Check all services are running
docker stack services pulsarteam

# Check service logs
docker service logs pulsarteam_api --tail 50
docker service logs pulsarteam_frontend --tail 50
docker service logs pulsarteam_coder-service --tail 50

# Verify health
curl -s https://your-domain.com/api/health | jq .
```

---

## Step 8 — First Login

1. Open your browser at `https://your-domain.com`
2. Log in with the credentials from your `.env` file (default: `admin` / `swarm2026`)
3. You should see the agent dashboard

---

## Step 9 — Create Your First Agent

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

See [docs/SWARM_API.md](SWARM_API.md) for the full API reference.

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
# Check service status
docker stack services pulsarteam

# Check for errors in logs
docker service logs pulsarteam_api --tail 100 2>&1 | grep -i error
```

### Database connection issues

- Verify `DATABASE_URL` in `.env` is correct
- Ensure the PostgreSQL service is on the `postgresqlcluster_internal` network
- Check that the database user has the required privileges

### Agents can't clone Git repositories

- Verify SSH keys are correctly mounted (`SSH_KEYS_HOST_PATH` in `.env`)
- Check that GitHub SSH host keys are present: `ssh-keyscan github.com`
- Ensure `GITHUB_TOKEN` is set if using HTTPS cloning

### Permission errors on files

- Verify `RUN_AS_USER` matches your host username
- The pre-deployment script should auto-detect UID/GID — check `.env` for `RUN_AS_UID` and `RUN_AS_GID`

### Coder Service not responding

- Check OAuth token: `docker service logs pulsarteam_coder-service --tail 50`
- Verify `CODER_API_KEY` matches between API and Coder Service
- The health check has a 120s start period — wait for initial startup

---

## Updating PulsarTeam

```bash
cd PulsarTeam
git pull

cd devops
./docker-compose.pre.sh
docker stack deploy -c docker-compose.swarm.yml pulsarteam
```

Docker Swarm performs rolling updates automatically with zero downtime.
