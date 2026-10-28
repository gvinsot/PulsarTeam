import { z } from 'zod';
import { assertAdminServiceUrl } from '../lib/ssrfGuard.js';

export const decisionConfigSchema = z.object({
  provider: z.literal('decision'),
  model: z.string().trim().min(1).max(200),
  endpoint: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine(value => {
      try {
        assertAdminServiceUrl(value);
        return true;
      } catch {
        return false;
      }
    }, 'Expected an HTTP(S) service URL without credentials, query or fragment'),
  apiKey: z.string().max(10000).optional(),
});

export const decisionActionSchema = z
  .object({
    type: z.literal('decision_model'),
    llmConfigId: z.string().min(1).max(200),
    instructions: z.string().trim().min(1).max(2000),
    routes: z
      .array(
        z.object({
          target: z.string().min(1).max(100),
          description: z.string().trim().min(1).max(1000),
        })
      )
      .min(2)
      .max(50),
    minConfidence: z.number().min(0).max(1).default(0.6),
    fallbackTarget: z.string().max(100).optional(),
  })
  .superRefine((action, ctx) => {
    if (new Set(action.routes.map(route => route.target)).size !== action.routes.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['routes'],
        message: 'Decision destinations must be unique',
      });
    }
  });

export type DecisionAction = z.infer<typeof decisionActionSchema>;
