import express from 'express';
import bcrypt from 'bcryptjs';
import {
  getAllUsers, getUserById, createUser, updateUser, deleteUser
} from '../services/database.js';
import { getConnectedUserIds } from '../ws/socketHandler.js';
import { provisionNewUser } from '../services/userProvisioning.js';
import { validateBody, validateParams } from '../lib/validate.js';
import { createUserSchema, updateUserSchema, userIdParamsSchema } from '../schemas/users.js';

export function userRoutes() {
  const router = express.Router();

  // List all users (admin only — enforced by requireRole in index.js)
  router.get('/', async (req, res) => {
    try {
      const users = await getAllUsers();
      const connected = getConnectedUserIds();
      res.json(users.map(u => ({ ...u, is_online: connected.has(u.id) })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single user
  router.get('/:id', validateParams(userIdParamsSchema), async (req, res) => {
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
  router.post('/', validateBody(createUserSchema), async (req, res) => {
    try {
      const parsed = req.body as any;
      const hash = await bcrypt.hash(parsed.password, 10);
      const user = await createUser(
        parsed.username,
        hash,
        parsed.role,
        parsed.displayName || parsed.username
      );
      await provisionNewUser(user.id).catch(err => console.error('Provisioning error:', err.message));
      res.status(201).json(user);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Update user
  router.put('/:id', validateParams(userIdParamsSchema), validateBody(updateUserSchema), async (req, res) => {
    try {
      const parsed = req.body as any;
      const fields: Record<string, any> = {};
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
      res.status(400).json({ error: err.message });
    }
  });

  // Delete user
  router.delete('/:id', validateParams(userIdParamsSchema), async (req, res) => {
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
