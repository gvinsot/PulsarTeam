# Files

- [Agent isolation and secrets](agent-isolation.md) - What actually contains an agent running model-driven commands, including per-agent UIDs, container capabilities, secret file permissions and a sanitized environment, why the command blocklist is not a boundary, how terminal output is scrubbed, and how externally written tasks are handled.
- [Authentication and authorization](authentication-and-authorization.md) - The credentials the API accepts, including session cookies with CSRF claims, scoped API keys, internal service keys and tokens, plus the board-based access rules for multi-tenant data, the checks that are easy to omit, and SSRF protection.
