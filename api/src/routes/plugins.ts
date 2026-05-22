import express from 'express';
import { z } from 'zod';

const mcpConfigSchema = z.object({
  id: z.string().max(200).optional(),
  name: z.string().min(1).max(200),
  url: z.string().max(2000),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  enabled: z.boolean().optional(),
  authMode: z.enum(['none', 'bearer']).optional(),
  apiKey: z.string().max(500).optional(),
  hasApiKey: z.boolean().optional(),
  userConfig: z.record(z.string(), z.any()).optional(),
}).catchall(z.any());

const pluginSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  icon: z.string().max(50).optional(),
  instructions: z.string().min(1).max(50000),
  userConfig: z.record(z.string(), z.any()).optional(),
  mcps: z.array(mcpConfigSchema).optional(),
  shared: z.boolean().optional(),
}).catchall(z.any());

const createPluginSchema = pluginSchema;
const updatePluginSchema = pluginSchema.partial();
const shareSchema = z.object({ shared: z.boolean() });

function sanitizeMcp(mcp) {
  if (!mcp) return mcp;
  return {
    ...mcp,
    authMode: mcp.authMode || (mcp.apiKey ? 'bearer' : 'none'),
    hasApiKey: !!mcp.apiKey,
    apiKey: mcp.apiKey ? '••••••••' : '',
  };
}

function sanitizePlugin(plugin) {
  return {
    ...plugin,
    userConfig: plugin.userConfig || {},
    mcps: Array.isArray(plugin.mcps) ? plugin.mcps.map(sanitizeMcp) : [],
    mcpServerIds: Array.isArray(plugin.mcpServerIds) ? plugin.mcpServerIds : [],
  };
}

export function pluginRoutes(skillManager, mcpManager) {
  const router = express.Router();

  function currentUser(req) {
    return {
      userId: req.user?.userId || null,
      isAdmin: req.user?.role === 'admin',
    };
  }

  router.get('/', (req, res) => {
    const { userId, isAdmin } = currentUser(req);
    const plugins = skillManager.getAll(userId, isAdmin).map(sanitizePlugin);
    res.json(plugins);
  });

  router.get('/:id', (req, res) => {
    const plugin = skillManager.getById(req.params.id);
    if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
    const { userId, isAdmin } = currentUser(req);
    if (!skillManager.canView(plugin, userId, isAdmin)) {
      return res.status(404).json({ error: 'Plugin not found' });
    }
    res.json(sanitizePlugin(plugin));
  });

  // Any authenticated user can create their own plugin.
  router.post('/', async (req, res) => {
    try {
      const { userId } = currentUser(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const parsed = createPluginSchema.parse(req.body);
      const plugin = await skillManager.create(parsed, userId);
      res.status(201).json(sanitizePlugin(plugin));
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Update — full config edit allowed only for the owner (or admin).
  // Non-owners with view access (shared plugins) can only update userConfig
  // and per-mcp credentials (apiKey/authMode) at activation time.
  router.put('/:id', async (req, res) => {
    try {
      const { userId, isAdmin } = currentUser(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });

      const current = skillManager.getById(req.params.id);
      if (!current) return res.status(404).json({ error: 'Plugin not found' });
      if (!skillManager.canView(current, userId, isAdmin)) {
        return res.status(404).json({ error: 'Plugin not found' });
      }

      const isManager = skillManager.canManage(current, userId, isAdmin);

      const parsed = updatePluginSchema.parse(req.body);

      // Non-managers can only update userConfig + per-mcp credentials.
      // Anything else (instructions, mcps[].url/name/description, sharing, etc.)
      // requires being the plugin owner or an admin.
      if (!isManager) {
        const allowed = new Set(['userConfig', 'mcps']);
        const forbiddenKeys = Object.keys(parsed).filter((k) => !allowed.has(k));
        if (forbiddenKeys.length > 0) {
          return res.status(403).json({
            error: 'Only the plugin owner can edit the full configuration',
            forbiddenFields: forbiddenKeys,
          });
        }
        // If they sent mcps, restrict the per-mcp changes to credentials only
        if (Array.isArray(parsed.mcps)) {
          const currentMcps = Array.isArray(current.mcps) ? current.mcps : [];
          parsed.mcps = parsed.mcps.map((m) => {
            const existing = currentMcps.find((cm) => cm.id === m.id);
            if (!existing) return existing; // ignore additions from non-owners
            return {
              ...existing,
              authMode: m.authMode !== undefined ? m.authMode : existing.authMode,
              apiKey: m.apiKey !== undefined ? m.apiKey : existing.apiKey,
              enabled: m.enabled !== undefined ? m.enabled : existing.enabled,
            };
          }).filter(Boolean);
        }
      }

      // Preserve existing API keys when the frontend sends the masked placeholder
      if (Array.isArray(parsed.mcps)) {
        const currentMcps = Array.isArray(current.mcps) ? current.mcps : [];
        for (const mcp of parsed.mcps) {
          if (mcp.apiKey === '••••••••' && mcp.id) {
            const existing = currentMcps.find(m => m.id === mcp.id);
            mcp.apiKey = existing ? existing.apiKey : '';
          }
        }
      }

      const plugin = await skillManager.update(req.params.id, parsed);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });

      // Sync MCP apiKeys to the MCP server registry (global key) — managers only.
      if (isManager && Array.isArray(parsed.mcps)) {
        for (const mcp of parsed.mcps) {
          if (mcp.id && mcpManager.getById(mcp.id)) {
            const newKey = mcp.apiKey || '';
            const cur = mcpManager.getById(mcp.id);
            if (cur.apiKey !== newKey) {
              await mcpManager.update(mcp.id, { apiKey: newKey });
            }
          }
        }
      }

      res.json(sanitizePlugin(plugin));
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle the "shared" flag — owner-only.
  router.patch('/:id/share', async (req, res) => {
    try {
      const { userId, isAdmin } = currentUser(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });

      const current = skillManager.getById(req.params.id);
      if (!current) return res.status(404).json({ error: 'Plugin not found' });
      if (!skillManager.canManage(current, userId, isAdmin)) {
        return res.status(403).json({ error: 'Only the plugin owner can change sharing' });
      }

      const { shared } = shareSchema.parse(req.body);
      const updated = await skillManager.setShared(req.params.id, shared);
      res.json(sanitizePlugin(updated));
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const { userId, isAdmin } = currentUser(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });

      const current = skillManager.getById(req.params.id);
      if (!current) return res.status(404).json({ error: 'Plugin not found' });
      if (!skillManager.canManage(current, userId, isAdmin)) {
        return res.status(403).json({ error: 'Only the plugin owner can delete this plugin' });
      }

      const success = await skillManager.delete(req.params.id);
      if (!success) return res.status(404).json({ error: 'Plugin not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/mcps/:mcpId', async (req, res) => {
    try {
      const { userId, isAdmin } = currentUser(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });

      const plugin = skillManager.getById(req.params.id);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
      if (!skillManager.canManage(plugin, userId, isAdmin)) {
        return res.status(403).json({ error: 'Only the plugin owner can modify MCP wiring' });
      }
      const server = mcpManager.getById(req.params.mcpId);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });

      const mcps = Array.isArray(plugin.mcps) ? [...plugin.mcps] : [];
      if (!mcps.some((m) => m.id === server.id)) {
        mcps.push({
          id: server.id,
          name: server.name,
          url: server.url,
          description: server.description || '',
          icon: server.icon || '🔌',
          enabled: server.enabled !== false,
          apiKey: server.apiKey || '',
          userConfig: {},
        });
      }

      const updated = await skillManager.update(req.params.id, { mcps });
      res.json(sanitizePlugin(updated));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id/mcps/:mcpId', async (req, res) => {
    try {
      const { userId, isAdmin } = currentUser(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });

      const plugin = skillManager.getById(req.params.id);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
      if (!skillManager.canManage(plugin, userId, isAdmin)) {
        return res.status(403).json({ error: 'Only the plugin owner can modify MCP wiring' });
      }
      const mcps = (Array.isArray(plugin.mcps) ? plugin.mcps : []).filter((m) => m.id !== req.params.mcpId);
      const updated = await skillManager.update(req.params.id, { mcps });
      res.json(sanitizePlugin(updated));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
