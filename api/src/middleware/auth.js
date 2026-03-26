import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getUserByUsername, getUserById, createUser, countUsers } from '../services/database.js';

const router = express.Router();

// Helper to get JWT secret at runtime
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
};

// Rate limiting for login — max 5 attempts per IP per 15 minutes
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Periodically clean up expired rate limit entries to prevent memory leaks
const loginAttemptsCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, LOGIN_WINDOW_MS);
loginAttemptsCleanupInterval.unref?.();

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

/**
 * Seed default admin user from env vars if no users exist in the database.
 * Called once at startup.
 */
export async function ensureAdminSeeded() {
  try {
    const count = await countUsers();
    if (count > 0) return; // users already exist

    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'swarm2026';

    if (!process.env.ADMIN_PASSWORD) {
      if (process.env.NODE_ENV === 'production') {
        console.error('');
        console.error('================================================================');
        console.error('  FATAL: ADMIN_PASSWORD is not set in production!');
        console.error('  Set ADMIN_PASSWORD env var before deploying.');
        console.error('================================================================');
        console.error('');
        process.exit(1);
      }
      console.warn('');
      console.warn('================================================================');
      console.warn('  WARNING: ADMIN_PASSWORD is not set!');
      console.warn('  Using default credentials (admin / swarm2026).');
      console.warn('  This is insecure. Set ADMIN_PASSWORD env var before deploying.');
      console.warn('================================================================');
      console.warn('');
    }

    const hash = await bcrypt.hash(adminPassword, 10);
    await createUser(adminUsername, hash, 'admin', 'Admin');
    console.log(`Admin user seeded: ${adminUsername}`);
  } catch (err) {
    console.error('Failed to seed admin user:', err.message);
  }
}

// Login
router.post('/login', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkLoginRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    res.json({ token, username: user.username, role: user.role, userId: user.id, displayName: user.display_name });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token
router.get('/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    // Fetch fresh user data from DB to catch role changes
    const user = await getUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const responseUser = {
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
    };

    // If this token was issued via impersonation, include that info
    if (decoded.impersonatedBy) {
      responseUser.impersonatedBy = decoded.impersonatedBy;
    }

    res.json({ valid: true, user: responseUser });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Impersonate user (admin only) — authenticateToken applied inline
router.post('/impersonate/:userId', authenticateToken, async (req, res) => {
  try {
    const adminUser = req.user;
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const targetUser = await getUserById(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const token = jwt.sign(
      {
        userId: targetUser.id,
        username: targetUser.username,
        role: targetUser.role,
        impersonatedBy: adminUser.username,
      },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    res.json({
      token,
      username: targetUser.username,
      role: targetUser.role,
      userId: targetUser.id,
      displayName: targetUser.display_name,
      impersonatedBy: adminUser.username,
    });
  } catch (err) {
    console.error('Impersonate error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Auth middleware
export function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Access denied' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, getJwtSecret());
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

export { router as authRouter, getJwtSecret };
