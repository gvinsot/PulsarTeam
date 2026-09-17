# MCP distants : catalogue et connexions

Dans les plugins d’un agent ou d’un board, **Parcourir le catalogue MCP** interroge le registre officiel `registry.modelcontextprotocol.io`. Sélectionner un serveur, son endpoint et le mode indiqué par son fournisseur :

- **OAuth / Connecter** : autorisation dans une fenêtre du navigateur, puis renouvellement automatique des jetons. L’enregistrement dynamique (DCR) et les Client ID Metadata Documents (CIMD) sont pris en charge par le SDK. Pour un fournisseur imposant une application préenregistrée, saisir son Client ID et, si requis, son Client Secret dans les options de connexion.
- **Clé API / Configurer** : clé saisie dans un champ masqué, en-tête configurable (`Authorization`, `X-Api-Key`, etc.), format `Bearer <clé>` ou clé seule. **Tester la connexion** vérifie l’accès et découvre les outils ; l’enregistrement de la clé seul ne prouve pas sa validité.

L’ajout crée un plugin privé et l’attache à l’agent ou au board sélectionné. Partager sa définition ne partage pas les accès. Une connexion de board est utilisable par ses agents. Une connexion propre à l’agent prend priorité ; une connexion existante invalide ne provoque pas l’adoption d’un autre compte. L’identité du board est relue sur l’agent en base.

Les MCP importés passent par la passerelle Pulsar. Leurs clés et jetons ne sont ni stockés dans les plugins ni injectés dans les configurations des runners. Les inventaires d’outils distants sont découverts avec la connexion du compte concerné, sans cache global partagé entre comptes. Les appels d’outils ne sont pas rejoués automatiquement après une erreur.

## Périmètre

Cette version importe les endpoints **HTTPS publics Streamable HTTP**, concrets (sans paramètres `{tenant}`), avec au plus un en-tête obligatoire. Les packages locaux/stdio et les connexions nécessitant plusieurs secrets ne sont pas proposés. Le registre ne certifie pas le mode d’authentification ni la compatibilité d’un serveur ; le mode est choisi explicitement et la connexion reste à vérifier. Les plugins natifs Gmail, etc. restent disponibles.

Le catalogue conserve un cache de cinq minutes, recherche et pagination comprises. Les fiches conservent la version sélectionnée : aucune mise à niveau automatique. Les appels existants restent possibles si le catalogue est indisponible. Aucun registre supplémentaire à déployer.

## Authentification et exploitation

- Les connexions et les demandes OAuth/PKCE sont chiffrées avec `ENCRYPTION_KEY`, dans `remote_mcp_connections` et `remote_mcp_oauth_flows`.
- La migration `202609170001_remote_mcp_connections` est appliquée au démarrage. PostgreSQL et la clé de chiffrement sont requis. Les différentes répliques doivent partager cette base et la clé.
- Callback public : `https://<hôte-pulsarteam>/api/remote-mcp/oauth/callback`. Document client public : `/api/remote-mcp/oauth/client-metadata`. Les applications préenregistrées doivent autoriser exactement cette URL de retour.
- Les demandes OAuth expirent après dix minutes ; leur consommation est atomique en base. Le callback revérifie les droits de l’utilisateur. Les renouvellements et déconnexions d’une même connexion sont sérialisés entre répliques ; une opération concurrente reçoit une invitation à réessayer.
- Déconnecter supprime les secrets locaux et les autorisations en attente. Cela ne révoque pas le consentement dans le compte du fournisseur : utiliser aussi ses réglages de sécurité si nécessaire.
- Les destinations privées sont refusées, y compris lors de la résolution DNS effective et de la découverte OAuth. Les redirections HTTP sont refusées pour éviter de transférer des secrets ; utiliser l’URL HTTPS finale du fournisseur.

## Changement pour les connexions existantes

La résolution des intégrations natives utilise désormais **agent → board → erreur**. Le repli qui choisissait le premier jeton utilisateur disponible est supprimé. Les jetons utilisateur existants ne sont pas effacés, mais un agent qui dépendait de ce repli doit être reconnecté explicitement depuis ses plugins ou ceux de son board.

## Validation

`remoteMcp.test.ts` utilise le vrai SDK MCP et un fournisseur HTTP simulé : découverte OAuth, PKCE, DCR/CIMD, échange, renouvellement, chiffrement, isolation, contrôle d’accès, callbacks à usage unique, clés API et filtrage du catalogue. `oauthScopeResolution.test.ts` couvre la suppression du repli utilisateur. Un essai avec un compte réel reste nécessaire pour chaque fournisseur avant de le considérer validé en production.
