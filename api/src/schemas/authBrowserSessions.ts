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
    // Absent from snapshots saved before configurable lifetimes and re-login.
    lifetime: z
      .number()
      .int()
      .positive()
      .max(31 * 24 * 3600)
      .optional(),
    keepalive_at: z.number().finite().min(0).optional(),
    relogin_failures: z.number().int().min(0).max(1000).optional(),
    relogin_at: z.number().finite().min(0).optional(),
    storage: z
      .object({
        cookies: z.array(z.record(z.string(), z.unknown())).max(3000),
        origins: z.array(z.record(z.string(), z.unknown())).max(100),
      })
      .strict(),
  })
  .strict();
export const browserSessionDelete = z.object({ key: browserSessionKey }).strict();

/** Base32 TOTP secret as authenticator apps show it (spaces/dashes allowed). */
export const totpSecret = z
  .string()
  .max(200)
  .transform(v => v.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, ''))
  .pipe(z.string().regex(/^[A-Z2-7]{16,128}$/, 'Invalid TOTP secret'));

/**
 * Sign-in credentials for the automatic re-login of one shared website
 * session. Stored encrypted; only the browser worker reads them back.
 * `login_url` must be on the session's own origin (checked by the route).
 */
export const browserCredentials = z
  .object({
    username: z.string().min(1).max(500),
    password: z.string().min(1).max(1000),
    totp_secret: totpSecret.optional(),
    login_url: z.string().url().max(4000).startsWith('https://').optional(),
  })
  .strict();
export type BrowserCredentials = z.infer<typeof browserCredentials>;
export type BrowserSessionSnapshot = z.infer<typeof browserSessionSnapshot>;
