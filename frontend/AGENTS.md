# frontend/ — agent notes

React 18 + Vite 6 SPA, TypeScript strict, Tailwind. Start with the root
[`AGENTS.md`](../AGENTS.md).

## Commands (run from `frontend/`)

```bash
npm run typecheck   # the only type gate
npm run lint        # --max-warnings ceiling = no-explicit-any count
npm test            # node:test on src/**/__tests__/*.test.ts (pure logic, no DOM)
npm run build       # also packages the browser-session extension
npm run dev         # :5173, proxies /api, /socket.io, /ws to localhost:3001
```

## Where things live

| Need to change…              | Look in                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| REST calls                   | `src/api.ts` (one function per endpoint, ~1500 lines, so grep it)                                |
| Payload types                | `src/types/*.ts` (keep in sync with `api/src/schemas/`)                                          |
| WebSocket event names        | `src/socketEvents.ts` (mirror of `api/src/ws/events.ts`)                                         |
| Socket state / subscriptions | `src/contexts/WebSocketContext.tsx`, `src/hooks/useAgentsSocket.ts`                              |
| UI strings (en + fr)         | `src/i18n/translations.ts`, used through `useLanguage()` from `src/contexts/LanguageContext.tsx` |
| Top-level screens            | `src/App.tsx`, `src/components/*.tsx`                                                            |
| Task board / task modal      | `src/components/tasks/`, `TasksBoard.tsx`                                                        |
| Agent detail tabs            | `src/components/agentDetail/`                                                                    |
| Integrations connect cards   | `src/components/connect/`, `*Connect.tsx`                                                        |

## Tests

- Only `src/**/__tests__/*.test.ts` runs (`.ts`, **not** `.tsx`). There is no DOM
  environment, so put logic you want to test in a plain `.ts` module (examples:
  `components/agentSearch.ts`, `components/budgetScope.ts`) and test that module.
- Import the module under test with its `.ts` extension, as the existing tests do.

## Conventions

- Add new user-visible strings to `translations.ts` in **both** `en` and `fr`.
- Render untrusted SVG/HTML only through `src/lib/sanitizeSvg.ts` / react-markdown.
  Never use `dangerouslySetInnerHTML` with raw input.
- For new code, use `src/lib/safeStorage.ts` instead of calling `localStorage` directly.
- The UI must work on mobile. Recent work made the modals responsive, so keep them that way.
