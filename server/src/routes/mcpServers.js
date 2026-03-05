import express from 'express';
import { z } from 'zod';

// Schema for creating an MCP server
const createMcpServerSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  enabled: z.boolean().optional(),
  apiKey: z.string().max(500).optional(),
});

// Schema for updating an MCP server (all fields optional)
const updateMcpServerSchema = createMcpServerSchema.partial();

/** Mask apiKey so the full value isn't exposed to the client. */
function sanitize(server) {
  if (!server) return server;
  const copy = { ...server };
  copy.hasApiKey = !!copy.apiKey;
  copy.apiKey = copy.apiKey ? '••••••••' : '';
  return copy;
}

export function mcpServerRoutes(mcpManager) {
  const router = express.Router();

  // List all MCP servers (with tools & status)
  router.get('/', (req, res) => {
    res.json(mcpManager.getAll().map(sanitize));
  });

  // Get single MCP server
  router.get('/:id', (req, res) => {
    const server = mcpManager.getById(req.params.id);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });
    res.json(sanitize(server));
  });

  // Create MCP server
  router.post('/', async (req, res) => {
    try {
      const parsed = createMcpServerSchema.parse(req.body);
      const server = await mcpManager.create(parsed);
      res.status(201).json(sanitize(server));
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Update MCP server
  router.put('/:id', async (req, res) => {
    try {
      const parsed = updateMcpServerSchema.parse(req.body);
      const server = await mcpManager.update(req.params.id, parsed);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });
      res.json(sanitize(server));
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Delete MCP server
  router.delete('/:id', async (req, res) => {
    try {
      const success = await mcpManager.delete(req.params.id);
      if (!success) return res.status(404).json({ error: 'MCP server not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force reconnect & refresh tools
  router.post('/:id/connect', async (req, res) => {
    try {
      const server = await mcpManager.connect(req.params.id);
      res.json(sanitize(server));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
