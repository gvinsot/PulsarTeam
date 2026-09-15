import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { errorMessage } from '../lib/errors.js';
import { getOpenApiDocument, type ApiDocsManagers } from '../services/apiDocs.js';

/**
 * /api/settings/api-docs — the key-authenticated API, documented.
 *
 *   GET /openapi.json — OpenAPI 3.1, generated from the live schemas and the
 *                       real MCP tool catalogues (services/apiDocs.ts).
 *
 * Behind the session (src/index.ts) like the key dialog that renders it. The
 * document holds no tenant data — only shapes — so every signed-in user gets
 * the same one, whatever keys they hold.
 */
export function apiDocsRoutes(managers: ApiDocsManagers) {
  const router = express.Router();

  router.get(
    '/openapi.json',
    asyncHandler(async (_req, res) => {
      try {
        res.json(await getOpenApiDocument(managers));
      } catch (err) {
        console.error('Failed to build the API documentation:', errorMessage(err));
        res.status(500).json({ error: 'Failed to build the API documentation' });
      }
    })
  );

  return router;
}
