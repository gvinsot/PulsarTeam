import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getAllLlmConfigs, getLlmConfig, saveLlmConfig, deleteLlmConfig } from '../services/database.js';
import { requireRole } from '../middleware/auth.js';

function maskApiKey(config, isAdmin) {
  return { ...config, apiKey: isAdmin ? config.apiKey : (config.apiKey ? '********' : '') };
}

export function llmConfigRoutes(agentManager) {
  const router = express.Router();

  // List all LLM configs (any authenticated user)
  router.get('/', async (req, res) => {
    try {
      const configs = await getAllLlmConfigs();
      const isAdmin = req.user?.role === 'admin';
      res.json(configs.map(c => maskApiKey(c, isAdmin)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single LLM config
  router.get('/:id', async (req, res) => {
    try {
      const config = await getLlmConfig(req.params.id);
      if (!config) return res.status(404).json({ error: 'Not found' });
      const isAdmin = req.user?.role === 'admin';
      res.json(maskApiKey(config, isAdmin));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create LLM config — admin only
  router.post('/', requireRole('admin'), async (req, res) => {
    try {
      const config = {
        id: uuidv4(),
        name: req.body.name || 'Unnamed',
        provider: req.body.provider || '',
        model: req.body.model || '',
        apiKey: req.body.apiKey || '',
        endpoint: req.body.endpoint || '',
        isReasoning: req.body.isReasoning || false,
        managesContext: !!req.body.managesContext,
        temperature: req.body.temperature ?? null,
        contextSize: req.body.contextSize ?? null,
        maxOutputTokens: req.body.maxOutputTokens ?? null,
        costPerInputToken: req.body.costPerInputToken ?? null,
        costPerOutputToken: req.body.costPerOutputToken ?? null,
        createdAt: new Date().toISOString(),
      };
      await saveLlmConfig(config);
      await agentManager.refreshLlmConfigs();
      res.status(201).json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update LLM config — admin only
  router.put('/:id', requireRole('admin'), async (req, res) => {
    try {
      const existing = await getLlmConfig(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });

      // If the API key is the masked placeholder, keep the existing key
      const apiKey = (req.body.apiKey && req.body.apiKey !== '********')
        ? req.body.apiKey
        : existing.apiKey;

      const config = {
        ...existing,
        name: req.body.name ?? existing.name,
        provider: req.body.provider ?? existing.provider,
        model: req.body.model ?? existing.model,
        apiKey,
        endpoint: req.body.endpoint ?? existing.endpoint,
        isReasoning: req.body.isReasoning ?? existing.isReasoning,
        temperature: 'temperature' in req.body ? req.body.temperature : existing.temperature,
        contextSize: 'contextSize' in req.body ? req.body.contextSize : existing.contextSize,
        maxOutputTokens: 'maxOutputTokens' in req.body ? req.body.maxOutputTokens : existing.maxOutputTokens,
        costPerInputToken: req.body.costPerInputToken ?? existing.costPerInputToken,
        costPerOutputToken: req.body.costPerOutputToken ?? existing.costPerOutputToken,
      };
      await saveLlmConfig(config);
      await agentManager.refreshLlmConfigs();
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete LLM config — admin only
  router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
      const existing = await getLlmConfig(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      await deleteLlmConfig(req.params.id);
      await agentManager.refreshLlmConfigs();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
