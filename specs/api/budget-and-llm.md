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
