# Users — `/api/users/*`

Source: `api/src/routes/users.ts`. All routes require JWT + `admin`.

## GET `/api/users`
List every user with online status (computed from active socket sessions).
- **Response 200**: `[{ id, username, displayName, role, lastLoginAt, online, termsAcceptedAt, tutorialCompletedAt, createdAt }]`.

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
