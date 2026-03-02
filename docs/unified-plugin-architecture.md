# Unified Plugin System Architecture (Skills → Plugins)

## Goals

1. Rename the legacy concept **skills** to **plugins** across architecture and interfaces.
2. Support **first-class MCP module integration** per plugin.
3. Provide a **single unified configuration surface** in the global control panel modal (no separate tabs per subsystem).
4. Keep plugin configuration secure, especially for secrets (API keys, tokens).
5. Make plugin loading deterministic, observable, and extensible.

---

## Core Concepts

### Plugin
A plugin is a capability package that can expose:
- runtime tools/actions
- optional UI metadata
- optional MCP module bindings
- configuration schema and defaults
- lifecycle hooks

### MCP Module
An MCP module is an external or local module endpoint that a plugin can use.  
A plugin may have zero, one, or many MCP modules attached.

### Unified Control Panel
A single modal where all plugin instances are listed and configured in one place:
- enable/disable plugin
- configure plugin fields
- configure linked MCP modules
- validate and save atomically

---

## Canonical Data Model

```ts
// Shared primitive types
type PluginId = string;
type PluginVersion = string;
type MCPModuleId = string;

// Secret references are never returned as raw values in read APIs.
interface SecretRef {
  key: string;            // e.g. "plugins.weather.apiKey"
  masked?: string;        // e.g. "••••••abcd"
  isSet: boolean;
}

// MCP module definition
interface MCPModuleDefinition {
  id: MCPModuleId;
  name: string;
  description?: string;
  transport: "stdio" | "http" | "ws";
  endpoint?: string;      // for http/ws
  command?: string;       // for stdio
  args?: string[];
  env?: Record<string, string | SecretRef>;
  healthcheck?: {
    type: "ping" | "http";
    intervalMs?: number;
    timeoutMs?: number;
    path?: string;
  };
}

// Plugin config schema field
interface PluginConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "secret" | "json";
  required?: boolean;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: string }>;
  description?: string;
}

// Plugin definition (registry-time)
interface PluginDefinition {
  id: PluginId;
  name: string;
  version: PluginVersion;
  description?: string;
  category?: string;
  configSchema: PluginConfigField[];
  defaultConfig?: Record<string, unknown>;
  mcpBindings?: {
    allowedModuleIds?: MCPModuleId[]; // optional allow-list
    min?: number;
    max?: number;
  };
  hooks?: {
    onLoad?: string;      // symbolic handler name
    onEnable?: string;
    onDisable?: string;
    onUnload?: string;
  };
}

// Persisted plugin instance config
interface PluginInstanceConfig {
  pluginId: PluginId;
  enabled: boolean;
  config: Record<string, unknown>; // secrets stored server-side only
  mcpModules: MCPModuleId[];       // linked MCP modules
  updatedAt: string;
  updatedBy?: string;
}

// Unified control panel payload
interface UnifiedPluginsSettings {
  plugins: PluginInstanceConfig[];
  mcpModules: MCPModuleDefinition[];
  revision: number; // optimistic concurrency
}
```

---

## Backend Interfaces

```ts
interface PluginRegistry {
  register(def: PluginDefinition): void;
  get(pluginId: PluginId): PluginDefinition | undefined;
  list(): PluginDefinition[];
}

interface MCPRegistry {
  register(module: MCPModuleDefinition): void;
  get(moduleId: MCPModuleId): MCPModuleDefinition | undefined;
  list(): MCPModuleDefinition[];
  health(moduleId: MCPModuleId): Promise<"ok" | "degraded" | "down">;
}

interface PluginConfigStore {
  getAll(): Promise<UnifiedPluginsSettings>;
  saveAll(next: UnifiedPluginsSettings): Promise<void>;
  getPlugin(pluginId: PluginId): Promise<PluginInstanceConfig | undefined>;
  savePlugin(cfg: PluginInstanceConfig): Promise<void>;
}

interface PluginRuntime {
  load(pluginId: PluginId): Promise<void>;
  unload(pluginId: PluginId): Promise<void>;
  enable(pluginId: PluginId): Promise<void>;
  disable(pluginId: PluginId): Promise<void>;
  reload(pluginId: PluginId): Promise<void>;
  listActive(): PluginId[];
}
```

---

## Loading Mechanism

1. **Bootstrap**
   - Load plugin definitions from built-ins + filesystem modules.
   - Load MCP module definitions.
   - Load persisted `UnifiedPluginsSettings`.

2. **Validation**
   - Validate each plugin config against `configSchema`.
   - Validate MCP bindings (`min/max`, allow-list, module existence).

3. **Activation**
   - For each `enabled` plugin:
     - initialize plugin runtime context
     - attach resolved MCP clients for linked modules
     - run `onLoad` then `onEnable` hooks

4. **Runtime updates**
   - Control panel submits full settings with `revision`.
   - Server validates and persists atomically.
   - Runtime computes diff and applies:
     - enable/disable/reload only changed plugins
     - reconnect MCP clients if module links changed

5. **Observability**
   - Emit events:
     - `plugin.loaded`, `plugin.enabled`, `plugin.disabled`, `plugin.error`
     - `mcp.connected`, `mcp.disconnected`, `mcp.health_changed`

---

## Unified Control Panel API (No Separate Tabs)

### Read settings
`GET /api/plugins/settings`

Response:
```json
{
  "definitions": [],
  "settings": {
    "plugins": [],
    "mcpModules": [],
    "revision": 12
  }
}
```

### Save settings
`PUT /api/plugins/settings`

Request:
```json
{
  "plugins": [],
  "mcpModules": [],
  "revision": 12
}
```

Behavior:
- validates payload
- masks/handles secrets
- optimistic concurrency check on `revision`
- persists and hot-applies runtime diff
- returns updated `revision`

### Secret update endpoint (optional)
`PUT /api/plugins/:pluginId/secrets`
- accepts secret fields only
- never returns raw secret values

---

## Security Model

- Secret fields (`type: "secret"`) are write-only from UI.
- Read APIs return `{ isSet, masked }` metadata only.
- Secrets stored in secure backend store (env vault, encrypted DB, or secret manager).
- Audit log on plugin config changes:
  - actor, pluginId, changed keys, timestamp
- MCP module credentials follow same secret handling.

---

## Migration Plan (Skills → Plugins)

1. **Terminology migration**
   - Rename user-facing labels and docs from “skills” to “plugins”.
2. **Compatibility layer**
   - Accept legacy `skills` payloads in API for one transition window.
   - Internally map to `plugins`.
3. **Data migration**
   - Convert persisted keys:
     - `skills.*` → `plugins.*`
4. **Deprecation**
   - Log warning on legacy endpoints/fields.
   - Remove compatibility after defined versions.

---

## Suggested File/Module Layout

```txt
server/src/plugins/
  pluginTypes.ts|js
  pluginRegistry.ts|js
  pluginRuntime.ts|js
  pluginConfigStore.ts|js
  mcpRegistry.ts|js
  pluginSettingsController.ts|js
  migrationSkillsToPlugins.ts|js
```

UI:
```txt
src/components/control-panel/
  PluginsControlPanelModal.tsx|jsx
  PluginCard.tsx|jsx
  PluginConfigForm.tsx|jsx
  MCPModuleBindingsEditor.tsx|jsx
```

---

## Minimal Runtime Context Contract

```ts
interface PluginRuntimeContext {
  pluginId: string;
  logger: {
    info(msg: string, meta?: any): void;
    warn(msg: string, meta?: any): void;
    error(msg: string, meta?: any): void;
  };
  config: Record<string, unknown>;
  mcp: {
    getClient(moduleId: string): unknown;
    listClients(): Array<{ moduleId: string; status: string }>;
  };
}
```

---

## Example Plugin Definition

```json
{
  "id": "web-search",
  "name": "Web Search",
  "version": "1.0.0",
  "description": "Searches web sources with optional MCP connectors",
  "configSchema": [
    { "key": "provider", "label": "Provider", "type": "select", "required": true, "options": [
      { "label": "SerpAPI", "value": "serpapi" },
      { "label": "Brave", "value": "brave" }
    ]},
    { "key": "apiKey", "label": "API Key", "type": "secret", "required": true }
  ],
  "mcpBindings": { "min": 0, "max": 2 }
}
```

---

## Testing Strategy

- Unit:
  - schema validation
  - secret masking
  - MCP binding constraints
  - runtime diff application
- Integration:
  - `GET/PUT /api/plugins/settings`
  - optimistic concurrency conflicts
  - plugin enable/disable hot reload
- E2E:
  - single modal edits plugin + MCP module in one save flow
  - no separate tabs required