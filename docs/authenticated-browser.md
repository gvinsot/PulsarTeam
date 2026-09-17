# Navigateur authentifié sur le cluster

Le plugin intégré **Navigateur authentifié** expose un MCP local dans l’API
PulsarTeam, `/api/auth-browser/mcp`. Un service privé `mcp-auth-browser` exécute
Chromium avec Playwright sur le cluster. Aucun prestataire de navigateur tiers.

## Utilisation

1. Ajouter le plugin à un agent ou à un board.
2. Saisir l’adresse HTTPS exacte du site, par exemple `https://www.linkedin.com/`.
3. Si le site redirige vers un fournisseur de connexion, renseigner ses origines
   HTTPS dans « Domaines de connexion supplémentaires ». Exemple :
   `https://accounts.google.com`. Les origines sont exactes, sans joker ; inclure
   les autres origines de redirection si le fournisseur en utilise plusieurs.
4. Cliquer **Connecter**, puis effectuer la connexion/MFA dans l’aperçu interactif.
   Cliquer dans l’image pour taper au clavier ; le collage fonctionne. Une popup
   de connexion devient automatiquement la page affichée ; sa fermeture revient
   à l’onglet restant. Les téléchargements et dialogues JavaScript sont bloqués.
5. Revenir sur le site et vérifier le compte affiché. **Partager cette session**
   accorde alors l’accès à l’agent, ou aux agents du board choisi. Cela constitue
   une confirmation humaine, pas une détection automatique de connexion réussie.
6. **Reprendre la main** suspend immédiatement l’accès des agents.
   **Déconnecter** ferme le processus Chromium et détruit la session locale.

Seul l’utilisateur qui a ouvert la session peut voir/contrôler l’écran privé de
connexion. Les autres éditeurs autorisés du même agent/board peuvent révoquer la
session. Fermer l’aperçu ne partage pas la session et ne ferme pas Chromium.
Les utilisateurs qui peuvent lancer l’agent peuvent consulter les données de la
session partagée par cet agent : ne pas partager un compte personnel sur un board
dont les membres ne doivent pas avoir cet accès.

## OAuth et LinkedIn

Il s’agit de **connexion web interactive**, y compris OAuth/SSO lorsque le site
le propose. Un jeton OAuth destiné à une API ne devient pas une session web.
Le plugin ne demande ni client secret LinkedIn, ni export manuel de cookies.

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
pas. Les passkeys liées au poste local, certains CAPTCHA et certaines politiques
SSO peuvent être incompatibles avec ce navigateur distant.

Les cookies ne sont pas persistés dans une base ou un volume. Le profil temporaire
de Chromium réside dans `/tmp`, un tmpfs dans la stack. Expiration absolue : 8 h ;
inactivité : 30 min ; au maximum 6 sessions. Le polling d’images/état ne prolonge
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
session utilisateur et la protection CSRF existante. Les requêtes de contrôle,
captures et frappes transitent par l’API ; TLS au niveau du point d’entrée est
donc requis. Elles ne doivent pas être enregistrées par un proxy de diagnostic.

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

Test avec un vrai Chromium et un site/fournisseur de connexion simulés :

```sh
python -m playwright install chromium
BROWSER_E2E=1 python -m unittest discover -s mcp-auth-browser/tests -v
```

Le scénario teste l’écran de connexion, le partage explicite, l’exclusion du
champ mot de passe, la restriction d’origine et la reprise manuelle. Il ne
certifie pas OAuth LinkedIn ni la compatibilité d’un fournisseur réel.
