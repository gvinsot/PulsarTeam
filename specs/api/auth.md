# Auth — `/api/auth/*`

Source: `api/src/middleware/auth.ts`.

All routes here are public unless explicitly tagged JWT.

---

## POST `/api/auth/login`
Credential-based login.
- **Auth**: public; rate-limited 5 / 15 min / IP.
- **Body**: `{ username, password }`.
- **Response 200**: `{ token, username, role, userId, displayName, termsAcceptedAt, tutorialCompletedAt }`.
- **Errors**: 401 invalid credentials; 429 too many attempts.

## GET `/api/auth/verify`
Validates the current JWT and returns a fresh user record. Used on app boot to catch role changes or revoked accounts.
- **Auth**: JWT Bearer.
- **Response 200**: `{ user: { userId, username, role, displayName, termsAcceptedAt, tutorialCompletedAt, impersonatedBy? } }`.

## POST `/api/auth/impersonate/:userId`
Admin impersonates another user. Returns a JWT for the target.
- **Auth**: JWT, role `admin`.
- **Response 200**: `{ token, username, role, userId, displayName, impersonatedBy }`.
- **Side effects**: audit-logged.

## POST `/api/auth/accept-terms`
Marks the current user as having accepted the terms.
- **Auth**: JWT.
- **Response 200**: `{ termsAcceptedAt }`.

## POST `/api/auth/complete-tutorial`
Marks the tutorial as completed.
- **Auth**: JWT.
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
Exchanges the OAuth code for a JWT. Creates the user on first sign-in (auto-provisioning).
- **Body**: `{ code, redirect_uri }`.
- **Response 200**: same shape as `/login`.

## OAuth — Microsoft (`/api/auth/microsoft/{status,url,callback}`)
Same shape as Google. Used by Microsoft Entra IDs (work or personal accounts).

## OAuth — GitHub (`/api/auth/github/{status,url,callback}`)
Same shape as Google. Used as a login provider (separate from the GitHub plugin OAuth).
