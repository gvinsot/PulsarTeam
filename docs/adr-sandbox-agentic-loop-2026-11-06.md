# ADR — Améliorer la boucle agentique du runner Sandbox

- **Statut** : Proposé
- **Date** : 2026-11-06
- **Auteur** : Software Architect
- **Périmètre** : `api/src/services/agentManager/{chat,tools,compaction}.ts`,
  `api/src/services/{agentTools,nativeTools}.ts`,
  `api/src/services/execution/runnerExecutionProvider.ts`,
  `runner-service/` (lot 4 uniquement)

## Contexte

Avec `RUNNER_TYPE=sandbox`, le runner-service n'héberge aucun LLM : il expose
seulement l'exécution (`/exec-shell`, `/projects/ensure`, …). Toute la boucle
agentique vit dans l'API :

1. `chat.ts › sendMessage` appelle `_streamAndContinue` avec
   `NATIVE_TOOL_DEFINITIONS`.
2. Tant que le modèle renvoie des `toolCalls` (au plus `MAX_NATIVE_TOOL_ROUNDS = 40`),
   `tools.ts › _processToolCalls` les exécute **séquentiellement**, puis les
   résultats sont poussés en messages `role: 'tool'` sous la forme
   `{success, result, error}`.
3. En fin de tour, seule une entrée `assistant` (texte ou
   `"(used tools: …)"` + `nativeToolTrace`) est enregistrée dans
   `conversationHistory`.
4. Si la tâche n'est pas close, `tasks.ts › _reminderLoop` renvoie un
   `[SYSTEM REMINDER]` qui démarre un nouveau tour.

Les outils disponibles sont `read_file`, `write_file`, `append_file`,
`list_dir`, `search_files` et `run_command` (`agentTools.ts`), plus les outils
de gestion (tâches, MCP, agents).

## Problèmes constatés (lecture du code)

| # | Problème | Où | Effet |
|---|----------|----|-------|
| P1 | Les messages `role: 'tool'` ne sont jamais persistés ni rejoués ; `nativeToolTrace` n'est lue que par la compaction mécanique | `chat.ts` (boucle native), `_assembleMessages` | Après un rappel ou une reprise, le modèle a perdu tout ce qu'il a lu, modifié ou testé. |
| P2 | `run_command` renvoie `success: true` dès qu'il y a une sortie ; l'`exitCode` reste dans `meta`, qui n'est pas transmis au modèle | `agentTools.ts › toolRunCommand`, `chat.ts` | Un build ou un test en échec ressemble à une réussite. |
| P3 | Sorties coupées avec `.slice(0, 10000)` (début conservé) ; `_truncateMessagesToFit` garde aussi le début | `agentTools.ts`, `compaction.ts` | L'erreur, presque toujours en fin de sortie, disparaît. |
| P4 | Le garde-fou matche hors position de commande : `/\bservice\s/` bloque `cd runner-service && …` | `agentTools.ts › BLOCKED_COMMAND_PATTERNS` | Faux positifs : des commandes légitimes sont refusées (constaté pendant l'analyse). |
| P5 | Pas d'outil d'édition partielle : il faut réécrire tout le fichier avec `write_file` | `nativeTools.ts` | Tokens gaspillés, risque d'écraser un fichier lu tronqué (> 500 lignes). |
| P6 | `read_file` renvoie les lignes sans numéro | `agentTools.ts › toolReadFile` | Modifications imprécises, relectures inutiles. |
| P7 | `search_files` = `grep -r` sans regex ni contexte, sans `.gitignore`, limité à 50 lignes ; pas d'outil `glob` | `runnerExecutionProvider.ts › searchFiles` | Résultats bruités (`node_modules`), exploration lente. |
| P8 | Outils exécutés séquentiellement, y compris en lecture seule | `tools.ts › _processToolCalls` | Latence par tour multipliée. |
| P9 | `run_command` : timeout fixe de 5 min, pas d'exécution en arrière-plan, pas de `cwd` persistant | `agentTools.ts` | Serveurs de dev et longues suites de tests impossibles. |
| P10 | Pas de plan persistant, pas de détection de boucle, aucune vérification avant `update_task` final | `chat.ts`, `tools.ts` | Dérive sur les longues tâches ; clôture avec du travail non commité. |

## Décision

Faire évoluer la boucle en **4 lots incrémentaux**, chacun livrable et
réversible seul. Les CLI runners (`claude-code`, `opencode`, …) ne sont pas
concernés : `isCliRunner(agent)` continue de court-circuiter la boucle native.

### Lot 1 — Fiabilité des retours d'outils (P2, P3, P4, P6)

1. **Code de sortie visible** : le JSON transmis au modèle par `chat.ts` inclut
   `exit_code` (et `truncated`) lorsque `meta` les porte. `run_command` préfixe
   aussi sa sortie par `exit_code=N`.
2. **Troncature tête + queue** : un helper `truncateMiddle(text, max=10000, head=3000)`
   garde le début et la fin avec le marqueur
   `[... N chars / M lines omitted ...]`. Il est utilisé par `run_command` et par
   `_truncateMessagesToFit` pour les messages `role: 'tool'`.
3. **Garde-fou ancré** : les motifs de `BLOCKED_COMMAND_PATTERNS` ne matchent
   qu'en position de commande, c.-à-d. `(^|[;&|(]\s*|\bsudo\s+)<cmd>\b`. Tests
   unitaires positifs et négatifs (`cd runner-service`, `git log --format=%nft`, …).
4. **Numéros de ligne dans `read_file`** : format `cat -n`
   (`%6d\t<ligne>`) ; le marqueur de troncature indique la plage suivante à lire.

### Lot 2 — Mémoire de travail et édition (P1, P5)

5. **Outil `edit_file(path, old_string, new_string, replace_all=false)`** :
   - erreur si `old_string` est absent, ou présent plusieurs fois sans `replace_all` ;
   - renvoie un diff unifié court ;
   - implémenté côté API sur `readFile`/`writeFile`, puis migré vers `/fs/edit`
     au lot 4.
6. **Rejouer les résultats d'outils** : `_assembleMessages` convertit
   `nativeToolTrace` en paires `assistant{toolCalls}` + `tool{toolCallId}`.
   - Les K derniers résultats (par défaut 8) sont gardés en entier.
   - Les plus anciens sont réduits à une ligne (`read_file X L1-200 ✓`,
     `run_command "npm test" exit=1`).
   - Le format est compatible avec les mappers existants (`mapOpenAIMessages`,
     `mapResponsesInput`, Anthropic `tool_use_id`).

### Lot 3 — Efficacité de la boucle (P7, P8, P9, P10 partiel)

7. **`search_files` v2** : `rg` en priorité, repli sur `grep`, avec les paramètres
   `regex`, `case_sensitive`, `context_lines`, `files_only`, `max_results`. Nouvel
   outil `glob(pattern)`.
8. **Lecture en parallèle** : dans un même tour, les appels `read_file`,
   `list_dir`, `search_files` et `glob` sont exécutés avec `Promise.all`. Les
   écritures et les commandes restent séquentielles, et l'ordre des résultats est
   conservé.
9. **`run_command` v2** : `timeout_s` (plafonné à 30 min), `background: true` qui
   renvoie un `command_id`, et les outils `read_output(command_id)` et
   `kill(command_id)`.
10. **Plan persistant** : outil `todo_write(items)`, stocké sur l'agent par tâche
    et réinjecté dans le prompt système. Le plan survit à la compaction.

### Lot 4 — Garde-fous de complétion et infrastructure (P10)

11. **Détection de boucle** : même appel avec les mêmes arguments ×3, ou même
    erreur ×3, déclenche l'injection d'un message de recadrage.
    `MAX_NATIVE_TOOL_ROUNDS` devient configurable par agent.
12. **Pré-vérification de `update_task` terminal** : si `git status --porcelain`
    n'est pas vide, ou si le dernier `run_command` de test a `exit_code ≠ 0`, le
    premier appel renvoie un avertissement au modèle. Un second appel force la
    clôture.
13. **API fichiers native du runner** : `/fs/read|write|edit|glob|grep` avec
    erreurs typées, à la place des commandes `sh` construites côté API.
14. **Observabilité** : métriques par outil (taux d'erreur, latence), nombre de
    tours par tâche, et part du contexte occupée par les résultats d'outils.

## Alternatives écartées

- **Basculer tous les agents sur un CLI runner (claude-code/opencode)** : perte
  du contrôle fin (hooks, profils de sécurité, gitReconcile), coût et
  dépendance fournisseur. Le mode sandbox reste nécessaire pour les LLM
  « bruts » (Ollama, vLLM, Mistral…).
- **Outil `apply_patch` (diff unifié)** au lieu de `edit_file` : plus puissant,
  mais beaucoup plus fragile avec les modèles moyens. Il pourra s'ajouter plus
  tard.
- **Persister les résultats bruts sans compaction** : explosion du contexte et
  des écritures DB.

## Conséquences

- **Positives** : moins de faux succès, moins de relectures, contexte conservé
  entre les rappels, moins de tokens par modification, latence par tour plus
  faible.
- **Négatives / risques** :
  - L'historique grossit (lot 2) : il faut le plafonner (K, taille par résultat)
    et tester la compaction.
  - Le changement de format de `read_file` et `run_command` (numéros de ligne,
    `exit_code`) peut perturber des prompts existants : à mentionner dans les
    descriptions d'outils.
  - L'exécution parallèle demande que `executeTool` soit sans état partagé (le
    cache `list_dir` est déjà par chemin, donc compatible).
- **Réversibilité** : chaque lot est protégé par un flag d'environnement
  (`AGENT_LOOP_V2_LOT{n}`, activé par défaut une fois validé).

## Validation

- Tests unitaires par lot (`api/src/services/__tests__/`).
- Scénario de non-régression sur le board **TestBoard** (colonne
  `testagentsandbox`) : une tâche « corriger un test qui échoue » qui doit
  constater l'échec (`exit_code`), modifier le code avec `edit_file`, relancer le
  test, commiter et clôturer.
- Indicateurs avant/après : tours par tâche, tokens par tâche, taux de tâches
  terminées sans rappel.
### Mesure (lot 4 §14, livré en avance pour la base de comparaison)

Chaque tour natif servi pour une tâche ajoute une entrée `type: "loop-metrics"`
à `task.history` (`api/src/services/agentManager/loopMetrics.ts`, écrite par
`chat.ts`) : appels d'outils (nom, durée, succès, `exit_code`, taille, troncature),
appels LLM, tours d'outils, tokens d'entrée et de sortie, rappel ou non, et part
estimée du contexte occupée par les résultats d'outils. Chaque entrée porte
`lots` (flags `AGENT_LOOP_V2_LOT{n}` actifs, via `activeLoopLots()`). `[]`
correspond à la **base** : toutes les mesures prises avant l'activation des
lots 1 et 2 y sont rangées.

- Par tâche : `GET /api/tasks/:id/loop-metrics` (onglet Costs → « Agent loop »).
- Agrégé : `GET /api/agents/tasks/stats` → `loopMetrics.byLots.baseline` comparé à
  `loopMetrics.byLots["lots:1+2"]`.
- Un appel est en échec si `success: false` **ou** si `exit_code ≠ 0`. On voit
  donc les faux succès de `run_command` (P2) dès la base.
- Les lots 1 à 3 doivent lire leur flag avec `activeLoopLots()`, pour que les
  entrées restent bien étiquetées.
