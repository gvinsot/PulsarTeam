import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import {
  getUserByUsername, getUserById, createUser, countUsers,
  getUserByGoogleId, createGoogleUser, linkGoogleId,
  getUserByMicrosoftId, createMicrosoftUser, linkMicrosoftId,
  getUserByGitHubId, createGitHubUser, linkGitHubId,
  getBoardById, getBoardShare, getProjectById,
} from '../services/database.js';
import { provisionNewUser } from '../services/userProvisioning.js';
import { readSecret } from '../secrets.js';
import { validateBody, validateParams, validateQuery } from '../lib/validate.js';
import {
  loginSchema,
  oauthCallbackSchema,
  oauthUrlQuerySchema,
  impersonateParamsSchema,
} from '../schemas/auth.js';

const router = express.Router();

// Helper to get JWT secret at runtime — read from /run/secrets/JWT_SECRET (or env fallback in dev)
const getJwtSecret = () => {
  const secret = readSecret('JWT_SECRET');
  if (!secret) {
    throw new Error('JWT_SECRET is not set (expected at /run/secrets/JWT_SECRET or as env var in dev)');
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
    let adminPassword = readSecret('ADMIN_PASSWORD');
    let generated = false;

    if (!adminPassword) {
      if (process.env.NODE_ENV === 'production') {
        console.error('');
        console.error('================================================================');
        console.error('  FATAL: ADMIN_PASSWORD is not set in production!');
        console.error('  Set ADMIN_PASSWORD as a Docker secret before deploying.');
        console.error('================================================================');
        console.error('');
        process.exit(1);
      }
      // Dev: generate a random one-shot password and print it ONCE so the
      // contributor can log in. No hardcoded fallback — operators that forget
      // to set ADMIN_PASSWORD on deploy still get a unique, unguessable value.
      adminPassword = randomBytes(18).toString('base64url');
      generated = true;
    }

    // bcrypt cost 12 — meaningfully stronger than the default 10, still fast
    // enough on modern hardware (~250ms) for a single seeding call.
    const hash = await bcrypt.hash(adminPassword, 12);
    await createUser(adminUsername, hash, 'admin', 'Admin');

    if (generated) {
      console.warn('');
      console.warn('================================================================');
      console.warn('  ADMIN_PASSWORD was not set — generated a random one-time value');
      console.warn(`  Username: ${adminUsername}`);
      console.warn(`  Password: ${adminPassword}`);
      console.warn('  Save this now — it will NOT be shown again.');
      console.warn('  Set ADMIN_PASSWORD in your env to control this value.');
      console.warn('================================================================');
      console.warn('');
    } else {
      console.log(`Admin user seeded: ${adminUsername}`);
    }
  } catch (err) {
    console.error('Failed to seed admin user:', err.message);
  }
}

// Login
router.post('/login', validateBody(loginSchema), async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkLoginRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }

    const { username, password } = req.body;

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
router.post('/impersonate/:userId', authenticateToken, validateParams(impersonateParamsSchema), async (req, res) => {
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
  return !!(process.env.GOOGLE_CLIENT_ID && readSecret('GOOGLE_CLIENT_SECRET'));
}

// Allow-list of permitted redirect_uri origins. Built from CORS_ORIGINS so the OAuth
// flow only accepts redirect targets that are also valid app frontends. Prevents an
// attacker from supplying ?redirect_uri=https://evil.com to steal authorization codes.
function getAllowedOriginList(): string[] {
  const env = process.env.CORS_ORIGINS;
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  return ['http://localhost:5173', 'http://localhost:3000'];
}

function isAllowedRedirectUri(uri: string): boolean {
  if (!uri) return false;
  try {
    const parsed = new URL(uri);
    const origin = `${parsed.protocol}//${parsed.host}`;
    return getAllowedOriginList().includes(origin);
  } catch {
    return false;
  }
}

function resolveGoogleRedirectUri(frontendUri?: string): string {
  // Trust the env var unconditionally (deployment config). Otherwise require the
  // caller-supplied URI to belong to an allow-listed origin to prevent open redirect.
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  if (frontendUri && isAllowedRedirectUri(frontendUri)) return frontendUri;
  return '';
}

// Returns the Google OAuth consent URL for the frontend to redirect to
router.get('/google/url', validateQuery(oauthUrlQuerySchema), (req, res) => {
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
router.post('/google/callback', validateBody(oauthCallbackSchema), async (req, res) => {
  if (!isGoogleConfigured()) {
    return res.status(501).json({ error: 'Google OAuth not configured' });
  }

  const { code, redirect_uri } = req.body;

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
        client_secret: readSecret('GOOGLE_CLIENT_SECRET'),
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
        const role = userCount === 0 ? 'admin' : 'advanced';
        user = await createGoogleUser(googleId, email, displayName, avatarUrl, role);
        provisionNewUser(user.id).catch(err => console.error('Provisioning error:', err.message));
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
  return !!(process.env.MICROSOFT_CLIENT_ID && readSecret('MICROSOFT_CLIENT_SECRET'));
}

router.get('/microsoft/status', (_req, res) => {
  res.json({ enabled: isMicrosoftConfigured(), clientId: process.env.MICROSOFT_CLIENT_ID || null });
});

function resolveMicrosoftRedirectUri(frontendUri?: string): string {
  if (process.env.MICROSOFT_REDIRECT_URI) return process.env.MICROSOFT_REDIRECT_URI;
  if (frontendUri && isAllowedRedirectUri(frontendUri)) return frontendUri;
  return '';
}

router.get('/microsoft/url', validateQuery(oauthUrlQuerySchema), (req, res) => {
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

router.post('/microsoft/callback', validateBody(oauthCallbackSchema), async (req, res) => {
  if (!isMicrosoftConfigured()) {
    return res.status(501).json({ error: 'Microsoft OAuth not configured' });
  }

  const { code, redirect_uri } = req.body;

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
        client_secret: readSecret('MICROSOFT_CLIENT_SECRET'),
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
        const role = userCount === 0 ? 'admin' : 'advanced';
        user = await createMicrosoftUser(microsoftId, email, displayName, avatarUrl, role);
        provisionNewUser(user.id).catch(err => console.error('Provisioning error:', err.message));
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

// ── GitHub OAuth (login) ──────────────────────────────────────────────────────
// Reuses the same GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET that the
// GitHub MCP plugin already requires. The redirect URI is a frontend route
// (/auth/github/callback) — distinct from the plugin's /api/github/oauth-redirect
// — so a single GitHub OAuth App can serve both flows by registering both
// callback URLs in its settings.

function isGitHubConfigured() {
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && readSecret('GITHUB_OAUTH_CLIENT_SECRET'));
}

router.get('/github/status', (_req, res) => {
  res.json({ enabled: isGitHubConfigured(), clientId: process.env.GITHUB_OAUTH_CLIENT_ID || null });
});

function resolveGitHubRedirectUri(frontendUri?: string): string {
  // No env-var override here — the plugin's GITHUB_OAUTH_REDIRECT_URI points to
  // a different (backend) callback, so we always trust the frontend-supplied
  // URI as long as its origin is on the allow-list.
  if (frontendUri && isAllowedRedirectUri(frontendUri)) return frontendUri;
  return '';
}

router.get('/github/url', validateQuery(oauthUrlQuerySchema), (req, res) => {
  if (!isGitHubConfigured()) {
    return res.status(501).json({ error: 'GitHub OAuth not configured' });
  }

  const redirectUri = resolveGitHubRedirectUri(req.query.redirect_uri as string);
  if (!redirectUri) {
    return res.status(400).json({ error: 'redirect_uri query parameter required' });
  }

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID as string,
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    allow_signup: 'true',
  });

  res.json({ url: `https://github.com/login/oauth/authorize?${params}`, redirect_uri: redirectUri });
});

router.post('/github/callback', validateBody(oauthCallbackSchema), async (req, res) => {
  if (!isGitHubConfigured()) {
    return res.status(501).json({ error: 'GitHub OAuth not configured' });
  }

  const { code, redirect_uri } = req.body;

  const canonicalRedirectUri = resolveGitHubRedirectUri(redirect_uri);
  if (!canonicalRedirectUri) {
    return res.status(400).json({ error: 'redirect_uri required' });
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: readSecret('GITHUB_OAUTH_CLIENT_SECRET'),
        code,
        redirect_uri: canonicalRedirectUri,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
      console.error('GitHub token exchange failed:', tokenData);
      return res.status(401).json({ error: 'GitHub authentication failed' });
    }

    const accessToken = tokenData.access_token;
    const ghHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'PulsarTeam',
    };

    const userInfoRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
    const profile = await userInfoRes.json();
    if (!userInfoRes.ok || !profile.id) {
      console.error('GitHub userinfo failed:', profile);
      return res.status(401).json({ error: 'Failed to fetch GitHub profile' });
    }

    // GitHub may not expose the user's email on the profile (private setting).
    // Fall back to /user/emails to find the primary verified address.
    let email: string | null = profile.email || null;
    if (!email) {
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
        if (emailsRes.ok) {
          const emails = await emailsRes.json();
          if (Array.isArray(emails)) {
            const primary = emails.find((e: any) => e.primary && e.verified) || emails.find((e: any) => e.verified);
            if (primary?.email) email = primary.email;
          }
        }
      } catch (err: any) {
        console.warn('GitHub /user/emails fetch failed:', err.message);
      }
    }

    // Last resort: use the github username as the local username so the
    // account can still be created if the user has no verified email.
    const username = email || (profile.login ? `${profile.login}@users.noreply.github.com` : null);
    if (!username) {
      return res.status(401).json({ error: 'Could not determine a username for this GitHub account' });
    }

    const githubId = String(profile.id);
    const displayName = profile.name || profile.login || username;
    const avatarUrl = profile.avatar_url || null;

    let user = await getUserByGitHubId(githubId);

    if (!user) {
      // Link to an existing local user with the same email/username if any.
      const existingUser = await getUserByUsername(username);
      if (existingUser) {
        await linkGitHubId(existingUser.id, githubId, avatarUrl);
        user = await getUserById(existingUser.id);
      } else {
        const userCount = await countUsers();
        const role = userCount === 0 ? 'admin' : 'advanced';
        user = await createGitHubUser(githubId, username, displayName, avatarUrl, role);
        provisionNewUser(user.id).catch(err => console.error('Provisioning error:', err.message));
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
    console.error('GitHub OAuth error:', err.message);
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

// ── Resource authorization (IDOR protection) ─────────────────────────────────
//
// Centralized helpers used by routes/{boards,projects,tasks,agents}.ts to
// verify that the authenticated user is allowed to read/edit/admin a board
// or a project. Without these checks an attacker who knows another tenant's
// resource id could read or modify it (Insecure Direct Object Reference).

export type Permission = 'read' | 'edit' | 'admin';
const PERMISSION_LEVELS: Record<Permission, number> = { read: 0, edit: 1, admin: 2 };

export interface BoardAccessResult {
  ok: boolean;
  board?: any;
  permission?: Permission;
  isOwner?: boolean;
  status?: number;
  error?: string;
}

/**
 * Resolve effective access level a user has on a board.
 * - Default boards: readable by all authenticated users, admin-writable.
 * - Board owner: full admin access.
 * - System admin: full admin access.
 * - Otherwise: must have a board_share row with sufficient permission.
 */
export async function checkBoardAccess(
  boardId: string | undefined | null,
  userId: string,
  userRole: string,
  required: Permission = 'read'
): Promise<BoardAccessResult> {
  if (!boardId) return { ok: false, status: 400, error: 'boardId required' };
  const board = await getBoardById(boardId);
  if (!board) return { ok: false, status: 404, error: 'Board not found' };

  if (board.is_default) {
    const perm: Permission = userRole === 'admin' ? 'admin' : 'read';
    if (PERMISSION_LEVELS[perm] < PERMISSION_LEVELS[required]) {
      return { ok: false, status: 403, error: `Requires ${required} permission` };
    }
    return { ok: true, board, permission: perm, isOwner: false };
  }

  if (board.user_id === userId) {
    return { ok: true, board, permission: 'admin', isOwner: true };
  }

  if (userRole === 'admin') {
    return { ok: true, board, permission: 'admin', isOwner: false };
  }

  const share = await getBoardShare(boardId, userId);
  if (!share) return { ok: false, status: 403, error: 'Access denied' };

  const sharePerm = share.permission as Permission;
  if ((PERMISSION_LEVELS[sharePerm] ?? -1) < PERMISSION_LEVELS[required]) {
    return { ok: false, status: 403, error: `Requires ${required} permission` };
  }
  return { ok: true, board, permission: sharePerm, isOwner: false };
}

/**
 * Express middleware factory enforcing board access.
 * Reads the board id from req.params[paramName] (default 'id') with fallback
 * to req.query[paramName]. On success, attaches { board, permission, isOwner }
 * to req.boardAccess so the handler can reuse the loaded board without a
 * second DB round-trip.
 */
export function authorizeBoardAccess(
  required: Permission = 'read',
  paramName: string = 'id'
) {
  return async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const boardId = (req.params?.[paramName] || req.query?.[paramName]) as string;
    try {
      const access = await checkBoardAccess(boardId, req.user.userId, req.user.role, required);
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      req.boardAccess = { board: access.board, permission: access.permission, isOwner: access.isOwner };
      next();
    } catch (err: any) {
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

export interface ProjectAccessResult {
  ok: boolean;
  project?: any;
  isOwner?: boolean;
  status?: number;
  error?: string;
}

/**
 * Resolve effective access on a project.
 * - Read: any authenticated user (projects are global metadata).
 * - Edit/admin: admin role OR project owner only.
 */
export async function checkProjectAccess(
  projectId: string | undefined | null,
  userId: string,
  userRole: string,
  required: Permission = 'read'
): Promise<ProjectAccessResult> {
  if (!projectId) return { ok: false, status: 400, error: 'projectId required' };
  const project = await getProjectById(projectId);
  if (!project) return { ok: false, status: 404, error: 'Project not found' };

  const isOwner = !!project.owner_id && project.owner_id === userId;

  if (userRole === 'admin') {
    return { ok: true, project, isOwner };
  }
  if (required === 'read') {
    return { ok: true, project, isOwner };
  }
  if (!isOwner) {
    return { ok: false, status: 403, error: 'You can only modify projects you created' };
  }
  return { ok: true, project, isOwner: true };
}

export function authorizeProjectAccess(
  required: Permission = 'read',
  paramName: string = 'id'
) {
  return async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const projectId = (req.params?.[paramName] || req.query?.[paramName]) as string;
    try {
      const access = await checkProjectAccess(projectId, req.user.userId, req.user.role, required);
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      req.projectAccess = { project: access.project, isOwner: access.isOwner };
      next();
    } catch (err: any) {
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

export { router as authRouter, getJwtSecret };
