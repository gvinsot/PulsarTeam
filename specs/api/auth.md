# Auth — `/api/auth/*`

Source: `api/src/routes/authLogin.ts`, `api/src/middleware/session.ts`, `api/src/middleware/auth.ts`.

All routes here are public unless explicitly tagged **Session**. A session is an `HttpOnly` cookie (`__Host-pt_session`, `pt_session` in development) holding the signed JWT; `Authorization: Bearer <jwt>` is accepted in its place for non-browser clients. Every POST here that authenticates with the cookie also needs the `X-CSRF-Token` header — see [README.md](README.md#1-authentication-models).

---

## POST `/api/auth/login`
Credential-based login.
- **Auth**: public; rate-limited 5 / 15 min / IP.
- **Body**: `{ username, password }`.
- **Response 200**: sets the session cookie and returns `{ csrfToken, username, role, userId, displayName, termsAcceptedAt, tutorialCompletedAt }`.
- **Errors**: 401 invalid credentials; 403 `{ error, code: 'ACCOUNT_PENDING_APPROVAL' | 'ACCOUNT_REJECTED' }` when the password is right but the account is not approved (see [Account approval](#account-approval)), no cookie set; 429 too many attempts; 503 database unreachable.

## GET `/api/auth/verify`
Validates the current session and returns a fresh user record. Used on app boot: it is the only way to discover whether the `HttpOnly` cookie is still valid, and it re-issues the CSRF token, which the client keeps in memory and loses on reload.
- **Auth**: Session (cookie or Bearer).
- **Response 200**: `{ valid: true, csrfToken, user: { userId, username, role, displayName, termsAcceptedAt, tutorialCompletedAt, impersonatedBy? } }`.
- **Errors**: 401 no / invalid token or unknown user; 403 `{ error, code }` (same codes as `/login`) when the account is not approved — the cookie is cleared.

## POST `/api/auth/logout`
Clears the session cookie. A stateless JWT cannot be revoked server-side, so dropping the cookie the page cannot read *is* the logout.
- **Auth**: public — no session required. A logout carrying a still-valid cookie is CSRF-checked like any other POST; one whose cookie no longer verifies is waved through, so an expired session can always be cleaned up.
- **Response 200**: `{ ok: true }`.

## POST `/api/auth/impersonate/:userId`
Admin impersonates another user. Replaces the caller's session cookie with one minted for the target, carrying `impersonatedBy` (the admin's username) and `impersonatorId` (the admin's id, the way back).
- **Auth**: Session, role `admin`.
- **Response 200**: `{ csrfToken, username, role, userId, displayName, impersonatedBy }`.
- **Errors**: 404 unknown user; 409 the target account is not approved.
- **Side effects**: audit-logged.

## POST `/api/auth/stop-impersonation`
Ends an impersonation and hands the admin their own session back, minted server-side from the `impersonatorId` claim — the frontend cannot stash the original token any more.
- **Auth**: Session (must be an impersonated one).
- **Response 200**: same shape as `/login`, with a fresh session cookie for the admin.
- **Errors**: 400 not impersonating; 403 the original account is no longer an approved admin (the cookie is cleared).

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
Exchanges the OAuth code for a session cookie. Creates the user on first sign-in — awaiting admin approval, see [Account approval](#account-approval).
- **Body**: `{ code, redirect_uri, state }`.
- **Response 200**: same shape as `/login`.
- **Errors**: 403 `{ error, code: 'ACCOUNT_PENDING_APPROVAL' | 'ACCOUNT_REJECTED' }` for an account that is not approved — no cookie, no login body.

## OAuth — Microsoft (`/api/auth/microsoft/{status,url,callback}`)
Same shape as Google. Used by Microsoft Entra IDs (work or personal accounts).

## OAuth — GitHub (`/api/auth/github/{status,url,callback}`)
Same shape as Google. Used as a login provider (separate from the GitHub plugin OAuth).

---

## Account approval

A NEW account created by an OAuth login (Google, Microsoft — Hotmail/Outlook.com accounts sign in there — or GitHub) is stored with `approval_status = 'pending'` and role `advanced`. It gets no session and is not provisioned (no board, no agent) until an admin approves it through [`/api/users/:id/approve`](users.md). An admin who rejects it leaves the row as `'rejected'`, so the same identity keeps being refused (403 `ACCOUNT_REJECTED`) instead of signing up again.

Exceptions, all `'approved'`: every account that existed before the feature (column default), the first user of an empty instance (who also becomes `admin`), the seeded admin, accounts created by an admin, and an existing account a provider is linked to.

Each pending creation emits the socket event `users:pending` `{ count }` to the `role:admin` room only.
