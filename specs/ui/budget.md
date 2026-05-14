# UI Spec — Budget tab

Route: `#budget`.
Renders: `frontend/src/components/BudgetDashboard.tsx`.

---

## 1. Purpose

The Budget tab reports **LLM token usage and cost** across the swarm, and lets administrators configure a daily budget and alert thresholds. Costs are computed from token counts using each LLM config's `costPerMtokIn` / `costPerMtokOut` (and the per-agent overrides if set).

---

## 2. Summary header

A summary card displays:
- **Today's cost** in the active currency
- **Daily budget** target
- **Progress bar** colored:
  - green when spent < 80 % of the budget,
  - yellow when 80–99 %,
  - red when ≥ 100 %.
- Alerts (if any): "Daily budget exceeded for agent X" or "Approaching daily budget".
- A **Budget settings** button (gear icon) — admin only.

Range selector: **7 / 30 / 90 days** controls all charts below.

Currency: read from the user's settings (`getSettings`). Defaults to USD; can be EUR, GBP, or custom.

The dashboard auto-refreshes data every 30 seconds.

---

## 3. Charts

### 3.1 Daily cost
Line chart of total cost per day over the selected range. The daily budget appears as an overlay threshold.

### 3.2 Token type breakdown
Bar chart of input vs. output vs. context (cached) tokens per day.

### 3.3 Multi-agent timeline
Stacked bar chart of token usage per agent per day.

### 3.4 Agent cost donut
Donut chart breaking down total cost by agent.

---

## 4. Budget settings modal

Admin-only modal accessed from the gear icon.

| Field | Description |
|---|---|
| Daily budget | Maximum amount (in active currency) per day. |
| Alert threshold | Fraction of the budget (e.g. 0.8 = warn at 80 %). |
| Currency | Picker: USD / EUR / GBP / custom symbol. |
| Save | Calls `updateBudgetConfig`. |

Configuration is per-installation (global).

---

## 5. Scope of data

- **Non-admin users**: see only their own agents (filtered server-side by `ownerId`).
- **Admin users**: see the entire swarm. A future per-user breakdown view is hinted at but not yet present.

---

## 6. Real-time updates

No socket events — pure polling (`setInterval(loadData, 30000)`).

---

## 7. Permissions

| Action | Required |
|---|---|
| View Budget tab | `basic`+ |
| Edit budget config | `admin` |
| See swarm-wide data | `admin` (otherwise own agents only) |
