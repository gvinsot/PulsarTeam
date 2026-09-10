import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
});

// OAuth callbacks: code is opaque from the provider, redirect_uri is validated
// against the allow-list separately. Keep the schema permissive but bounded.
//
// `state` is required — it is the login-CSRF defence (see the note in
// routes/authLogin.ts). Bounded rather than shaped: the handler verifies the
// HMAC, and a schema that guessed at the encoding would reject valid states the
// day the store's format changes.
export const oauthCallbackSchema = z.object({
  code: z.string().min(1).max(4000),
  redirect_uri: z.string().url().max(2000).optional(),
  state: z.string().min(1).max(4000),
});

export const oauthUrlQuerySchema = z.object({
  redirect_uri: z.string().url().max(2000).optional(),
});

export const impersonateParamsSchema = z.object({
  userId: z.string().uuid(),
});
