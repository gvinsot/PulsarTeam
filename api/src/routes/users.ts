import express from 'express';
import { errorMessage } from '../lib/errors.js';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
} from '../services/database.js';
import { getConnectedUserIds } from '../ws/socketHandler.js';
import { provisionNewUser } from '../services/userProvisioning.js';
import { validateBody, validateParams } from '../lib/validate.js';
import { createUserSchema, updateUserSchema, userIdParamsSchema } from '../schemas/users.js';

export function userRoutes() {
  const router = express.Router();

  // List all users (admin only — enforced by requireRole in index.js)
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const users = await getAllUsers();
      const connected = getConnectedUserIds();
      res.json(users.map(u => ({ ...u, is_online: connected.has(u.id) })));
    })
  );

  // Get single user
  router.get(
    '/:id',
    validateParams(userIdParamsSchema),
    asyncHandler(async (req, res) => {
      const user = await getUserById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const { password, ...safe } = user;
      res.json(safe);
    })
  );

  // Create user
  router.post(
    '/',
    validateBody(createUserSchema),
    asyncHandler(async (req, res) => {
      try {
        const parsed = req.body as any;
        const hash = await bcrypt.hash(parsed.password, 10);
        const user = await createUser(
          parsed.username,
          hash,
          parsed.role,
          parsed.displayName || parsed.username
        );
        await provisionNewUser(user.id).catch(err =>
          console.error('Provisioning error:', err.message)
        );
        res.status(201).json(user);
      } catch (err) {
        res.status(400).json({ error: errorMessage(err) });
      }
    })
  );

  // Update user
  // The route's params type is passed explicitly (the express typings ask for
  // it): without it `P` is inferred from the `validateParams` middleware as the
  // loose `ParamsDictionary`, whose values are `string | string[]`.
  router.put<{ id: string }>(
    '/:id',
    validateParams(userIdParamsSchema),
    validateBody(updateUserSchema),
    asyncHandler(async (req, res) => {
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
        if (!user) {
          res.status(404).json({ error: 'User not found' });
          return;
        }
        // Strip the hash the same way GET /:id does. The UPDATE path returns an
        // explicit column list that never includes it, but a body that sets no
        // field at all (every key of updateUserSchema is optional, so `{}`
        // validates) short-circuits to getUserById, which is a `SELECT *`.
        const { password, ...safe } = user;
        res.json(safe);
      } catch (err) {
        res.status(400).json({ error: errorMessage(err) });
      }
    })
  );

  // Delete user
  router.delete(
    '/:id',
    validateParams(userIdParamsSchema),
    asyncHandler(async (req, res) => {
      // Prevent self-deletion
      if (req.params.id === req.user.userId) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }
      const success = await deleteUser(req.params.id);
      if (!success) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true });
    })
  );

  return router;
}
