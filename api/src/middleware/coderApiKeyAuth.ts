import { readSecret } from '../secrets.js';
import { constantTimeEquals } from '../lib/crypto.js';

export function authenticateCoderApiKey(req, res, next) {
  const headerKey = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;
  const provided = (typeof headerKey === 'string' && headerKey) || bearer;

  if (!provided) {
    return res.status(401).json({ error: 'Missing API key (X-Api-Key or Authorization: Bearer)' });
  }

  const expected = readSecret('CODER_API_KEY');
  if (!expected || !constantTimeEquals(provided, expected)) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}
