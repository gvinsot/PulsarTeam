# Jira Integration

PulsarTeam can act as a **subprocess of a Jira board column**: tickets entering a specific Jira column are automatically imported into PulsarTeam, processed through your workflow, and moved to the next Jira column when done.

## Overview

```
Jira Board                    PulsarTeam Workflow
┌──────────┐                 ┌─────────────────────────────────────┐
│ Backlog  │                 │                                     │
├──────────┤                 │  ┌───────┐  ┌────────┐  ┌──────┐   │
│ En cours │──── trigger ───▶│  │Pending│→ │In Prog │→ │ Done │   │
├──────────┤                 │  └───────┘  └────────┘  └──┬───┘   │
│ Review   │◀── action ─────│                             │       │
├──────────┤                 └─────────────────────────────┼───────┘
│ Done     │                                               │
└──────────┘                              move_jira_status ─┘
```

- **Trigger** : quand un ticket Jira entre dans la colonne "En cours", il est créé dans la colonne "Pending" de PulsarTeam.
- **Action** : quand la task PulsarTeam atteint "Done", le ticket Jira est déplacé vers "Review".

## Setup

### 1. Variables d'environnement

Ajouter dans le fichier `.env` :

```env
# Jira board URL (laisser vide pour désactiver l'intégration)
JIRA_BOARD_URL=https://yourorg.atlassian.net/jira/software/projects/KEY/boards/1

# Authentification Jira Cloud (Basic auth)
JIRA_USER_EMAIL=your.email@example.com
JIRA_API_KEY=your-api-token

# Webhook temps réel (optionnel mais recommandé)
JIRA_WEBHOOK_URL=https://your-pulsar-domain.com/api/jira/webhook
JIRA_WEBHOOK_SECRET=a-strong-random-secret
```

### 2. Créer un API Token Jira

1. Aller sur https://id.atlassian.com/manage-profile/security/api-tokens
2. Cliquer **Create API token**
3. Copier le token dans `JIRA_API_KEY`
4. `JIRA_USER_EMAIL` doit correspondre au compte Atlassian qui a créé le token

### 3. Docker Compose

Les variables sont déjà déclarées dans `docker-compose.yml` et `devops/docker-compose.swarm.yml`. Après modification du `.env`, recréer le container :

```bash
docker compose up -d --build api
```

## Configuration dans le Workflow

L'intégration se configure entièrement dans **Workflow Configuration** (icône engrenage sur le board des tasks).

### Trigger : importer les tickets Jira

1. Ajouter une transition sur la colonne d'entrée (ex: "Pending")
2. Sélectionner le trigger **🔗 Jira ticket**
3. Cocher la ou les colonnes Jira à surveiller (ex: "En cours")

Chaque ticket qui entre dans cette colonne Jira sera automatiquement créé comme task dans PulsarTeam.

### Action : déplacer le ticket Jira

1. Ajouter une transition sur la colonne de sortie (ex: "Done")
2. Ajouter l'action **🔗 Move Jira ticket to status**
3. Sélectionner la colonne Jira cible (ex: "Review")

Quand une task PulsarTeam atteint cette colonne, le ticket Jira est transitionné vers le statut cible.

> **Note** : ces options n'apparaissent dans le Workflow Configuration que si `JIRA_BOARD_URL` est défini.

## Synchronisation

### Polling (automatique)

PulsarTeam interroge Jira toutes les **60 secondes** pour détecter les nouveaux tickets correspondant aux triggers configurés. C'est le mode par défaut, aucune configuration réseau requise.

### Webhook (temps réel, recommandé)

Pour une détection instantanée, configurer un webhook Jira :

#### Auto-registration

Si `JIRA_WEBHOOK_URL` est défini, PulsarTeam tente d'enregistrer automatiquement le webhook au démarrage via l'API Jira. Si l'auto-registration échoue (permissions), les instructions pour l'enregistrement manuel sont loggées.

#### Enregistrement manuel

Dans Jira : **Settings > System > WebHooks** :

| Champ | Valeur |
|---|---|
| URL | `https://your-domain.com/api/jira/webhook` |
| Events | Issue Created, Issue Updated |
| JQL filter | `project = KEY` (remplacer KEY par votre clé projet) |

Dans la configuration Jira du webhook, définir le header HTTP :

```
X-Automation-Webhook-Token: votre-secret
```

(La valeur doit correspondre à `JIRA_WEBHOOK_SECRET` dans le `.env`)

#### Sécurité du webhook

L'endpoint `POST /api/jira/webhook` est public (pas de JWT — Jira ne peut pas s'authentifier avec notre token). La sécurité repose sur le header `X-Automation-Webhook-Token` :

- Chaque requête doit contenir ce header avec la valeur de `JIRA_WEBHOOK_SECRET`
- Si le header est absent ou incorrect → HTTP 401
- Si `JIRA_WEBHOOK_SECRET` n'est pas défini, il fallback sur `JIRA_API_KEY`

## Comportement détaillé

### Import de tickets

- Les tickets sont dédupliqués par clé Jira (`KAN-1`, `KAN-2`, etc.)
- Le titre de la task est formaté `[KAN-1] Titre du ticket`
- La task est assignée au premier agent leader disponible, sinon au premier agent actif
- Les métadonnées Jira (`jiraKey`, `jiraStatusId`) sont stockées sur la task

### Transition Jira

Quand l'action `move_jira_status` est déclenchée :
1. PulsarTeam récupère les transitions disponibles pour le ticket via l'API Jira
2. Il cherche une transition dont le statut cible correspond aux IDs configurés
3. Si trouvée, la transition est exécutée
4. Si aucune transition valide n'est disponible (contraintes de workflow Jira), un warning est loggé

### Anti-boucle

- Les changements de statut initiés par `jira-sync` ne déclenchent pas de push retour vers Jira
- Le webhook ne re-importe pas les tickets déjà trackés

## Troubleshooting

### Vérifier la connexion Jira

```bash
# Tester l'authentification
curl -u "email@example.com:API_TOKEN" \
  https://yourorg.atlassian.net/rest/api/3/myself

# Tester la configuration du board
curl -u "email@example.com:API_TOKEN" \
  https://yourorg.atlassian.net/rest/agile/1.0/board/BOARD_ID/configuration
```

### Logs utiles

```
[Jira] Sync enabled for ...          → intégration activée
[Jira] Webhook registered: ...       → webhook enregistré
[Jira] Imported KAN-1 "..." → ...    → ticket importé
[Jira] Moved KAN-1 → Review          → ticket déplacé dans Jira
[Jira] No transition for KAN-1 ...   → transition Jira non disponible
```

### Problèmes courants

| Problème | Cause | Solution |
|---|---|---|
| `401 Unauthorized` | Token invalide ou email incorrect | Recréer le token, vérifier l'email |
| `403 Forbidden` | Token de type Connect (ATCTT3x) | Utiliser un API token utilisateur (id.atlassian.com) |
| Pas de bouton Jira dans le workflow | `JIRA_BOARD_URL` non défini ou container pas rebuild | Vérifier `.env` + `docker compose up -d --build api` |
| Tickets non importés | Aucun trigger `jira_ticket` configuré | Ajouter un trigger dans Workflow Configuration |
| Ticket Jira ne bouge pas | Pas d'action `move_jira_status` ou transition Jira bloquée | Vérifier les transitions Jira disponibles |

## Architecture

```
api/src/services/jiraSync.js   — Service principal (poll, webhook, push)
api/src/routes/jira.js          — Routes API (/status, /columns, /sync, /webhook)
api/src/index.js                — Montage routes + démarrage polling + auto-register webhook
```

Les transitions Jira sont stockées dans le workflow PulsarTeam (table `settings`, clé `workflow:_default`) comme des transitions standard avec :
- `trigger: "jira_ticket"` + `jiraStatusIds: ["10001", ...]`
- `actions: [{ type: "move_jira_status", jiraStatusIds: ["10002", ...] }]`
