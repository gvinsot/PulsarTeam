# Investigation des affectations concurrentes — 11 septembre 2026

Service inspecté : `pulsarteam_team-api`, image `1.0.1143`, une réplique sur
`server-b`. Code local initial : `81138cd`. Lecture seule du cluster ; correctif
préparé localement, sans déploiement.

## Éléments observés dans les logs

Heures de Paris (UTC+2), tâche `a7b6e9ee-c3fa-4938-8f23-3b38bae2c38a`
(correction du filtrage Budget) :

- **16:56:58** : demande de reprise manuelle ; préparation de GPT #2.
- **16:56:59–16:57:00** : déplacement vers `execute`, sélection de CLAUDE #1
  par le workflow et injection du prompt, avec `status=idle`.
- **16:57:43** : arrêt de CLAUDE #1.
- **16:57:45.876** : nouvelle demande de reprise manuelle.
- **16:57:48.144** : le retry du workflow sélectionne à nouveau CLAUDE #1 et
  injecte le prompt.
- **16:58:18.915 et 16:58:33.451** : deux attentes d'exécution sur cette même
  tâche et CLAUDE #1, avec des chemins créateur différents (workflow et reprise).

Ces traces établissent un chevauchement workflow/reprise. Elles ne permettent
pas d'identifier avec certitude les deux affectations distinctes signalées par
l'utilisateur sans leurs identifiants.

## Causes et correctif

Les reprises utilisaient `_loopProcessing`, tandis que les actions de workflow
utilisaient les verrous et indicateurs de `agentSelector`. Aucun des deux
chemins ne réservait l'agent auprès de l'autre. Le statut `idle` du CLI ne
suffisait donc pas à établir sa disponibilité.

La réservation est désormais commune, synchrone, exclusive par agent **et** par
tâche. Elle couvre la préparation, l'exécution et le nettoyage final, et ne
devient pas périmée après 15 minutes tant que l'exécution reste active. Les
entrées de colonne sont différées pendant une reprise. Un refus de reprise ne
réinitialise pas les signaux d'exécution existants.

Autre défaut trouvé dans le code : `findAgentForAssignment` acceptait
explicitement les agents occupés. L'affectation automatique par rôle filtre
désormais le statut et la réservation avant les préférences de board/projet.
Les prises et libérations de réservation sont journalisées avec les IDs.

## Validation et portée

Tests de non-régression : workflow pendant une reprise, reprise pendant un
workflow, agent CLI `idle` mais réservé, exclusion des agents occupés,
réservation de plus de 20 minutes, libération idempotente et préservation des
signaux lors d'un refus. Suite API, TypeScript et lint contrôlés.

La réservation ajoutée est locale au processus API. Elle corrige les chemins
concurrents de la réplique inspectée ; elle ne constitue pas un verrou distribué
par agent entre plusieurs répliques et ne survit pas au redémarrage de l'API.
