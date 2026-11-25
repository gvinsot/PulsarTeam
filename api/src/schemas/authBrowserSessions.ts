import { z } from 'zod';

export const browserSessionKey = z
  .string()
  .regex(/^(agent|board):[a-zA-Z0-9_-]{1,200}@[a-zA-Z0-9.-]{1,253}$/);
export const browserSessionSnapshot = z
  .object({
    version: z.literal(1),
    key: browserSessionKey,
    id: z.string().uuid(),
    controller: z.string().min(1).max(200),
    origin: z.string().url().max(4000),
    phase: z.enum(['ready', 'login', 'reauth_required']),
    created: z.number().finite().positive(),
    used: z.number().finite().positive(),
    url: z.string().url().max(4000),
    user_agent: z.string().max(1000),
    storage: z
      .object({
        cookies: z.array(z.record(z.string(), z.unknown())).max(3000),
        origins: z.array(z.record(z.string(), z.unknown())).max(100),
      })
      .strict(),
  })
  .strict();
export const browserSessionDelete = z.object({ key: browserSessionKey }).strict();
export type BrowserSessionSnapshot = z.infer<typeof browserSessionSnapshot>;
