import express from 'express';

export function pluginRoutes(skillManager, mcpManager) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const plugins = skillManager.getAll().map((s) => ({
      ...s,
      mcpServerIds: Array.isArray(s.mcpServerIds) ? s.mcpServerIds : []
    }));
    res.json(plugins);
  });

  router.get('/:id', (req, res) => {
    const plugin = skillManager.getById(req.params.id);
    if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
    res.json({
      ...plugin,
      mcpServerIds: Array.isArray(plugin.mcpServerIds) ? plugin.mcpServerIds : []
    });
  });

  router.post('/', async (req, res) => {
    try {
      const { name, description, category, icon, instructions, mcpServerIds = [] } = req.body;
      if (!name || !instructions) {
        return res.status(400).json({ error: 'Name and instructions required' });
      }
      const plugin = await skillManager.create({
        name,
        description,
        category,
        icon,
        instructions,
        mcpServerIds: Array.isArray(mcpServerIds) ? mcpServerIds : []
      });
      res.status(201).json(plugin);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const plugin = await skillManager.update(req.params.id, req.body);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
      res.json(plugin);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const success = await skillManager.delete(req.params.id);
      if (!success) return res.status(404).json({ error: 'Plugin not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/mcps/:mcpId', async (req, res) => {
    try {
      const plugin = skillManager.getById(req.params.id);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
      const ids = new Set(Array.isArray(plugin.mcpServerIds) ? plugin.mcpServerIds : []);
      ids.add(req.params.mcpId);
      const updated = await skillManager.update(req.params.id, { mcpServerIds: [...ids] });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id/mcps/:mcpId', async (req, res) => {
    try {
      const plugin = skillManager.getById(req.params.id);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
      const ids = (Array.isArray(plugin.mcpServerIds) ? plugin.mcpServerIds : []).filter((id) => id !== req.params.mcpId);
      const updated = await skillManager.update(req.params.id, { mcpServerIds: ids });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}