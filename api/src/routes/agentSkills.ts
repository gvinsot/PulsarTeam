import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import {
  getAllAgentSkills,
  searchAgentSkills,
  getAgentSkillById,
  saveAgentSkill,
  deleteAgentSkillFromDb,
} from '../services/database.js';

const agentSkillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  instructions: z.string().min(1).max(100000),
  mcpServerIds: z.array(z.string().max(200)).optional(),
}).catchall(z.any());

const updateAgentSkillSchema = agentSkillSchema.partial();

export function agentSkillRoutes() {
  const router = express.Router();

  // List all agent skills
  router.get('/', async (req, res) => {
    try {
      const skills = await getAllAgentSkills();
      res.json(skills);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Search agent skills
  router.get('/search', async (req, res) => {
    try {
      const query = req.query.q || req.query.query || '';
      if (!(query as string).trim()) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      const skills = await searchAgentSkills(query);
      res.json(skills);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get a single agent skill
  router.get('/:id', async (req, res) => {
    try {
      const skill = await getAgentSkillById(req.params.id);
      if (!skill) return res.status(404).json({ error: 'Agent skill not found' });
      res.json(skill);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new agent skill (admin/advanced — skills get injected into agent prompts globally)
  router.post('/', requireRole('admin', 'advanced'), async (req, res) => {
    try {
      const parsed = agentSkillSchema.parse(req.body);
      const now = new Date().toISOString();
      const skill = {
        id: `agent-skill-${uuidv4()}`,
        name: parsed.name,
        description: parsed.description || '',
        category: parsed.category || 'general',
        instructions: parsed.instructions,
        mcpServerIds: parsed.mcpServerIds || [],
        createdBy: req.user?.username || 'admin',
        createdByAgentId: null,
        useCount: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await saveAgentSkill(skill);
      res.status(201).json(skill);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Update an agent skill (admin/advanced)
  router.put('/:id', requireRole('admin', 'advanced'), async (req, res) => {
    try {
      const existing = await getAgentSkillById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Agent skill not found' });

      const parsed = updateAgentSkillSchema.parse(req.body);
      const allowedFields = ['name', 'description', 'category', 'instructions', 'mcpServerIds'];
      for (const key of allowedFields) {
        if (parsed[key] !== undefined) {
          existing[key] = parsed[key];
        }
      }
      existing.updatedAt = new Date().toISOString();
      existing.lastUpdatedBy = req.user?.username || 'admin';
      await saveAgentSkill(existing);
      res.json(existing);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Delete an agent skill (admin/advanced)
  router.delete('/:id', requireRole('admin', 'advanced'), async (req, res) => {
    try {
      const existing = await getAgentSkillById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Agent skill not found' });

      await deleteAgentSkillFromDb(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
