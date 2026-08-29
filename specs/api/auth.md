# Auth — `/api/auth/*`

Source: `api/src/routes/authLogin.ts`, `api/src/middleware/session.ts`, `api/src/middleware/auth.ts`.

All routes here are public unless explicitly tagged **Session**. A session is an `HttpOnly` cookie (`__Host-pt_session`, `pt_session` in development) holding the signed JWT; `Authorization: Bearer <jwt>` is accepted in its place for non-browser clients. Every POST here that authenticates with the cookie also needs the `X-CSRF-Token` header — see [README.md](README.md#1-authentication-models).

---

## POST `/api/auth/login`
Credential-based login.
- **Auth**: public; rate-limited 5 / 15 min / IP.
- **Body**: `{ username, password }`.
- **Response 200**: sets the session cookie and returns `{ csrfToken, username, role, userId, displayName, termsAcceptedAt, tutorialCompletedAt }`.
- **Errors**: 401 invalid credentials; 429 too many attempts; 503 database unreachable.

## GET `/api/auth/verify`
Validates the current session and returns a fresh user record. Used on app boot: it is the only way to discover whether the `HttpOnly` cookie is still valid, and it re-issues the CSRF token, which the client keeps in memory and loses on reload.
- **Auth**: Session (cookie or Bearer).
- **Response 200**: `{ valid: true, csrfToken, user: { userId, username, role, displayName, termsAcceptedAt, tutorialCompletedAt, impersonatedBy? } }`.

## POST `/api/auth/logout`
Clears the session cookie. A stateless JWT cannot be revoked server-side, so dropping the cookie the page cannot read *is* the logout.
- **Auth**: public — no session required. A logout carrying a still-valid cookie is CSRF-checked like any other POST; one whose cookie no longer verifies is waved through, so an expired session can always be cleaned up.
- **Response 200**: `{ ok: true }`.

## POST `/api/auth/impersonate/:userId`
Admin impersonates another user. Replaces the caller's session cookie with one minted for the target, carrying `impersonatedBy` (the admin's username) and `impersonatorId` (the admin's id, the way back).
- **Auth**: Session, role `admin`.
- **Response 200**: `{ csrfToken, username, role, userId, displayName, impersonatedBy }`.
- **Side effects**: audit-logged.

## POST `/api/auth/stop-impersonation`
Ends an impersonation and hands the admin their own session back, minted server-side from the `impersonatorId` claim — the frontend cannot stash the original token any more.
- **Auth**: Session (must be an impersonated one).
- **Response 200**: same shape as `/login`, with a fresh session cookie for the admin.
- **Errors**: 400 not impersonating; 403 the original account is no longer an admin (the cookie is cleared).

## POST `/api/auth/accept-terms`
Marks the current user as having accepted the terms.
- **Auth**: Session.
- **Response 200**: `{ termsAcceptedAt }`.

## POST `/api/auth/complete-tutorial`
Marks the tutorial as completed.
- **Auth**: Session.
- **Response 200**: `{ tutorialCompletedAt }`.

---

## OAuth — Google

### GET `/api/auth/google/status`
- **Response 200**: `{ configured: boolean, clientId?: string }`.

### GET `/api/auth/google/url`
Builds the Google consent URL. The frontend stashes the `redirect_uri` it received here in `sessionStorage` and passes it back on callback so the request signature matches.
- **Query**: `redirect_uri?`.
- **Response 200**: `{ url, redirect_uri }`.

### POST `/api/auth/google/callback`
Exchanges the OAuth code for a session cookie. Creates the user on first sign-in (auto-provisioning).
- **Body**: `{ code, redirect_uri }`.
- **Response 200**: same shape as `/login`.

## OAuth — Microsoft (`/api/auth/microsoft/{status,url,callback}`)
Same shape as Google. Used by Microsoft Entra IDs (work or personal accounts).

## OAuth — GitHub (`/api/auth/github/{status,url,callback}`)
Same shape as Google. Used as a login provider (separate from the GitHub plugin OAuth).
