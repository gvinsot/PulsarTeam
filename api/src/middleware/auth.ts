import jwt from 'jsonwebtoken';
import { readSecret } from '../secrets.js';

// Helper to get JWT secret at runtime — read from /run/secrets/JWT_SECRET (or env fallback in dev)
const getJwtSecret = () => {
  const secret = readSecret('JWT_SECRET');
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set (expected at /run/secrets/JWT_SECRET or as env var in dev)'
    );
  }
  return secret;
};

// Auth middleware
export function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Access denied' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Role-based access control middleware
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

export { getJwtSecret };
