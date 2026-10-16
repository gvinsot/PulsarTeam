# UI Spec — Header bar and shared surfaces

Renders: `frontend/src/components/Dashboard.tsx` (header area) plus a few app-wide widgets.

---

## 1. Header bar

The header is sticky and visible on every authenticated page. From left to right:

| Element | Behavior |
|---|---|
| Burger icon | On mobile, toggles a dropdown listing the same tabs as the desktop tab bar. |
| Logo + product name | Tooltip shows the running version (`VITE_APP_VERSION`). |
| Tab buttons (desktop) | Agents / Workflows / Projects / Budget. Click sets `activeView` and updates the URL hash. |
| Project filter dropdown | Visible when ≥ 1 project exists. Filters every tab to a single project. Persisted to `localStorage`. |
| Global broadcast button (globe) | Opens `BroadcastPanel`. |
| Theme toggle | Light / dark mode, persisted via `ThemeContext`. |
| API-key button (key) | Opens `ApiKeyModal`. |
| User menu (avatar + name) | Dropdown with **Admin Settings** (admin only) and **Logout**. |

When an `impersonatedBy` field is present on the user, an amber banner is rendered above the header with a "Stop Impersonation" button.

---

## 2. API-key modal

Renders: `frontend/src/components/ApiKeyModal.tsx`.

Lets the current user manage **their personal scoped API keys** (see `specs/api/mcp-surfaces.md`), and browse the generated API documentation.

- **Task insertion**: any number of `insert` keys, each bound to one board the user can edit (optionally narrowed to some columns).
- **MCP keys**: one `management` and one `admin` key per user. **Create** / **Rotate** mints a key, returned **once** by the API and shown here with a **Copy** button; the previous key for that scope stops working immediately.
- Each existing key shows its prefix and last use, with a **Revoke** button.
- There is no instance-wide key any more: the ownerless legacy key has been removed.

---

## 3. Swarm overview / stats bar

Renders: `frontend/src/components/SwarmOverview.tsx`.

A horizontal stats strip just under the header, visible on every tab **except** Workflows. It is computed locally from the agents list and the thinking map:

- `total` — agents in the current project scope
- `busy` — agents currently `busy` or thinking
- `idle` — agents currently `idle` without an active thinking buffer
- `errors` — agents currently in `error`
- `totalTokensIn` / `totalTokensOut` — sums across the scope

Tokens are formatted in `k` / `M` units. There is no persisted query — the stats follow socket-driven agent updates.

---

## 4. Voice indicator

Renders: `frontend/src/components/ActiveVoiceIndicator.tsx`.

A floating bubble that appears when **any** agent has an active voice session. Provided by `VoiceSessionContext`. Clicking it navigates to the corresponding agent's Chat tab.

If the user is already on the right agent's chat tab, the bubble auto-hides.

---

## 5. Toasts

A toast stack at the bottom-right of every page. Three styles: error, success, info. Toasts can be sticky (duration 0) for unrecoverable errors. Dedup logic in `App.tsx` prevents identical toasts from stacking.

---

## 6. DB-unavailable banner

If `GET /api/health` reports `database: 'unavailable'`, the dashboard renders a top banner with a dismiss button. Inside this state, settings and agents will not be persisted, but the swarm can keep operating from in-memory state.

---

## 7. Responsive design

- ≤ 640 px: burger menu replaces the tab bar; agent detail panel hides the list (full-screen).
- 640–1024 px: tab bar visible; agent list and detail stack vertically when detail is open.
- > 1024 px: full split layout with list on the left, detail on the right.
