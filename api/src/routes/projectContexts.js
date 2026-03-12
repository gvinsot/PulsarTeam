import express from 'express';
import { getAllProjectContexts, saveProjectContext, deleteProjectContextFromDb } from '../services/database.js';

export function projectContextRoutes() {
  const router = express.Router();

  // List all project contexts
  router.get('/', async (req, res) => {
    const contexts = await getAllProjectContexts();
    res.json(contexts);
  });

  // Get single project context by name
  router.get('/:name', async (req, res) => {
    const contexts = await getAllProjectContexts();
    const ctx = contexts.find(c => c.name === req.params.name);
    if (!ctx) return res.json({ name: req.params.name, description: '', rules: '' });
    res.json(ctx);
  });

  // Create or update a project context
  router.put('/:name', async (req, res) => {
    const { description = '', rules = '' } = req.body || {};
    const ctx = { name: req.params.name, description, rules, updatedAt: new Date().toISOString() };
    await saveProjectContext(ctx);
    res.json(ctx);
  });

  // Delete a project context
  router.delete('/:name', async (req, res) => {
    await deleteProjectContextFromDb(req.params.name);
    res.json({ success: true });
  });

  return router;
}
