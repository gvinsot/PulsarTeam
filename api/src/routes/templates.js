import express from 'express';
import { AGENT_TEMPLATES } from '../data/templates.js';

export function templateRoutes() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(AGENT_TEMPLATES);
  });

  router.get('/:id', (req, res) => {
    const template = AGENT_TEMPLATES.find(t => t.id === req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  });

  return router;
}
