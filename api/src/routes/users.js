import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  getAllUsers, getUserById, createUser, updateUser, deleteUser
} from '../services/database.js';

const createUserSchema = z.object({
  username: z.string().min(2).max(100),
  password: z.string().min(4).max(200),
  role: z.enum(['admin', 'advanced', 'basic']).default('basic'),
  displayName: z.string().max(200).optional(),
});

const updateUserSchema = z.object({
  username: z.string().min(2).max(100).optional(),
  password: z.string().min(4).max(200).optional(),
  role: z.enum(['admin', 'advanced', 'basic']).optional(),
  displayName: z.string().max(200).optional(),
});

export function userRoutes() {
  const router = express.Router();

  // List all users (admin only — enforced by requireRole in index.js)
  router.get('/', async (req, res) => {
    try {
      const users = await getAllUsers();
      res.json(users);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single user
  router.get('/:id', async (req, res) => {
    try {
      const user = await getUserById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const { password, ...safe } = user;
      res.json(safe);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create user
  router.post('/', async (req, res) => {
    try {
      const parsed = createUserSchema.parse(req.body);
      const hash = await bcrypt.hash(parsed.password, 10);
      const user = await createUser(
        parsed.username,
        hash,
        parsed.role,
        parsed.displayName || parsed.username
      );
      res.status(201).json(user);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Update user
  router.put('/:id', async (req, res) => {
    try {
      const parsed = updateUserSchema.parse(req.body);
      const fields = {};
      if (parsed.username) fields.username = parsed.username;
      if (parsed.role) fields.role = parsed.role;
      if (parsed.displayName !== undefined) fields.display_name = parsed.displayName;
      if (parsed.password) {
        fields.password = await bcrypt.hash(parsed.password, 10);
      }
      const user = await updateUser(req.params.id, fields);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Delete user
  router.delete('/:id', async (req, res) => {
    // Prevent self-deletion
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    try {
      const success = await deleteUser(req.params.id);
      if (!success) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
