import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  getUserByUsername, getUserById, createUser, countUsers,
  getUserByGoogleId, createGoogleUser, linkGoogleId,
  getUserByMicrosoftId, createMicrosoftUser, linkMicrosoftId,
} from '../services/database.js';

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
    if (!user || !user.password) {
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
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    // Fetch fresh user data from DB to catch role changes
    const user = await getUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const responseUser: any = {
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

// ── Google OAuth ──────────────────────────────────────────────────────────────

function isGoogleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function resolveGoogleRedirectUri(frontendUri?: string): string {
  return process.env.GOOGLE_REDIRECT_URI || frontendUri || '';
}

// Returns the Google OAuth consent URL for the frontend to redirect to
router.get('/google/url', (req, res) => {
  if (!isGoogleConfigured()) {
    return res.status(501).json({ error: 'Google OAuth not configured' });
  }

  const redirectUri = resolveGoogleRedirectUri(req.query.redirect_uri as string);
  if (!redirectUri) {
    return res.status(400).json({ error: 'redirect_uri query parameter required' });
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID as string,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, redirect_uri: redirectUri });
});

// Returns whether Google OAuth is available
router.get('/google/status', (_req, res) => {
  res.json({ enabled: isGoogleConfigured(), clientId: process.env.GOOGLE_CLIENT_ID || null });
});

// Exchanges the Google authorization code for user info and returns a JWT
router.post('/google/callback', async (req, res) => {
  if (!isGoogleConfigured()) {
    return res.status(501).json({ error: 'Google OAuth not configured' });
  }

  const { code, redirect_uri } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code required' });
  }

  const canonicalRedirectUri = resolveGoogleRedirectUri(redirect_uri);
  if (!canonicalRedirectUri) {
    return res.status(400).json({ error: 'redirect_uri required' });
  }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: canonicalRedirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Google token exchange failed:', tokenData);
      return res.status(401).json({ error: 'Google authentication failed' });
    }

    // Fetch user info from Google
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const profile = await userInfoRes.json();
    if (!userInfoRes.ok || !profile.id) {
      console.error('Google userinfo failed:', profile);
      return res.status(401).json({ error: 'Failed to fetch Google profile' });
    }

    const googleId = profile.id;
    const email = profile.email;
    const displayName = profile.name || email;
    const avatarUrl = profile.picture || null;

    // Find or create user
    let user = await getUserByGoogleId(googleId);

    if (!user) {
      // Check if a user with this email already exists (link accounts)
      const existingUser = await getUserByUsername(email);
      if (existingUser) {
        await linkGoogleId(existingUser.id, googleId, avatarUrl);
        user = await getUserById(existingUser.id);
      } else {
        // Determine role — first user gets admin, others get basic
        const userCount = await countUsers();
        const role = userCount === 0 ? 'admin' : 'basic';
        user = await createGoogleUser(googleId, email, displayName, avatarUrl, role);
      }
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    res.json({
      token,
      username: user.username,
      role: user.role,
      userId: user.id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url || avatarUrl,
    });
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Microsoft / Live.com OAuth ────────────────────────────────────────────────

function isMicrosoftConfigured() {
  return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

router.get('/microsoft/status', (_req, res) => {
  res.json({ enabled: isMicrosoftConfigured(), clientId: process.env.MICROSOFT_CLIENT_ID || null });
});

function resolveMicrosoftRedirectUri(frontendUri?: string): string {
  return process.env.MICROSOFT_REDIRECT_URI || frontendUri || '';
}

router.get('/microsoft/url', (req, res) => {
  if (!isMicrosoftConfigured()) {
    return res.status(501).json({ error: 'Microsoft OAuth not configured' });
  }

  const redirectUri = resolveMicrosoftRedirectUri(req.query.redirect_uri as string);
  if (!redirectUri) {
    return res.status(400).json({ error: 'redirect_uri query parameter required' });
  }

  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID as string,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile User.Read',
    response_mode: 'query',
    prompt: 'select_account',
  });

  res.json({ url: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}`, redirect_uri: redirectUri });
});

router.post('/microsoft/callback', async (req, res) => {
  if (!isMicrosoftConfigured()) {
    return res.status(501).json({ error: 'Microsoft OAuth not configured' });
  }

  const { code, redirect_uri } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code required' });
  }

  const canonicalRedirectUri = resolveMicrosoftRedirectUri(redirect_uri);
  if (!canonicalRedirectUri) {
    return res.status(400).json({ error: 'redirect_uri required' });
  }

  try {
    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID as string,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET as string,
        code,
        redirect_uri: canonicalRedirectUri,
        grant_type: 'authorization_code',
        scope: 'openid email profile User.Read',
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Microsoft token exchange failed:', tokenData);
      return res.status(401).json({ error: 'Microsoft authentication failed' });
    }

    const userInfoRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const profile = await userInfoRes.json();
    if (!userInfoRes.ok || !profile.id) {
      console.error('Microsoft userinfo failed:', profile);
      return res.status(401).json({ error: 'Failed to fetch Microsoft profile' });
    }

    const microsoftId = profile.id;
    const email = profile.mail || profile.userPrincipalName;
    const displayName = profile.displayName || email;

    let avatarUrl = null;
    try {
      const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (photoRes.ok) {
        const buf = await photoRes.arrayBuffer();
        const base64 = Buffer.from(buf).toString('base64');
        const contentType = photoRes.headers.get('content-type') || 'image/jpeg';
        avatarUrl = `data:${contentType};base64,${base64}`;
      }
    } catch {}

    let user = await getUserByMicrosoftId(microsoftId);

    if (!user) {
      const existingUser = await getUserByUsername(email);
      if (existingUser) {
        await linkMicrosoftId(existingUser.id, microsoftId, avatarUrl);
        user = await getUserById(existingUser.id);
      } else {
        const userCount = await countUsers();
        const role = userCount === 0 ? 'admin' : 'basic';
        user = await createMicrosoftUser(microsoftId, email, displayName, avatarUrl, role);
      }
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    res.json({
      token,
      username: user.username,
      role: user.role,
      userId: user.id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url || avatarUrl,
    });
  } catch (err) {
    console.error('Microsoft OAuth error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

export { router as authRouter, getJwtSecret };
