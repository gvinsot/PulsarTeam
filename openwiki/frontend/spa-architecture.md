---
type: architecture
title: Frontend SPA
description: How the React single-page app is organized, how it handles sessions without holding a credential, calls the REST API, keeps agent and stream state live over Socket.IO after reconnects, supports two languages, sanitizes untrusted markup, and what its tests can cover.
tags: [frontend, react, vite, websocket, session, i18n]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T10:37:51.796Z
sources:
  - id: openwiki-source-6b72ccb83227836142347d82
    resource: repo://frontend/nginx.conf
  - id: openwiki-source-1047363cf615000e4c9bb694
    resource: repo://frontend/package.json
  - id: openwiki-source-8d0c2988b5838a5fe14cf2c8
    resource: repo://frontend/src/api.ts
  - id: openwiki-source-454c9bcdde0b77b35e0fc994
    resource: repo://frontend/src/App.tsx
  - id: openwiki-source-4051b36fb6011f947fe370a3
    resource: repo://frontend/src/components/CallGraphTab.tsx
  - id: openwiki-source-42e0e61ee53ce6e1f83ff29d
    resource: repo://frontend/src/hooks/useAgentsSocket.ts
  - id: openwiki-source-01b4637f9331d4e2c7f77f71
    resource: repo://frontend/src/lib/sanitizeSvg.ts
  - id: openwiki-source-469c29876183039c4fd8716f
    resource: repo://frontend/src/socket.ts
  - id: openwiki-source-378e3cf05ab0d05d335c68d5
    resource: repo://frontend/vite.config.ts
generated: { by: "claude-code", at: "2026-11-06T10:37:51.796Z" }
---

# Frontend SPA

`frontend/` is a React 18 and Vite single-page app with TypeScript and Tailwind. It communicates with the API only over HTTP and WebSocket, and imports nothing from `api/`. In production, nginx serves it on port **8080**, not 80. If you change that port, update `frontend/nginx.conf`, the Compose mapping and the Traefik label together.

During development, `npm run dev` runs on port 5173 and proxies `/api`, `/socket.io` and `/ws` to `localhost:3001`.

## Layout

| Need | Look in |
|---|---|
| Top-level state and session | `src/App.tsx` |
| Main screen | `src/components/Dashboard.tsx` |
| REST calls | `src/api.ts`, one function per endpoint, about 1500 lines, so grep it |
| Payload types | `src/types/*.ts`, kept in sync with `api/src/schemas/` by hand |
| Event names | `src/socketEvents.ts`, mirror of `api/src/ws/events.ts` |
| Agent and stream state | `src/hooks/useAgentsSocket.ts`, `src/hooks/chatStreamLifecycle.ts` |
| Socket connection | `src/socket.ts`, `src/contexts/WebSocketContext.tsx` |
| Strings | `src/i18n/translations.ts` |
| Task board and modal | `src/components/TasksBoard.tsx`, `src/components/tasks/` |
| Agent tabs | `src/components/agentDetail/` |
| Integration cards | `src/components/*Connect.tsx`, `src/components/connect/` |

Login, terms and privacy pages and the tutorial are loaded lazily. Specs for each screen are in `specs/ui/`.

## Session model

**The page holds no credential.** The session is an `HttpOnly` cookie it cannot read, so an injected script can't steal it. The cost is CSRF exposure, handled as follows:

1. On load, `App` calls `GET /api/auth/verify`.
2. The response includes the user and the CSRF token, which `setCsrfToken` keeps **in memory only**, never in `localStorage`. A reload drops it and `verify` returns it again.
3. `api.ts` sends it as `X-CSRF-Token` and uses `credentials: 'include'`.

A boot-time failure sets `dbUnavailable` when the database is down, so the UI can say so rather than show a login screen. Calls use a default timeout through `AbortSignal.timeout`, since browsers have none and a stuck backend would hang forever.

See [Authentication and authorization](../security/authentication-and-authorization.md).

## Realtime state

`socket.ts` opens one shared Socket.IO connection, with no token: the cookie goes along with the same-origin handshake. After a re-login, the caller recycles the socket explicitly.

`useAgentsSocket` holds live agent state. **The important design is recovery from missed events:**

- On connect and reconnect, the client sends `REQ_STREAM_STATE`.
- The server replies with `STREAM_RESUME`, the **full** list of active streams and their buffers.
- The client seeds buffers for active streams and evicts any local buffer not in the list. This handles a server crash before `STREAM_END`.
- If a stream ended that way, it requests a status refresh, without assuming the agent is idle, as it may already be doing something else.

A watchdog also covers missed events. `chatStreamLifecycle.ts` keeps this logic testable outside React.

When adding an event, change `api/src/ws/events.ts`, `src/socketEvents.ts` and `specs/websocket-events.md`, and remember that server-side routing decides who gets it. See [API control plane](../architecture/api-control-plane.md#realtime).

### Terminal

CLI agents get an interactive terminal through xterm.js on `/ws/agents/:id/terminal`. It authenticates with the session cookie, so it must come from the same origin as the SPA, which is why Vite also proxies `/ws`.

## Language

The UI supports English and French. Add every user-visible string to **both** in `translations.ts`, and read them through `useLanguage()`.

## Rendering untrusted content

There is exactly one raw HTML sink in the app: the call graph diagram at `components/CallGraphTab.tsx`. Its Mermaid source is built from repository contents and may be rewritten by an LLM, so neither is trusted. It has two layers:

1. Mermaid runs with `securityLevel: 'strict'`.
2. `lib/sanitizeSvg.ts` applies an element and attribute allowlist that fails closed: anything that doesn't parse produces an empty string.

Everything else goes through `react-markdown`. **Do not add `dangerouslySetInnerHTML` with raw input.** A script running in the page can't steal the session, but it could still act as the user, as `SECURITY.md` acknowledges.

## Conventions

- Use `lib/safeStorage.ts` in new code, as `localStorage` can throw in private modes and sandboxed webviews.
- The UI must work on mobile, including modals.
- `npm run build` and `npm run dev` also package the browser session extension, through `scripts/package-browser-extension.mjs`.

## Testing

Tests use `node:test` and run only on `src/**/__tests__/*.test.ts`. **`.tsx` files are not run, and there is no DOM environment.** So put logic worth testing in a plain `.ts` module, as `components/agentSearch.ts` and `components/budgetScope.ts` do. React components themselves have no automated tests. See [Gates and testing](../development/gates-and-testing.md).
