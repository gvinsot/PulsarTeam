# Budget & LLM configs

Sources: `api/src/routes/budget.ts`, `llmConfigs.ts`. All routes require JWT.

---

## 1. Budget — `/api/budget/*`

### GET `/api/budget/summary`
Total token spend over the window plus the active budget config.
- **Query**: `days?` (default 30).
- **Response 200**: `{ totalCost, totalTokensIn, totalTokensOut, budgetConfig: { dailyBudget, alertThreshold, currency } }`.
- **Scope**: non-admins are filtered to their own agents.

### GET `/api/budget/by-agent`
Per-agent token usage, enriched with display info (icon, color).
- **Query**: `days?` (default 30).

### GET `/api/budget/timeline`
Token usage time series.
- **Query**: `days?`, `groupBy?: 'day'|'week'|'month'`.

### GET `/api/budget/daily`
Daily cost time series.
- **Query**: `days?` (default 30).

### GET `/api/budget/config`
Current budget configuration (open to all JWTs).

### PUT `/api/budget/config`
Update budget config.
- **Auth**: `admin`.
- **Body**: `{ dailyBudget?, alertThreshold?, currency? }`.

### GET `/api/budget/alerts`
Returns any active alerts (warning / critical) for the day, with `todayCost` and a per-agent breakdown.

---

## 2. LLM configs — `/api/llm-configs/*`

### Decision models (System One / Jev)

An admin can store `provider: "decision"` in the same model catalog. It requires
an HTTP(S) `endpoint` and a `model`; `apiKey` is optional and uses Bearer auth.
Base URLs, `/v1`, and full `/v1/systemone` URLs are accepted. Examples:

- AIFabric: `http://llamacpp-decision-service:8000`, model `d3-mini`, no key.
  LAN alternative: `http://192.168.1.27:8001`.
- TypeSafe: `https://api.typesafe.ai`, model `jev-latest`, a TypeSafe API key.

These configurations are for board actions only. They cannot be assigned to agents
or used through the chat provider factory. Reasoning, context management and image
capabilities are forced off. Admin endpoints may reach private Swarm services;
workflow authors can only select a stored config ID, never supply a service URL.
Redirects are refused and provider errors are not copied into logs/history.

The `decision_model` workflow action has `llmConfigId`, `instructions`,
`routes: [{target, description}, ...]` (2–50 distinct board column IDs),
`minConfidence` (0–1, default 0.6), and optional `fallbackTarget`.
It posts one `choice` question to `/v1/systemone`, with task title, description,
type and priority as separate state data. It does not send attachments, repository
content, comments, conversation history or tools. State is limited to 12,000
characters and the request to 20,000; long content fails without silent truncation.
The request times out after 30 seconds and the response is limited to 64 KiB.

Only a declared choice with a valid probability distribution and confidence can
move the task. Below the confidence threshold, the explicit fallback is used;
without one, the workflow stops for manual review with an error displayed in its
originating column. Invalid answers and service errors always stop with an error,
even if a fallback is configured. No agent or tool execution is involved.
The action ends the current chain, including when it selects the current column.
Normal destination-entry workflow actions still run after a successful move.

The task's existing manual, stopped and approval gates still apply. Changes to
the task or workflow while the request is pending invalidate its result. The
history records the chosen column, confidence, threshold, fallback and token
usage without copying credentials or task content. Column renames rewrite both
decision destinations and fallback references.

Protocol reference: https://docs.typesafe.ai/api/system-one.

### GET `/api/llm-configs`
List configs. API keys are masked for non-admin viewers.

### GET `/api/llm-configs/:id`
Single config, masked for non-admin.

### POST `/api/llm-configs`
- **Auth**: `admin`.
- **Body**: `{ name, provider, baseUrl?, model, apiKey, costPerMtokIn?, costPerMtokOut?, headers? }`.

### PUT `/api/llm-configs/:id`
- **Auth**: `admin`. Preserves the existing API key when the client sends back the masked placeholder.

### DELETE `/api/llm-configs/:id`
- **Auth**: `admin`.
