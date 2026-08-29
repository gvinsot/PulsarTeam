# UI Spec — Login & onboarding

Renders: `LoginPage.tsx`, `TermsPage.tsx`, `PrivacyPage.tsx`, `WelcomeTutorialModal.tsx`.

---

## 1. Login page

Public, unauthenticated. Reachable when there is no valid session.

### 1.1 Authentication options
- **Credential login**: username + password fields, submit button. POST `/api/auth/login`. Rate-limited (5 attempts / 15 min per IP).
- **Google OAuth**: button visible only when `GET /api/auth/google/status` returns `configured: true`. Opens a popup to the provider's consent URL (built via `GET /api/auth/google/url`), then completes via `POST /api/auth/google/callback`.
- **Microsoft OAuth**: same pattern, `/api/auth/microsoft/*`.
- **GitHub OAuth**: same pattern, `/api/auth/github/*`.

On success the API sets an `HttpOnly` session cookie and returns `{ csrfToken, username, role, userId, displayName, termsAcceptedAt, tutorialCompletedAt }`. The `csrfToken` is held in memory and a Socket.IO connection is opened (the cookie authenticates the handshake).

### 1.2 Marketing surface
The login page also includes:
- Feature cards explaining the platform's value.
- A rotating screenshot carousel.
- A **Contact form** at the bottom (POST `/api/contact`, rate-limited 5 / hour). Submissions are written as tasks on a configured Support board.

### 1.3 Static legal pages
The header links to `/terms` and `/privacy`, which render `TermsPage` and `PrivacyPage` respectively. These are public and authentic-token-independent.

---

## 2. OAuth callback handling

When a provider redirects back to the SPA at `/auth/{google,microsoft,github}/callback`:

1. App.tsx detects the path and reads the `code` query parameter.
2. It retrieves the `redirect_uri` it stashed in `sessionStorage` (must match the URI the provider was sent to).
3. Calls the appropriate `*Callback` API method to exchange the code for a session.
4. On success: keeps the returned `csrfToken` in memory, fetches the current user, opens the socket, and lands on the Workflows tab.

If the user is new (no row in the users table), the API auto-provisions the workspace before setting the session cookie.

---

## 3. Welcome & Tutorial modal

Shown automatically on the first login of a user, **after** the credential/OAuth handshake completes. It is gated by two fields on the user record:
- `termsAcceptedAt` — null until the user accepts the terms.
- `tutorialCompletedAt` — null until the tutorial is finished.

### 3.1 Step 1 — Terms acceptance
- Renders the full terms (with a link to open `/terms` in a new tab).
- **Accept** button → POST `/api/auth/accept-terms`, sets `termsAcceptedAt`.
- **Decline** button → logs the user out (POST `/api/auth/logout`, return to login).

### 3.2 Step 2-4 — Tutorial
A three-step guided tour:
1. Create your first agent.
2. Set up a workflow.
3. Add tasks to agents.

The user can advance with **Next** / **Previous**, and finalize with **Finish** → POST `/api/auth/complete-tutorial`.

If a user has already accepted terms but not finished the tutorial (or vice-versa), only the missing steps are shown.

Impersonated sessions do **not** show this modal — the impersonator's onboarding state is not overwritten.

---

## 4. Session management

- The session JWT lives in an `HttpOnly` cookie set by the API (`__Host-pt_session` in production, `pt_session` in development, 24 h). No page script can read it and nothing about the session is kept in `localStorage`.
- Login, the OAuth callbacks and `/api/auth/verify` return a `csrfToken`. The SPA holds it in a module-level variable and sends it as an `X-CSRF-Token` header on every state-changing request; without it the API answers 403.
- Ending an impersonation is server-side: POST `/api/auth/stop-impersonation` re-mints the impersonator's own session cookie from the `impersonatorId` claim, behind the "Stop Impersonation" button.
- **Logout**: POST `/api/auth/logout` clears the cookie.
- On every app boot, `GET /api/auth/verify` is called. It is the only way to learn whether the cookie is still valid, and it re-hands the `csrfToken` that the reload discarded. If it fails (expired / revoked), the user is sent back to the login page.

---

## 5. Toasts and errors

Authentication errors are surfaced as toasts in the top-right corner (managed in `App.tsx`):
- Login failures show the message returned by the API.
- OAuth failures show a generic "Login failed" toast.
- Stream errors from a chat session show sticky toasts (duration 0) when they involve model/context issues.
