# Swarm External API

API externe pour interagir avec le swarm d'agents depuis n'importe quel client (scripts, CI/CD, autres LLMs, MCP clients...).

Toutes les requetes sont authentifiees par **API key** via le header `Authorization: Bearer <api-key>`.

## Obtenir une API key

1. Se connecter a l'interface web Agent Swarm
2. Cliquer sur l'icone **cle** dans le header
3. Cliquer sur **Generate API Key**
4. Copier la cle affichee — elle ne sera plus visible apres fermeture de la modale

> La cle peut etre regeneree (l'ancienne est automatiquement revoquee) ou supprimee depuis la meme modale.

---

## REST API

Base URL : `https://<votre-domaine>/api/swarm`

Toutes les requetes necessitent le header :
```
Authorization: Bearer <api-key>
```

### Lister les agents

```
GET /api/swarm/agents
```

**Query parameters (optionnels) :**

| Parametre | Type   | Description                          |
|-----------|--------|--------------------------------------|
| `project` | string | Filtrer par nom de projet            |
| `status`  | string | Filtrer par statut : `idle`, `busy`, `error` |

**Exemple :**
```bash
curl -H "Authorization: Bearer swarm_sk_abc123..." \
     "https://swarm.example.com/api/swarm/agents?status=idle"
```

**Reponse :**
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

### Statut detaille d'un agent

```
GET /api/swarm/agents/:id
```

Le parametre `:id` accepte un **UUID** ou le **nom de l'agent** (insensible a la casse).

**Exemple :**
```bash
curl -H "Authorization: Bearer swarm_sk_abc123..." \
     "https://swarm.example.com/api/swarm/agents/QWEN"
```

**Reponse :**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "QWEN",
  "role": "Developer",
  "description": "Agent specialise en code Python",
  "status": "busy",
  "project": "my-project",
  "currentTask": "Implementing authentication module",
  "enabled": true,
  "todoList": [
    {
      "id": "todo-uuid",
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

### Ajouter une tache a un agent

```
POST /api/swarm/agents/:id/tasks
Content-Type: application/json
```

Le parametre `:id` accepte un **UUID** ou le **nom de l'agent**.

**Body :**

| Champ     | Type   | Requis | Description                                    |
|-----------|--------|--------|------------------------------------------------|
| `task`    | string | oui    | Description de la tache                        |
| `project` | string | non    | Projet a associer (defaut : projet de l'agent) |

**Exemple :**
```bash
curl -X POST \
     -H "Authorization: Bearer swarm_sk_abc123..." \
     -H "Content-Type: application/json" \
     -d '{"task": "Ecrire les tests unitaires pour le module auth", "project": "my-project"}' \
     "https://swarm.example.com/api/swarm/agents/QWEN/tasks"
```

**Reponse (201 Created) :**
```json
{
  "success": true,
  "todo": {
    "id": "new-todo-uuid",
    "text": "Ecrire les tests unitaires pour le module auth",
    "status": "pending",
    "project": "my-project",
    "createdAt": "2026-03-10T14:30:00.000Z"
  },
  "agent": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "QWEN"
  }
}
```

> La tache est ajoutee en statut `pending`. L'agent la prendra automatiquement en charge des qu'il sera `idle` (boucle de taches toutes les 5 secondes).

---

## MCP (Model Context Protocol)

Endpoint : `https://<votre-domaine>/api/swarm/mcp`

Pour les clients MCP (Claude, Claude Code, etc.), ajouter la configuration suivante :

```json
{
  "mcpServers": {
    "agent-swarm": {
      "url": "https://swarm.example.com/api/swarm/mcp",
      "headers": {
        "Authorization": "Bearer swarm_sk_abc123..."
      }
    }
  }
}
```

### Outils disponibles

| Outil              | Description                                              |
|--------------------|----------------------------------------------------------|
| `list_agents`      | Lister les agents (filtres optionnels : `project`, `status`) |
| `get_agent_status` | Statut detaille d'un agent (par `agent_id` ou `agent_name`) |
| `add_task`         | Ajouter une tache (params : `agent_id`/`agent_name`, `task`, `project`) |

---

## Codes d'erreur

| Code | Description                                      |
|------|--------------------------------------------------|
| 401  | API key manquante (header Authorization absent)  |
| 403  | API key invalide ou revoquee                     |
| 400  | Parametre manquant (ex: `task` vide)             |
| 404  | Agent non trouve                                 |
| 429  | Rate limit atteint (100 req/min)                 |

---

## Exemples d'utilisation

### Script bash — assigner une tache et verifier le statut

```bash
API_KEY="swarm_sk_..."
BASE="https://swarm.example.com/api/swarm"

# Ajouter une tache
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task": "Refactorer le module de paiement"}' \
  "$BASE/agents/QWEN/tasks"

# Attendre puis verifier le statut
sleep 10
curl -s -H "Authorization: Bearer $API_KEY" "$BASE/agents/QWEN" | jq '.status, .todoList'
```

### Python — lister les agents disponibles

```python
import requests

API_KEY = "swarm_sk_..."
BASE = "https://swarm.example.com/api/swarm"
headers = {"Authorization": f"Bearer {API_KEY}"}

response = requests.get(f"{BASE}/agents", params={"status": "idle"}, headers=headers)
agents = response.json()["agents"]

for agent in agents:
    print(f"{agent['name']} ({agent['role']}) — {agent['pendingTasks']} taches en attente")
```
