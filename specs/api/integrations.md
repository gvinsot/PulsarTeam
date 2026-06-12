# Third-party integrations

This file documents every OAuth or credential-based integration the platform exposes. They all follow the same shape:

- A `GET /status` endpoint to inspect whether the integration is configured and connected.
- A `GET /auth-url` (OAuth integrations only) that returns the consent URL plus a `state` we round-trip.
- A `GET /oauth-redirect` (public) that the provider redirects to.
- A `POST /connect` (credential integrations) that validates the credentials by performing a test call.
- A `POST /disconnect` to revoke the stored token / credentials.
- An `ALL /mcp` JSON-RPC endpoint that backs the corresponding MCP server.

All `/status`, `/auth-url`, `/connect`, `/disconnect`, `/mcp` routes require JWT. OAuth `/oauth-redirect` is public — it exchanges the code server-side and renders a result page that notifies the SPA popup opener via `postMessage`.

Each integration is **scoped**: an `agentId` query (or `boardId`) selects which agent/board the connection belongs to. With no scope, the token is stored at the user level. The MCP layer reads the most-specific token (agent → board → user).

---

## GitHub — `/api/github/*`
- Connection: `{ login, agentId?, boardId? }`.
- Primary scopes: `repo`, `read:user`, optionally `admin:org` for org repos.
- MCP tools: get_authenticated_user, list_repos, get_repo, list/get/create/update_issue, list/get/create_pull_request, list_branches, get_file_content, search_code, list_commits, list_workflows, list_workflow_runs.

## Gmail — `/api/gmail/*`
- Provider: Google OAuth (shared client with Drive).
- MCP tools: list/get/send/reply/forward email, manage labels, search.

## Google Drive — `/api/gdrive/*`
- Provider: Google OAuth (shared client with Gmail).
- MCP tools: list/get/upload/download/move/share files, search.

## OneDrive — `/api/onedrive/*`
- Provider: Microsoft Graph (shared client with Outlook).
- MCP tools: list/get/upload/download/move files, share, search.

## Outlook — `/api/outlook/*`
- Provider: Microsoft Graph (shared client with OneDrive).
- MCP tools: mail list/get/send/reply, calendar events, search.

## Slack — `/api/slack/*`
- Provider: Slack OAuth.
- MCP tools: list/post messages, list channels, search, file upload.

## Jira — `/api/jira/*`
- **Credential-based** (domain + email + API token), no OAuth.
- `POST /connect` validates by calling Jira's user endpoint; stores credentials encrypted.
- MCP tools: list/get/create/update issue, transitions, JQL search, comment.

## WordPress — `/api/wordpress/*`
- **Credential-based** (site URL + username + application password).
- MCP tools: list/get/create/update/delete posts/pages, media upload, comments.

## S3 — `/api/s3/*`
- **Credential-based** (access key + secret + region + optional endpoint).
- `POST /connect` validates by calling `ListBuckets`.
- MCP tools: list_buckets, list_objects, get_object, put_object, delete_object, generate_presigned_url.

---

## OAuth redirect dispatchers

Some redirect handlers are shared across multiple integrations because the OAuth client is shared:

| Path | Used by |
|---|---|
| `GET /api/google/oauth-redirect` | Gmail + Drive (dispatched via `state.service`) |
| `GET /api/microsoft/oauth-redirect` | OneDrive + Outlook (dispatched via `state.service`) |
| `GET /api/github/oauth-redirect` | GitHub plugin |
| `GET /api/slack/oauth-redirect` | Slack |
