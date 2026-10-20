import express from 'express';
import { errorMessage } from '../lib/errors.js';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '../lib/asyncHandler.js';
import type { z } from 'zod';
import {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getPendingApprovalUsers,
  countPendingApprovalUsers,
  setUserApprovalStatus,
} from '../services/database.js';
import type { ApprovalStatus, PendingApprovalUserRow } from '../services/database/users.js';
import { getConnectedUserIds } from '../ws/socketHandler.js';
import { provisionNewUser } from '../services/userProvisioning.js';
import { emitPendingUsersCount, type AdminSocketEmitter } from '../services/userApproval.js';
import { validateBody, validateParams } from '../lib/validate.js';
import {
  approveUserSchema,
  createUserSchema,
  updateUserSchema,
  userIdParamsSchema,
} from '../schemas/users.js';

/** The provider a pending account signed up with (an OAuth sign-up has exactly one). */
function providerOf(u: PendingApprovalUserRow): 'google' | 'microsoft' | 'github' | null {
  if (u.google_id) return 'google';
  if (u.microsoft_id) return 'microsoft';
  if (u.github_id) return 'github';
  return null;
}

/**
 * Settle a pending account. 404 when it does not exist, 409 when it is not (or
 * no longer — another admin got there first) pending.
 */
async function decidePending(id: string, to: ApprovalStatus, role?: string) {
  const current = await getUserById(id);
  if (!current) return { user: null, status: 404, error: 'User not found' };
  if (current.approval_status !== 'pending') {
    return { user: null, status: 409, error: 'User is not pending approval' };
  }
  const user = await setUserApprovalStatus(id, 'pending', to, role);
  if (!user) return { user: null, status: 409, error: 'User is not pending approval' };
  return { user, status: 200, error: '' };
}

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

  // ── Approval of new OAuth accounts ────────────────────────────────────
  // Declared before GET /:id, which would otherwise take "pending" for an id.

  // Accounts awaiting approval, oldest first.
  router.get(
    '/pending',
    asyncHandler(async (_req, res) => {
      const rows = await getPendingApprovalUsers();
      res.json({
        users: rows.map(u => ({
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          avatarUrl: u.avatar_url,
          provider: providerOf(u),
          createdAt: u.created_at,
        })),
      });
    })
  );

  // How many accounts await approval — the admin menu badge at load.
  router.get(
    '/pending/count',
    asyncHandler(async (_req, res) => {
      res.json({ count: await countPendingApprovalUsers() });
    })
  );

  // Let a pending account in, with the given role, and provision it now — an
  // OAuth sign-up was deliberately left unprovisioned until this point.
  router.post<{ id: string }>(
    '/:id/approve',
    validateParams(userIdParamsSchema),
    validateBody(approveUserSchema),
    asyncHandler(async (req, res) => {
      const { role } = req.body as z.infer<typeof approveUserSchema>;
      const decision = await decidePending(req.params.id, 'approved', role ?? 'advanced');
      if (!decision.user) {
        res.status(decision.status).json({ error: decision.error });
        return;
      }
      const user = decision.user;
      await provisionNewUser(user.id).catch(err =>
        console.error('Provisioning error:', err.message)
      );
      console.log(
        `[Auth] ${req.user?.username} approved "${user.username}" (${user.id}) as ${user.role}`
      );
      await emitPendingUsersCount(req.app.get('io') as AdminSocketEmitter | undefined);
      res.json({ user });
    })
  );

  // Decline a pending account. The row stays (as 'rejected') so the same
  // identity cannot simply sign up again; DELETE /:id still removes it.
  router.post<{ id: string }>(
    '/:id/reject',
    validateParams(userIdParamsSchema),
    asyncHandler(async (req, res) => {
      const decision = await decidePending(req.params.id, 'rejected');
      if (!decision.user) {
        res.status(decision.status).json({ error: decision.error });
        return;
      }
      console.log(
        `[Auth] ${req.user?.username} rejected "${decision.user.username}" (${decision.user.id})`
      );
      await emitPendingUsersCount(req.app.get('io') as AdminSocketEmitter | undefined);
      res.json({ success: true });
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
      // The account may have been waiting for approval: keep the admin badge true.
      await emitPendingUsersCount(req.app.get('io') as AdminSocketEmitter | undefined);
      res.json({ success: true });
    })
  );

  return router;
}
