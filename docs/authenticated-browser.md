# Navigateur authentifié sur le cluster

Le plugin intégré **Navigateur authentifié** expose un MCP local dans l’API
PulsarTeam, `/api/auth-browser/mcp`. Un service privé `mcp-auth-browser` exécute
Chromium avec Playwright sur le cluster. Aucun prestataire de navigateur tiers.

## Utilisation : connexion locale, navigation sur le cluster

1. Ajouter le plugin à un agent ou à un board. Ouvrir PulsarTeam **en HTTPS** dans
   Chrome ou Edge (hors navigation privée).
2. Installer l’extension **PulsarTeam — Partager une session**. Le plugin propose
   son téléchargement ZIP : décompresser, ouvrir `chrome://extensions` ou
   `edge://extensions`, activer le mode développeur, puis **Charger l’extension
   non empaquetée**. Le code source est dans `frontend/browser-session-extension`.
   L’archive est générée automatiquement par `npm run dev` / `npm run build`.
   Cette version n’est pas publiée dans un store.
3. Saisir l’origine HTTPS exacte du site, par exemple `https://www.linkedin.com/`,
   puis **Connecter dans mon navigateur**. Une demande valable dix minutes est
   liée à cet utilisateur et à cet agent/board. Aucun Chromium n’est encore lancé.
4. Depuis cet onglet PulsarTeam, ouvrir l’extension et vérifier le site et le
   serveur destinataire affichés. **Ouvrir le site** demande les permissions pour
   ces deux origines et les domaines parents du site portant ses cookies, puis ouvre
   un onglet dédié dans le même profil. Aucun accès global à tous les sites.
5. Se connecter normalement dans cet onglet, avec SSO/MFA si nécessaire. Revenir
   sur l’origine choisie et vérifier le compte connecté. Aucun mot de passe ni
   code MFA n’est saisi dans PulsarTeam ou dans un aperçu distant.
6. Depuis cet onglet du site, ouvrir l’extension et cliquer **Transférer la session**.
   Les cookies de ce site (y compris HttpOnly) sont copiés sur le cluster. Le
   stockage local peut être inclus, sur choix explicite, si le site en a besoin.
   Garder l’onglet PulsarTeam ouvert : il effectue l’import avec sa session et sa
   protection CSRF habituelles. L’extension n’utilise ni endpoint public d’import,
   ni jeton utilisateur générique, ni compte/onglet sélectionné automatiquement.
7. Après import, les agents utilisent Chromium sur le cluster. **Suspendre** bloque
   leur accès ; **Reprendre le partage** le rétablit. **Déconnecter** détruit la
   copie distante. Pour renouveler/changer de compte, déconnecter puis recommencer.

Le transfert vaut partage explicite ; il ne certifie pas que le site a accepté
la copie de session. Seul le créateur peut importer ou reprendre sa session.
Les autres éditeurs autorisés peuvent la révoquer. Les utilisateurs pouvant
lancer les agents du board peuvent consulter les données du compte partagé.
La déconnexion sur le cluster ne déconnecte pas votre navigateur local et ne
révoque pas automatiquement les autorisations chez le fournisseur.

### Protection du transfert

- Le worker lie un identifiant à usage unique au site, à l’utilisateur et au scope ;
  expiration dix minutes, refus du rejeu, d’un autre utilisateur ou d’un autre scope.
- L’extension vérifie l’onglet source exact, son profil de cookies, le document
  PulsarTeam original, son origine HTTPS et la demande encore présente avant
  tout transfert. Recharger/changer l’onglet PulsarTeam exige de recommencer la liaison.
- Les cookies transférés sont ceux applicables à l’accueil ou à la page actuelle
  du site. Les domaines parents sont réduits à l’hôte exact à l’import et `Secure`
  est forcé ; aucun cookie d’un fournisseur SSO tiers n’est exporté. Aucun mot de
  passe enregistré, historique ou profil complet n’est copié.
- Aucun export JSON sur disque : données transitoires dans l’extension, le client
  et l’API, puis profil temporaire du worker. Pas de cookies dans les URL, les
  attributs DOM, les logs, React state ou le stockage de l’extension. Les données
  traversent néanmoins le JavaScript de PulsarTeam : sa protection contre XSS et
  la confiance dans l’instance restent essentielles.
- Les autorisations optionnelles ajoutées par la liaison sont retirées à sa fin,
  à son annulation ou expiration. L’extension ne possède pas d’accès permanent
  à tous les sites. Les permissions concernent des hôtes exacts, sans joker ; la
  liste des suffixes publics/privés de `tldts` borne les domaines parents demandés.
  Le domaine de PulsarTeam lui-même ne peut pas être exporté. Seules les métadonnées de liaison résident dans
  `chrome.storage.session`, jamais les cookies.

## OAuth et LinkedIn

Il s’agit de **connexion web interactive**, y compris OAuth/SSO lorsque le site
le propose. Un jeton OAuth destiné à une API ne devient pas une session web.
Le plugin ne demande pas de client secret LinkedIn. Il copie explicitement la
session web obtenue dans le navigateur local, via l’extension.

L’OAuth officiel LinkedIn autorise des appels à ses API selon les produits et
permissions accordés ; il ne fournit pas un navigateur connecté à linkedin.com.
LinkedIn interdit diverses formes d’automatisation de son site et peut restreindre
un compte. La compatibilité de cette implémentation avec une vraie connexion
LinkedIn n’est pas validée. Aucune technique de dissimulation ou de contournement
des protections n’est intégrée. Utiliser l’API officielle pour les usages couverts
par les permissions accordées à l’application.

Sources : [OAuth LinkedIn](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow),
[règles LinkedIn](https://www.linkedin.com/help/linkedin/answer/a1340567/automated-activity-on-linkedin?lang=en),
[sessions Playwright](https://playwright.dev/docs/auth).

## Outils et limites

- `browser_status` : état de la session.
- `browser_read` : texte visible et liens sur la même origine.
- `browser_navigate` : ouvrir une page HTTPS sur cette origine exacte.
- `browser_scroll` : défiler et relire le contenu.

Pas d’outil d’exécution JavaScript arbitraire, d’export de cookies/storage,
de clic ou de soumission de formulaire pour l’agent. Le navigateur exécute
néanmoins le JavaScript des sites ; une navigation ou une requête GET peut avoir
des effets de bord sur un site mal conçu. Ce n’est pas une garantie universelle
de lecture seule. Les pages restent une source possible d’injection de prompt.

Les sous-ressources HTTPS publiques (CDN, images, scripts, iframes) sont autorisées
comme dans un navigateur normal. La restriction de domaine porte sur la navigation
principale. Le site et ses scripts peuvent donc transmettre des données à leurs
services externes. WebSockets, service workers, téléchargements et permissions
caméra/micro sont désactivés ; certains sites nécessitant ces fonctions ne marcheront
pas. Le MFA et les passkeys peuvent servir à la connexion locale, mais leurs clés ne
sont jamais exportées. Les cookies liés à un appareil, les cookies partitionnés,
IndexedDB et sessionStorage ne sont pas pris en charge. Un site peut refuser une
session copiée à cause du changement de navigateur/IP ou demander un nouveau
challenge. La connexion locale ne contourne pas ces restrictions.

Les cookies ne sont pas persistés dans une base ou un volume. Le profil temporaire
de Chromium réside dans `/tmp`, un tmpfs dans la stack. Expiration absolue : 8 h ;
inactivité : 30 min ; au maximum 6 sessions. Le polling d’état ne prolonge
pas la session. Une mise à jour ou un redémarrage du worker perd toutes les sessions.
Les cookies se renouvellent selon le comportement du site ; aucune promesse de
renouvellement OAuth automatique. Une expiration imposée par le site nécessite
une reconnexion manuelle. Déconnecter détruit la session ici, sans révoquer
automatiquement les autorisations OAuth accordées chez le fournisseur.

## Déploiement

La stack inclut le service et son build `mcp-auth-browser/Dockerfile`.
Provisionner **le même secret aléatoire d’au moins 32 caractères** `AUTH_BROWSER_KEY`
pour `team-api` et `mcp-auth-browser`. Ne pas réutiliser JWT_SECRET. PulsarCD monte
ce secret dans `/run/secrets/AUTH_BROWSER_KEY` ; les deux services lisent le fichier
en priorité, puis la variable d’environnement en développement. Vide : connecteur
désactivé. `AUTH_BROWSER_SERVICE_URL` est une configuration administrateur, jamais
une URL choisie par l’agent.

Le worker n’a aucun port publié et rejoint seulement le réseau overlay chiffré
`auth-browser`, partagé avec l’API. Il ne rejoint ni `backend`, ni le réseau
PostgreSQL. L’API autorise chaque contrôle au niveau `edit`, avec une véritable
session utilisateur et la protection CSRF existante. Les cookies/stockages transférés transitent par l’API ; TLS au niveau du point
d’entrée est requis. Aucun proxy de diagnostic ne doit enregistrer ces corps
de requêtes. Les anciennes commandes publiques de saisie/capture distante sont
retirées ; l’API accepte l’import uniquement depuis une session utilisateur avec
accès en écriture, et masque les erreurs de validation contenant des secrets.

Chaque session dispose d’un processus Chromium et d’un proxy CONNECT local.
Le proxy valide toutes les adresses DNS et se connecte à une IP validée, sans
nouvelle résolution : adresses privées/spéciales, rebinding et ports autres que
443 sont refusés. Les redirections et sous-ressources passent également par ce
proxy ; QUIC et WebRTC UDP direct sont désactivés. Ces protections applicatives
ne remplacent pas un pare-feu réseau ni un audit du navigateur.

Chromium est lancé non-root avec `chromium_sandbox=True`, sans repli automatique
vers `--no-sandbox`. Les hôtes doivent permettre le sandbox Chromium (user
namespaces et profil seccomp compatible). Vérifier ce prérequis sur le nœud cible
avec un test de connexion avant d’ouvrir le service aux utilisateurs. Ne pas
résoudre un échec de démarrage en désactivant le sandbox. La recette locale
Windows ne remplace pas la validation de l’image Linux sur le cluster.

### Particularités Swarm / PulsarCD

Le montage `/tmp` utilise la syntaxe longue `volumes: type: tmpfs`. Le raccourci
`tmpfs:` n’était pas appliqué par le déploiement Swarm, ce qui empêchait Chromium
de démarrer sur le système de fichiers racine en lecture seule.

Le navigateur est placé sur `server-b`, comme `team-api` : les flux de connexion
ne dépendent plus d’une liaison overlay chiffrée inter-nœuds. Le réseau dédié
reste chiffré et sans port publié.

`docker-compose.post.sh` applique un profil seccomp **uniquement à ce service**
via l’API Docker, ainsi que `NoNewPrivileges=true`. `docker stack deploy` ignore
ces options `security_opt` avec le CLI installé. Le hook respecte `STACK_NAME`,
y compris `qa-pulsarteam`, conserve l’image et les secrets et ne redémarre pas le
service si le profil est déjà conforme. Exécution manuelle sur le manager :

```sh
python3 devops/configure-auth-browser.py qa-pulsarteam
```

Le profil `devops/auth-browser-seccomp.json` dérive du
[profil Docker Moby](https://github.com/moby/profiles/blob/65adc7e022c97f55e45c054ff012988027733b87/seccomp/default.json).
Il ajoute `clone`, `setns`, `unshare` pour les namespaces du sandbox Chromium
([préconisation Playwright](https://playwright.dev/docs/docker)), ainsi que
`chroot` pour son sandbox avec `cap_drop: ALL`. Les vérifications de capacités
du noyau restent actives ; aucune capacité hôte n’est ajoutée et le profil
conserve son refus par défaut. Pas de `privileged`, de `seccomp=unconfined`
ou de `--no-sandbox`, et aucune modification globale du daemon Docker.

Le secret doit être défini **dans l’environnement utilisé** (QA et production
sont distincts) puis déployé aux deux services. Un secret valide n’implique pas
que le réseau ou Chromium fonctionne ; l’interface distingue maintenant une
configuration absente d’un service injoignable et permet de réessayer.

Les jetons MCP internes remis aux runners sont maintenant liés à leur agent et
board. Les en-têtes ne peuvent pas sélectionner un autre agent. **Régénérer les
configurations MCP / redémarrer les runners existants lors du déploiement** : leurs
anciens jetons sans cette liaison seront refusés sur les appels avec contexte.
Cette liaison protège la frontière MCP ; elle ne constitue pas un audit des autres
routes auxquelles des jetons de service pourraient avoir accès.

## Validation

Tests unitaires du worker :

```sh
python -m pip install -r mcp-auth-browser/requirements.txt
python -m unittest discover -s mcp-auth-browser/tests -v
```

Tests avec une vraie extension MV3 et Chromium, sur des sites simulés (exécuter
`npm run test:browser-extension` dans `frontend` auparavant pour préparer son bundle) :

```sh
python -m playwright install chromium
BROWSER_E2E=1 python -m unittest discover -s mcp-auth-browser/tests -v
```

Les scénarios couvrent l’import de cookies HttpOnly et de stockage local dans
un vrai Chromium, la restriction d’origine, la suspension, les refus de rejeu,
d’expiration et de changement d’utilisateur/scope. Les tests de l’extension :

```sh
cd frontend
npm run test:browser-extension
```

Le test MV3 préautorise les origines des sites simulés ; l’installation et les
dialogues natifs de permissions restent une vérification manuelle. Les tests
ne certifient pas une connexion LinkedIn réelle. Références techniques :
[API cookies Chrome](https://developer.chrome.com/docs/extensions/reference/api/cookies),
[état de session Playwright](https://playwright.dev/python/docs/auth).
