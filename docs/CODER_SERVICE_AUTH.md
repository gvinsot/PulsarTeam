# Coder Service — Flow d'authentification OAuth

## Vue d'ensemble

Le **coder-service** est un service FastAPI qui pilote le CLI **Claude Code** en mode headless.
Pour utiliser l'API Claude via le CLI, un **token OAuth** est nécessaire — il n'y a pas de clé API Anthropic configurée.

L'authentification utilise le protocole **OAuth 2.0 Authorization Code + PKCE** (Proof Key for Code Exchange), identique à celui du CLI `claude` natif. Le coder-service agit en tant que client OAuth public (pas de `client_secret`).

```
┌──────────┐      ┌─────────────┐      ┌──────────────────┐      ┌───────────────┐
│ Frontend  │◄────►│  API (Node)  │◄────►│  Coder-Service   │◄────►│  claude.ai    │
│ (browser) │      │              │      │  (FastAPI)       │      │  OAuth server │
└──────────┘      └─────────────┘      └──────────────────┘      └───────────────┘
```

---

## Paramètres OAuth

| Paramètre | Valeur |
|-----------|--------|
| **Client ID** | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (client public Claude Code) |
| **Authorize URL** | `https://claude.ai/oauth/authorize` |
| **Token URL** | `https://platform.claude.com/v1/oauth/token` |
| **Redirect URI** | `https://platform.claude.com/oauth/code/callback` |
| **Scopes** | `user:profile user:inference user:sessions:claude_code user:mcp_servers` |
| **PKCE Method** | S256 (SHA-256 du `code_verifier`) |

---

## Les 3 niveaux d'isolation des tokens

Le coder-service gère les tokens à **3 niveaux**, du plus spécifique au plus général :

### 1. Token par Owner (recommandé)

Chaque utilisateur PulsarTeam (identifié par `owner_id`) possède son propre token.
Tous les agents d'un même owner partagent ce token.

```
/app/data/users/<owner_id>/oauth_token.json
```

### 2. Token par Agent (legacy)

Chaque agent peut avoir son propre token isolé dans son répertoire home :

```
/app/data/agents/<agent_username>/oauth_token.json
/app/data/agents/<agent_username>/.claude/.credentials.json
```

### 3. Token global (fallback)

Un token partagé par toute l'instance, utilisé quand aucun token owner/agent n'est disponible :

```
/app/data/oauth_token          (texte brut)
/app/data/oauth_token.json     (JSON avec refresh token + expiry)
~/.claude/.credentials.json    (pour compatibilité CLI)
```

**Priorité de résolution** (`_resolve_token`) :
1. Token de l'owner → 2. Token de l'agent → 3. Token global

Si un agent n'a pas de token mais qu'un token global existe, il est automatiquement copié (bootstrapping).

---

## Flow d'authentification principal

### Étape 1 — Détection de l'absence de token

Quand un agent envoie un message au chat (via `/v1/chat/completions` ou `/stream`), le coder-service vérifie si un token valide existe pour cet agent/owner.

Si **aucun token n'est disponible** ou que le token est **expiré et non-rafraîchissable**, le service retourne une erreur avec une URL d'authentification :

```json
{
  "type": "error",
  "content": "OAuth token expired and refresh token is invalid. Please re-authenticate: https://claude.ai/oauth/authorize?...",
  "login_url": "https://claude.ai/oauth/authorize?client_id=...&response_type=code&redirect_uri=...&scope=...&code_challenge=...&code_challenge_method=S256&state=..."
}
```

> **Important** : Le CLI Claude Code **n'est pas lancé** si aucun token valide n'est disponible. Cela évite de gaspiller des ressources sur un processus qui échouera immédiatement.

### Étape 2 — L'utilisateur s'authentifie dans son navigateur

L'utilisateur ouvre le `login_url` dans son navigateur :

1. Il se connecte à son compte **claude.ai** (ou consent l'autorisation s'il est déjà connecté)
2. Anthropic redirige vers `https://platform.claude.com/oauth/code/callback`
3. La page de callback affiche un **code de vérification** au format : `<auth_code>#<state>`

### Étape 3 — L'utilisateur renvoie le code dans le chat

L'utilisateur copie-colle le code de vérification directement dans la conversation chat.

Le coder-service détecte automatiquement ce code grâce à la fonction `_extract_code_from_prompt()` qui :
- Extrait le dernier message `User:` de la conversation
- Vérifie s'il correspond au pattern `^[A-Za-z0-9_#-]{20,}$` (code alphanumérique d'au moins 20 caractères)

### Étape 4 — Échange du code contre un token

Si un code est détecté, `_exchange_auth_code()` est appelée :

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<auth_code>
&state=<state>
&client_id=9d1c250a-...
&redirect_uri=https://platform.claude.com/oauth/code/callback
&code_verifier=<code_verifier_pkce>
```

> **Note technique** : La requête HTTP est exécutée via un sous-processus **Node.js** (`node -e "..."`) car Cloudflare bloque l'empreinte TLS de Python (`urllib`/`httpx`) avec une fausse réponse 429. Node.js utilise la même stack TLS que le CLI Claude Code et passe Cloudflare.

### Étape 5 — Sauvegarde du token

En cas de succès, le token est persisté :

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "dGhp...",
  "expiresAt": 1750000000000,
  "scopes": ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"]
}
```

Le fichier est sauvegardé au niveau owner (`/app/data/users/<owner_id>/oauth_token.json`) ou agent selon le contexte.

Le service retourne alors :

```json
{
  "type": "result",
  "content": "Authentication successful (user@example.com). You can now send your request."
}
```

L'utilisateur peut maintenant renvoyer sa requête originale.

---

## Diagramme de séquence

```
Utilisateur          Frontend/API         Coder-Service          claude.ai
    │                    │                     │                     │
    │  envoie message    │                     │                     │
    │───────────────────►│  POST /stream       │                     │
    │                    │────────────────────►│                     │
    │                    │                     │  pas de token valide│
    │                    │  ◄── error +        │                     │
    │  ◄── affiche URL   │      login_url      │                     │
    │                    │                     │                     │
    │  ouvre login_url ──────────────────────────────────────────────►│
    │                    │                     │                     │
    │  ◄── code de vérification (auth_code#state) ◄──────────────────│
    │                    │                     │                     │
    │  colle le code     │                     │                     │
    │───────────────────►│  POST /stream       │                     │
    │                    │────────────────────►│                     │
    │                    │                     │  _extract_code()    │
    │                    │                     │  détecte le code    │
    │                    │                     │                     │
    │                    │                     │  POST /v1/oauth/token
    │                    │                     │────────────────────►│
    │                    │                     │  ◄── access_token   │
    │                    │                     │      refresh_token  │
    │                    │                     │                     │
    │                    │  ◄── "Auth OK"      │  sauvegarde token   │
    │  ◄── "Auth OK"     │                     │                     │
    │                    │                     │                     │
    │  renvoie requête   │                     │                     │
    │───────────────────►│  POST /stream       │                     │
    │                    │────────────────────►│  lance claude CLI   │
    │  ◄── streaming     │  ◄── streaming      │  avec token OAuth   │
```

---

## Rafraîchissement automatique des tokens

Les tokens OAuth expirent après **8 heures** (`expires_in: 28800`). Le coder-service rafraîchit les tokens de manière **proactive** avant chaque requête :

1. **Vérification de l'expiration** : `_is_*_token_expired()` compare `expiresAt` avec l'heure actuelle + marge de 5 minutes
2. **Rafraîchissement** : Si expiré, `_refresh_*_token()` envoie :

```
POST https://platform.claude.com/v1/oauth/token
grant_type=refresh_token
&client_id=9d1c250a-...
&refresh_token=<refresh_token>
```

3. **Succès** : Le nouveau token est sauvegardé, la requête continue normalement
4. **Échec** : Si le token existant est encore valide (pas encore expiré côté serveur), la requête continue quand même avec un warning

### Gestion du `invalid_grant`

Quand le refresh token est **révoqué** ou **définitivement expiré**, le serveur OAuth retourne :

```json
HTTP 400
{"error": "invalid_grant"}
```

Le coder-service réagit :

1. **Détecte** l'erreur dans `_token_http_request()` → retourne `{"_invalid_grant": True}`
2. **Invalide** les tokens stockés sur disque (`_invalidate_*_token()`)
3. **Active un cooldown** de 60 secondes pour éviter les requêtes en boucle
4. **Court-circuite** les requêtes suivantes : retourne directement un `login_url` sans lancer le CLI

Cela empêche la **boucle d'authentification infinie** qui survenait quand un refresh token invalide était conservé sur disque.

---

## Détection d'erreurs d'auth en cours de stream

Si le CLI Claude Code retourne une erreur d'authentification **pendant** l'exécution (token expiré entre le lancement et la réponse), le coder-service :

1. **Détecte** les messages `"token has expired"`, `"authentication_error" + "401"`, ou `"not logged in"` dans la sortie
2. **Termine** le processus CLI
3. **Tente un refresh** automatique du token
4. **Relance** la requête si le refresh a réussi (jusqu'à 3 tentatives max)
5. **Retourne un `login_url`** si tous les retries échouent

> Seuls les messages non-JSON (stderr) et les événements JSON de type `system`/`error` sont vérifiés pour l'auth. Les messages normaux du modèle sont ignorés pour éviter les faux positifs quand la conversation mentionne le mot "authentication".

---

## Endpoints REST d'authentification

### Global

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/auth/status` | Vérifie le statut d'auth (utilise `claude auth status`) |
| `POST` | `/auth/login` | Initie un flow OAuth PKCE global |
| `POST` | `/auth/token` | Définit un token OAuth manuellement (via `claude setup-token`) |

### Par Agent

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/auth/agent/{agent_id}/status` | Vérifie si un agent a un token valide |
| `POST` | `/auth/agent/{agent_id}/login` | Initie un flow OAuth PKCE pour un agent |
| `POST` | `/auth/agent/{agent_id}/callback` | Échange le code de vérification pour un agent |
| `POST` | `/auth/agent/{agent_id}/token` | Définit un token manuellement pour un agent |

### Par Owner (utilisateur PulsarTeam)

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/auth/owner/{owner_id}/status` | Vérifie si un owner a un token valide |
| `POST` | `/auth/owner/{owner_id}/login` | Initie un flow OAuth PKCE pour un owner |
| `POST` | `/auth/owner/{owner_id}/callback` | Échange le code de vérification pour un owner |

> Tous les endpoints nécessitent le header `X-Api-Key` ou `Authorization: Bearer <api_key>` correspondant à `CODER_API_KEY`.

---

## Communication inter-services

L'API Node.js communique avec le coder-service via une **clé API interne** (`CODER_API_KEY`) :

```
docker-compose.yml:
  api:
    environment:
      - CODER_API_KEY=xxx
  coder-service:
    environment:
      - API_KEY=xxx        # même valeur que CODER_API_KEY
```

Cette clé est envoyée dans le header `X-Api-Key` par le `CoderExecutionProvider` :

```javascript
_headers(agentId) {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': this.apiKey,
    'X-Agent-Id': agentId || '',
    'X-Owner-Id': this.ownerIds.get(agentId) || '',
  };
}
```

Le `X-Owner-Id` permet au coder-service de résoudre le bon token OAuth pour cet agent.

---

## Résumé du PKCE (Proof Key for Code Exchange)

Le PKCE protège contre l'interception du code d'autorisation (pas de `client_secret` pour un client public) :

1. **`code_verifier`** : chaîne aléatoire de 128 caractères générée côté serveur
2. **`code_challenge`** : `BASE64URL(SHA256(code_verifier))` — envoyé dans l'URL d'autorisation
3. Lors de l'échange du code, le `code_verifier` original est envoyé au serveur de tokens
4. Le serveur vérifie que `SHA256(code_verifier) == code_challenge` — prouvant que c'est le même client qui a initié le flow

Chaque flow (global, agent, owner) maintient son propre `code_verifier` en mémoire, ce qui permet des flows OAuth concurrents pour différents agents/owners.

---

## Stockage sur disque

```
/app/data/
├── oauth_token                    # Token global (texte brut, legacy)
├── oauth_token.json               # Token global (JSON avec refresh + expiry)
├── users/
│   └── <owner_id>/
│       └── oauth_token.json       # Token par owner
└── agents/
    └── <agent_username>/
        ├── oauth_token.json       # Token par agent (legacy)
        ├── .claude/
        │   ├── settings.json      # Config MCP (copiée depuis le coder user)
        │   └── .credentials.json  # Format CLI Claude Code
        ├── .claude.json           # Bypass onboarding
        └── projects/
            └── <project_name>/    # Clone git par agent
```
