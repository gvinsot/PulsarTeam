# Pilotage vocal des agents

Le mode « Realtime » utilise la configuration LLM affectée à l’agent :

| Provider de la configuration | Modèle conseillé | Transport | Voix par défaut |
| --- | --- | --- | --- |
| `openai` | `gpt-realtime-2` | WebRTC | `alloy` |
| `google` (ou `gemini`) | `gemini-3.1-flash-live-preview` | Gemini Live WebSocket | `Kore` |

Créer la configuration avec sa clé API dans Admin Settings, puis l’affecter à un agent vocal. La sélection est disponible à la création et dans les paramètres de l’agent. Les voix proposées suivent le provider. Le mode externe STT + LLM + TTS reste distinct.

Les anciennes sélections `gpt-realtime` et `gpt-realtime-1.5` utilisent désormais `gpt-realtime-2`. Les modèles explicitement datés et les variantes mini sont conservés. Les variables `OPENAI_REALTIME_MODEL` et `GEMINI_LIVE_MODEL` permettent une surcharge au déploiement ; les laisser vides pour respecter les configurations des agents.

Les clés permanentes restent côté API. `/api/realtime/token` vérifie l’accès en écriture à l’agent et renvoie une session discriminée par `provider`, avec un jeton éphémère. Les jetons Gemini sont limités à une connexion et contraints au modèle, aux instructions et aux outils. Les réponses ne sont pas mises en cache.

Le contexte React gère le pilotage, les résultats d’outils et l’état affiché. Les adaptateurs dans `frontend/src/lib/voice` gèrent les transports, l’audio et leur nettoyage. Les outils sont communs aux deux providers ; `callId` corrèle chaque demande Socket.IO à son résultat. Déployer l’API et le frontend ensemble pour cette évolution du protocole.

## Microphone bloqué

L’ancien en-tête Traefik `Permissions-Policy: …,microphone=(),…` interdisait toute capture, même avec une autorisation utilisateur. Le compose Swarm utilise désormais `microphone=(self)`. Déployer le compose corrigé puis recharger la page pour appliquer cet en-tête. Conserver les middlewares de sécurité existants.

La page doit être servie en HTTPS (ou sur localhost). Le client distingue une interdiction par l’en-tête/iframe, un refus utilisateur, un microphone absent et un périphérique indisponible. Une page embarquée doit aussi recevoir la permission `allow="microphone"` du conteneur. Un refus utilisateur doit être levé dans les permissions du navigateur et du système.

## Validation

Les tests couvrent les jetons des deux providers avec API simulées, les erreurs micro, le protocole SDP GA, les trames PCM Gemini, les interruptions, le mute, les résultats d’outils et les connexions tardives après déconnexion. Ils ne remplacent pas une conversation avec microphone réel et une clé autorisée pour chaque provider.

Après déploiement, tester pour chaque provider : connexion, transcription aller/retour, interruption de la parole, mute/haut-parleur, `list_agents`, délégation puis réponse, déconnexion et reconnexion. Gemini signale l’expiration d’une connexion Live ; l’interface demande alors une reconnexion (la reprise transparente de session n’est pas implémentée).

Sources vérifiées le 11 septembre 2026 : [OpenAI Realtime 2](https://developers.openai.com/api/docs/models/gpt-realtime-2), [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [Gemini Flash Live](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview), [jetons Gemini](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), [Permissions-Policy microphone](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/microphone).
