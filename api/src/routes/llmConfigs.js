import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getAllLlmConfigs, getLlmConfig, saveLlmConfig, deleteLlmConfig } from '../services/database.js';

export function llmConfigRoutes() {
  const router = express.Router();

  // List all LLM configs
  router.get('/', async (req, res) => {
    try {
      const configs = await getAllLlmConfigs();
      res.json(configs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single LLM config
  router.get('/:id', async (req, res) => {
    try {
      const config = await getLlmConfig(req.params.id);
      if (!config) return res.status(404).json({ error: 'Not found' });
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create LLM config
  router.post('/', async (req, res) => {
    try {
      const config = {
        id: req.body.id || uuidv4(),
        name: req.body.name || 'Unnamed',
        provider: req.body.provider || '',
        model: req.body.model || '',
        apiKey: req.body.apiKey || '',
        endpoint: req.body.endpoint || '',
        maxOutput: req.body.maxOutput || null,
        thinking: req.body.thinking || false,
        isReasoning: req.body.isReasoning || false,
        createdAt: req.body.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveLlmConfig(config);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update LLM config
  router.put('/:id', async (req, res) => {
    try {
      const existing = await getLlmConfig(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const config = {
        ...existing,
        name: req.body.name ?? existing.name,
        provider: req.body.provider ?? existing.provider,
        model: req.body.model ?? existing.model,
        apiKey: req.body.apiKey ?? existing.apiKey,
        endpoint: req.body.endpoint ?? existing.endpoint,
        maxOutput: req.body.maxOutput ?? existing.maxOutput,
        thinking: req.body.thinking ?? existing.thinking,
        isReasoning: req.body.isReasoning ?? existing.isReasoning,
        updatedAt: new Date().toISOString(),
      };
      await saveLlmConfig(config);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete LLM config
  router.delete('/:id', async (req, res) => {
    try {
      await deleteLlmConfig(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
