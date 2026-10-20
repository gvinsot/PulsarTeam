import { z } from 'zod';

export const createUserSchema = z.object({
  username: z.string().min(2).max(100),
  password: z.string().min(4).max(200),
  role: z.enum(['admin', 'advanced', 'basic']).default('advanced'),
  displayName: z.string().max(200).optional(),
});

export const updateUserSchema = z.object({
  username: z.string().min(2).max(100).optional(),
  password: z.string().min(4).max(200).optional(),
  role: z.enum(['admin', 'advanced', 'basic']).optional(),
  displayName: z.string().max(200).optional(),
});

/** POST /api/users/:id/approve — the role the account is let in with. */
export const approveUserSchema = z.object({
  role: z.enum(['admin', 'advanced', 'basic']).optional(),
});

export const userIdParamsSchema = z.object({
  id: z.string().uuid(),
});
