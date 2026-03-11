import { validateApiKey } from '../services/apiKeyManager.js';

/**
 * Express middleware that authenticates requests via API key (Bearer token).
 * Used for the external Swarm API (REST + MCP).
 */
export async function authenticateApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'API key required. Use Authorization: Bearer <api-key>' });
  }
  const key = authHeader.slice(7);
  const valid = await validateApiKey(key);
  if (!valid) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}
