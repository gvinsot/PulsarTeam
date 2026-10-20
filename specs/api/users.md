# Users — `/api/users/*`

Source: `api/src/routes/users.ts`. All routes require JWT + `admin`.

## GET `/api/users`
List every user with online status (computed from active socket sessions).
- **Response 200**: `[{ id, username, display_name, role, google_id, microsoft_id, github_id, avatar_url, last_seen, terms_accepted_at, tutorial_completed_at, approval_status, created_at, updated_at, is_online }]` — `approval_status` is `'approved' | 'pending' | 'rejected'`.

## GET `/api/users/pending`
Accounts created by an OAuth login that wait for an admin (see [auth.md](auth.md#account-approval)), oldest first.
- **Response 200**: `{ users: [{ id, username, displayName, avatarUrl, provider: 'google' | 'microsoft' | 'github' | null, createdAt }] }`.

## GET `/api/users/pending/count`
- **Response 200**: `{ count }` — the admin menu badge at load; kept current afterwards by the socket event `users:pending` `{ count }`, emitted to admin sockets only on every pending creation, approval, rejection and user deletion.

## POST `/api/users/:id/approve`
Lets a pending account in and provisions it (default board + agent), which its OAuth sign-up deliberately skipped.
- **Body**: `{ role?: 'admin' | 'advanced' | 'basic' }` — default `advanced`.
- **Response 200**: `{ user }` (`id, username, role, display_name, avatar_url, approval_status, created_at, updated_at`).
- **Errors**: 400 invalid body; 404 unknown user; 409 the user is not pending.

## POST `/api/users/:id/reject`
Declines a pending account. The row is kept as `rejected` so the same identity cannot sign up again; `DELETE /api/users/:id` still removes it.
- **Response 200**: `{ success: true }`.
- **Errors**: 404 unknown user; 409 the user is not pending.

## GET `/api/users/:id`
- **Response 200**: same shape minus password fields.

## POST `/api/users`
Create a user. Triggers workspace provisioning (Linux UID allocation, default board, default agent).
- **Body**: `{ username, password, role, displayName? }`.
- **Response 201**: the created user.
- **Errors**: 409 username taken.

## PUT `/api/users/:id`
Update a user. Any subset of fields may be provided.
- **Body**: `{ username?, role?, displayName?, password? }`.
- **Response 200**: updated user.

## DELETE `/api/users/:id`
Delete a user.
- **Errors**: 400 if `id` equals the caller (no self-deletion).
- **Side effects**: cascades to the user's agents and their sandboxes.
