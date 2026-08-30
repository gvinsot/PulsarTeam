// ── User, session, authentication, API keys ─────────────────────────────────
//
// The single most important distinction in this file: the ADMIN user row uses
// `id` + snake_case columns, while every SESSION payload uses `userId` +
// camelCase. There is no `id` on a session object, and no `userId` on a user row.
// Two components already read the wrong one (BroadcastPanel.tsx:97 and
// agentDetail/SettingsTab.tsx:538) and get a permanently-undefined branch.
//
// The JWT itself never reaches the browser: it lives in an HttpOnly cookie, and
// only the CSRF token travels in these bodies. The JWT claim shape is therefore
// deliberately NOT typed here — it is a server-side shape.

/**
 * RULE 1 (see index.ts), and worth spelling out because the column itself is
 * permissive: free TEXT NOT NULL DEFAULT 'advanced' with NO CHECK constraint
 * (api/src/services/database/baseSchema.ts:17). What matters for the wire type is
 * that EVERY write path the API exposes validates the value — the zod enums on
 * POST/PUT /users, and hardcoded literals during OAuth provisioning. Rule 1 is
 * about server validation, not about the DDL, so this stays a closed union.
 *
 * (UsersTab's `ROLE_CONFIG[user.role] || basic` fallback covers a row written
 * by hand or by a future migration; it is defence in depth, not evidence of a
 * reachable off-union value.)
 */
export type UserRole = 'admin' | 'advanced' | 'basic';

/**
 * The users row without `password`, served to any authenticated user by
 * GET /boards/users (the share autocomplete) and by GET /users/:id.
 * Produced by api/src/services/database/users.ts:12.
 *
 * `password` is absent from the SELECT column list, deliberately: it is not
 * declared here so nothing can even try to read it.
 */
export interface UserDirectoryEntry {
  id: string;
  /** TEXT UNIQUE NOT NULL. For OAuth accounts this is the email, or
   *  <login>@users.noreply.github.com. */
  username: string;
  role: UserRole;
  /** TEXT with no NOT NULL. createUser defaults it to the username, but
   *  PUT /users/:id writes whatever is sent, including ''. */
  display_name: string | null;
  google_id: string | null;
  microsoft_id: string | null;
  github_id: string | null;
  /** May be an https URL (Google/GitHub) or a data: URI (Microsoft photo). */
  avatar_url: string | null;
  /** ISO-8601 on the wire; null until updateLastSeen runs. */
  last_seen: string | null;
  /** ISO-8601; null until POST /auth/accept-terms. */
  terms_accepted_at: string | null;
  /** ISO-8601; null until POST /auth/complete-tutorial. */
  tutorial_completed_at: string | null;
  /** DEFAULT NOW() without NOT NULL, but no insert path passes an explicit NULL. */
  created_at: string;
  updated_at: string;
}

/**
 * Admin-facing user row from GET /users — the directory entry plus a live
 * is_online flag. Produced by api/src/routes/users.ts:26.
 *
 * getAllUsers swallows DB errors and returns [], so an empty User[] is
 * indistinguishable from a database outage.
 */
export interface User extends UserDirectoryEntry {
  /** Not a column — computed from the live socket registry. Present ONLY on
   *  GET /users; absent from GET /boards/users and GET /users/:id. */
  is_online: boolean;
}

/**
 * The much thinner user object returned by POST /users (201) and PUT /users/:id —
 * only the six columns in the SQL RETURNING clause.
 * Produced by api/src/services/database/users.ts:52.
 *
 * Deliberately NOT a User: is_online, last_seen, the three OAuth ids, avatar_url
 * and the two timestamps are all absent. UsersTab does not read the body (it
 * refetches), so nothing breaks today.
 *
 * THE ABSENCE OF `password` IS GUARANTEED BY THE ROUTE, NOT BY THE RETURNING
 * CLAUSE ALONE. `updateUser` short-circuits to `getUserById(id)` — a `SELECT *`,
 * hash included — when the patch has zero SET clauses, and every key of
 * updateUserSchema is optional so an empty `{}` body validates
 * (api/src/services/database/users.ts:74). PUT /users/:id therefore destructures
 * the hash away itself, exactly as GET /users/:id does:
 * `const { password, ...safe } = user; res.json(safe)`
 * (api/src/routes/users.ts:86-87, mirroring :37-38). Verified in place. If that
 * strip is ever removed, this type becomes a lie again — do not widen the type,
 * restore the strip.
 *
 * One knock-on of that same short-circuit: on the empty-body path the body is a
 * full users row, so it carries MORE keys than declared here. Extra keys are
 * harmless structurally, and the six below are present on both paths.
 */
export interface UserMutationResult {
  id: string;
  username: string;
  role: UserRole;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The flat login response body, minted by sendLoginResponse — POST /auth/login,
 * the three OAuth callbacks and POST /auth/stop-impersonation.
 * Produced by api/src/routes/authLogin.ts:132.
 *
 * `impersonatedBy` is NEVER on this shape, including on /stop-impersonation —
 * that absence is exactly what clears the impersonation banner.
 */
export interface SessionPayload {
  /** 32 random bytes base64url, minted with the JWT. Held in memory only and
   *  echoed in the X-CSRF-Token header. */
  csrfToken: string;
  username: string;
  role: UserRole;
  /** users.id under a different key. There is no `id` key on this payload. */
  userId: string;
  /** `user.display_name` passed raw — no `|| null` — so a NULL column arrives as
   *  null. */
  displayName: string | null;
  /** BOTH optional and nullable, the textbook case: /login and
   *  /stop-impersonation pass no `extra` so the key is DROPPED, while the OAuth
   *  callbacks pass `user.avatar_url || profile.avatarUrl`, which can be null. */
  avatarUrl?: string | null;
  /** `|| null` normalises both a NULL column and an absent column into null. */
  termsAcceptedAt: string | null;
  tutorialCompletedAt: string | null;
}

/**
 * The nested `user` object inside GET /auth/verify — the same identity fields as
 * SessionPayload but without csrfToken and WITHOUT avatarUrl, plus the optional
 * impersonation marker. Produced by api/src/routes/authLogin.ts:321.
 *
 * The producer builds it as `const responseUser: any`, so the one payload the
 * whole SPA boots from is unchecked server-side.
 */
export interface SessionUser {
  userId: string;
  username: string;
  /** Re-read from the DB on every verify precisely to catch role changes — not
   *  taken from the JWT claim. */
  role: UserRole;
  displayName: string | null;
  termsAcceptedAt: string | null;
  tutorialCompletedAt: string | null;
  /** Optional, never null: the key is only assigned when the JWT carries the
   *  claim. The value is the admin's USERNAME, not their id. */
  impersonatedBy?: string;
}

/**
 * Body of GET /auth/verify — the SPA's boot handshake, and the only way to learn
 * the HttpOnly cookie is still valid. Produced by api/src/routes/authLogin.ts:335.
 */
export interface VerifyResponse {
  /** Hard-coded literal; the failure paths return 401 `{ error }` instead, never
   *  `valid: false`. */
  valid: true;
  user: SessionUser;
  /** `decoded.csrf` from the verified JWT. */
  csrfToken: string;
}

/**
 * Body of POST /auth/impersonate/:userId (admin only) — a login-shaped payload
 * for the impersonated identity.
 * Produced by api/src/routes/authLogin.ts:380.
 *
 * It carries NEITHER termsAcceptedAt NOR tutorialCompletedAt, unlike every other
 * session payload — yet App.tsx's toUser reads both off this exact body.
 */
export interface ImpersonateResponse {
  csrfToken: string;
  /** The TARGET user's username. */
  username: string;
  role: UserRole;
  userId: string;
  displayName: string | null;
  /** Always present here (the admin's username) — this is what drives the
   *  impersonation banner. */
  impersonatedBy: string;
}

/**
 * The normalised `user` object App.tsx keeps in state and hands to Dashboard —
 * the common denominator of SessionPayload, SessionUser and ImpersonateResponse.
 * Produced by frontend/src/App.tsx:17 (toUser).
 *
 * This is a CLIENT shape, not a wire shape. Two things it does on purpose:
 * absent timestamps normalise to null (so the keys always exist), and
 * `avatarUrl` is DROPPED — no file under frontend/src reads it.
 */
export interface AppUser {
  username: string;
  role: UserRole;
  /** There is no `id` key here. */
  userId: string;
  /** Copied raw, so the API's null survives; every render site guards with
   *  `|| user.username`. */
  displayName: string | null;
  termsAcceptedAt: string | null;
  tutorialCompletedAt: string | null;
  /** Spread conditionally — the key is genuinely absent (not null) outside
   *  impersonation. */
  impersonatedBy?: string;
}

/**
 * Metadata about the single active MCP API key — prefix only, never the key.
 * Produced by api/src/services/apiKeyManager.ts:90.
 * key_hash and hash_version are absent from the SELECT and are not declared.
 */
export interface ApiKeyInfo {
  id: string;
  /** `key.slice(0,12) + '...' + key.slice(-4)`, e.g. 'swarm_sk_abc...7f2e'. */
  prefix: string;
  created_at: string;
}

/**
 * Body of GET /api/settings/api-key. Produced by api/src/routes/apiKeys.ts:14.
 */
export interface ApiKeyInfoResponse {
  /** null when the table is empty OR when there is no DB pool. */
  apiKey: ApiKeyInfo | null;
}

/**
 * Body of POST /api/settings/api-key — the ONLY response that ever contains the
 * clear-text key. Produced by api/src/services/apiKeyManager.ts:144.
 *
 * Deliberately NOT an ApiKeyInfo: there is no created_at here. ApiKeyModal
 * fabricates one client-side when it folds this into the GET state slot, which is
 * why the date it then displays is client clock time.
 */
export interface ApiKeyCreated {
  id: string;
  /** CLEAR TEXT, shown once: 'swarm_sk_<64 hex chars>'. Only the HMAC is stored. */
  key: string;
  prefix: string;
}

/**
 * Body of POST /auth/accept-terms. Produced by api/src/routes/authLogin.ts:830.
 * Never null on a 200 (the 404 branch returns `{ error }`), but the consumer
 * ignores the body and App.tsx stamps its own timestamp instead.
 */
export interface TermsAcceptedResponse {
  termsAcceptedAt: string;
}

/**
 * Body of POST /auth/complete-tutorial. Produced by api/src/routes/authLogin.ts:847.
 * Also ignored by its consumer.
 */
export interface TutorialCompletedResponse {
  tutorialCompletedAt: string;
}

/**
 * Body of GET /auth/{google,microsoft,github}/status.
 * Produced by api/src/routes/authLogin.ts:741.
 */
export interface OAuthProviderStatus {
  /** `!!spec.getConfig()`. For GitHub it is also false whenever
   *  GITHUB_LOGIN_ENABLED !== 'true'. */
  enabled: boolean;
  /** Every statusClientId() ends in `|| null`. GitHub deliberately reports a
   *  non-null clientId even while login is disabled. */
  clientId: string | null;
}

/**
 * Body of GET /auth/{provider}/url — the consent URL plus the canonical
 * redirect_uri the SPA must stash and replay on the callback.
 * Produced by api/src/routes/authLogin.ts:760.
 */
export interface OAuthAuthUrlResponse {
  url: string;
  /** snake_case, unlike everything else in this file. Always a non-empty string
   *  on a 200 — the empty case returns 400 first. */
  redirect_uri: string;
}
