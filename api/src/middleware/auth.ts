import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import {
  getUserByUsername, getUserById, createUser, countUsers,
  getUserByGoogleId, createGoogleUser, linkGoogleId,
  getUserByMicrosoftId, createMicrosoftUser, linkMicrosoftId,
  getUserByGitHubId, createGitHubUser, linkGitHubId,
  acceptTerms, completeTutorial,
  isDatabaseConnected,
} from '../services/database.js';
import { provisionNewUser } from '../services/userProvisioning.js';
import { readSecret } from '../secrets.js';
import { getMicrosoftOAuthConfig } from '../services/microsoftOAuthConfig.js';
import { getGoogleOAuthConfig } from '../services/googleOAuthConfig.js';
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

// ── Shared login machinery (password + OAuth) ─────────────────────────────────

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

/**
 * Resolve the login redirect URI supplied by the frontend.
 *
 * Each provider's login lands on its own frontend route — /auth/google/callback,
 * /auth/microsoft/callback (App.tsx), /auth/github/callback — which is distinct
 * from the plugin OAuth dispatchers (/api/<provider>/oauth-redirect). The login
 * URI comes from the frontend; we accept it only when its origin is on the CORS
 * allow-list (prevents an open-redirect / code-stealing attack).
 */
function resolveLoginRedirectUri(frontendUri?: string): string {
  if (frontendUri && isAllowedRedirectUri(frontendUri)) return frontendUri;
  return '';
}

/**
 * Sign a 24h login JWT for `user` and write the standard login response.
 *
 * The OAuth callbacks pass `extra.avatarUrl` (which may be null for Microsoft /
 * GitHub accounts without a photo). The /login route passes nothing, leaving
 * avatarUrl undefined — res.json drops undefined-valued keys, so the password
 * login payload keeps its original shape (no avatarUrl key).
 */
function sendLoginResponse(res, user, extra: { avatarUrl?: string | null } = {}) {
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
    avatarUrl: extra.avatarUrl,
    termsAcceptedAt: user.terms_accepted_at || null,
    tutorialCompletedAt: user.tutorial_completed_at || null,
  });
}

/**
 * Find-or-create the local user for an OAuth identity.
 *
 * Ordering (preserved across all three providers):
 *   provider-id lookup → getUserByUsername(loginUsername) → link + refetch by id
 *   → countUsers → role admin (first user) else advanced → createUser
 *   → provisionNewUser(user.id).
 *
 * `loginUsername` is the local username key: the email for Google/Microsoft, but
 * for GitHub a computed value (profile email OR `<login>@users.noreply.github.com`).
 */
async function findOrCreateOAuthUser(opts: {
  getByProviderId: (id: string) => Promise<any>;
  linkProviderId: (userId: string, id: string, avatarUrl: string | null) => Promise<any>;
  createUser: (id: string, loginUsername: string, displayName: string, avatarUrl: string | null, role: string) => Promise<any>;
  providerId: string;
  loginUsername: string;
  displayName: string;
  avatarUrl: string | null;
}): Promise<any> {
  let user = await opts.getByProviderId(opts.providerId);
  if (user) return user;

  // Check if a user with this username/email already exists (link accounts)
  const existingUser = await getUserByUsername(opts.loginUsername);
  if (existingUser) {
    await opts.linkProviderId(existingUser.id, opts.providerId, opts.avatarUrl);
    return getUserById(existingUser.id);
  }

  // Determine role — first user gets admin, others get advanced
  const userCount = await countUsers();
  const role = userCount === 0 ? 'admin' : 'advanced';
  user = await opts.createUser(opts.providerId, opts.loginUsername, opts.displayName, opts.avatarUrl, role);
  await provisionNewUser(user.id).catch(err => console.error('Provisioning error:', err.message));
  return user;
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

    // Distinguish "DB unreachable" from "bad credentials". Without this, a
    // misconfigured DATABASE_CONNECTION_STRING on a replica causes
    // getUserByUsername to silently return null, and every login attempt
    // — including ones with valid credentials
    // that work on other replicas of the same DB — falls through to the
    // "Invalid credentials" branch. Surface the real cause so the operator
    // can fix it.
    if (!isDatabaseConnected()) {
      console.error('Login attempted while database is not connected — check DATABASE_CONNECTION_STRING.');
      return res.status(503).json({ error: 'Authentication backend unavailable. Please contact the administrator.' });
    }

    const user = await getUserByUsername(username);
    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    sendLoginResponse(res, user);
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
      termsAcceptedAt: user.terms_accepted_at || null,
      tutorialCompletedAt: user.tutorial_completed_at || null,
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
// Shares getGoogleOAuthConfig() with the Gmail and Drive plugins — one
// GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI pair lights up login + both plugins.

// Returns the Google OAuth consent URL for the frontend to redirect to
router.get('/google/url', validateQuery(oauthUrlQuerySchema), (req, res) => {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) {
    return res.status(501).json({ error: 'Google OAuth not configured' });
  }

  const redirectUri = resolveLoginRedirectUri(req.query.redirect_uri as string);
  if (!redirectUri) {
    return res.status(400).json({ error: 'redirect_uri query parameter required' });
  }

  const params = new URLSearchParams({
    client_id: cfg.clientId,
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
  const cfg = getGoogleOAuthConfig();
  res.json({ enabled: !!cfg, clientId: cfg?.clientId || null });
});

// Exchanges the Google authorization code for user info and returns a JWT
router.post('/google/callback', validateBody(oauthCallbackSchema), async (req, res) => {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) {
    return res.status(501).json({ error: 'Google OAuth not configured' });
  }

  const { code, redirect_uri } = req.body;

  const canonicalRedirectUri = resolveLoginRedirectUri(redirect_uri);
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
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
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

    const user = await findOrCreateOAuthUser({
      getByProviderId: getUserByGoogleId,
      linkProviderId: linkGoogleId,
      createUser: createGoogleUser,
      providerId: googleId,
      loginUsername: email,
      displayName,
      avatarUrl,
    });

    sendLoginResponse(res, user, { avatarUrl: user.avatar_url || avatarUrl });
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Microsoft / Live.com OAuth ────────────────────────────────────────────────
// Shares getMicrosoftOAuthConfig() with the OneDrive and Outlook plugins —
// one MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI/TENANT_ID set lights up login
// + both plugins.

function getMicrosoftLoginConfig() {
  // For login we only need OIDC scopes — Graph scopes (Files.*, Mail.*) live
  // on the per-plugin OAuth tokens, not on the login JWT.
  return getMicrosoftOAuthConfig();
}

router.get('/microsoft/status', (_req, res) => {
  const cfg = getMicrosoftLoginConfig();
  res.json({ enabled: !!cfg, clientId: cfg?.clientId || null });
});

router.get('/microsoft/url', validateQuery(oauthUrlQuerySchema), (req, res) => {
  const cfg = getMicrosoftLoginConfig();
  if (!cfg) {
    return res.status(501).json({ error: 'Microsoft OAuth not configured' });
  }

  const redirectUri = resolveLoginRedirectUri(req.query.redirect_uri as string);
  if (!redirectUri) {
    return res.status(400).json({ error: 'redirect_uri query parameter required' });
  }

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile User.Read',
    response_mode: 'query',
    prompt: 'select_account',
  });

  res.json({ url: `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize?${params}`, redirect_uri: redirectUri });
});

router.post('/microsoft/callback', validateBody(oauthCallbackSchema), async (req, res) => {
  const cfg = getMicrosoftLoginConfig();
  if (!cfg) {
    return res.status(501).json({ error: 'Microsoft OAuth not configured' });
  }

  const { code, redirect_uri } = req.body;

  const canonicalRedirectUri = resolveLoginRedirectUri(redirect_uri);
  if (!canonicalRedirectUri) {
    return res.status(400).json({ error: 'redirect_uri required' });
  }

  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
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

    const user = await findOrCreateOAuthUser({
      getByProviderId: getUserByMicrosoftId,
      linkProviderId: linkMicrosoftId,
      createUser: createMicrosoftUser,
      providerId: microsoftId,
      loginUsername: email,
      displayName,
      avatarUrl,
    });

    sendLoginResponse(res, user, { avatarUrl: user.avatar_url || avatarUrl });
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

// GitHub login is temporarily disabled. Flip GITHUB_LOGIN_ENABLED=true to re-enable.
function isGitHubLoginEnabled() {
  return process.env.GITHUB_LOGIN_ENABLED === 'true';
}

function isGitHubConfigured() {
  if (!isGitHubLoginEnabled()) return false;
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && readSecret('GITHUB_OAUTH_CLIENT_SECRET'));
}

router.get('/github/status', (_req, res) => {
  res.json({ enabled: isGitHubConfigured(), clientId: process.env.GITHUB_OAUTH_CLIENT_ID || null });
});

router.get('/github/url', validateQuery(oauthUrlQuerySchema), (req, res) => {
  if (!isGitHubConfigured()) {
    return res.status(501).json({ error: 'GitHub OAuth not configured' });
  }

  const redirectUri = resolveLoginRedirectUri(req.query.redirect_uri as string);
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

  const canonicalRedirectUri = resolveLoginRedirectUri(redirect_uri);
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

    const user = await findOrCreateOAuthUser({
      getByProviderId: getUserByGitHubId,
      linkProviderId: linkGitHubId,
      createUser: createGitHubUser,
      providerId: githubId,
      // GitHub passes a computed login username (email OR <login>@users.noreply.github.com)
      loginUsername: username,
      displayName,
      avatarUrl,
    });

    sendLoginResponse(res, user, { avatarUrl: user.avatar_url || avatarUrl });
  } catch (err) {
    console.error('GitHub OAuth error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Terms & onboarding ─────────────────────────────────────────────────────
// Record terms acceptance for the current user. Required: a valid JWT.
router.post('/accept-terms', authenticateToken, async (req, res) => {
  try {
    const row = await acceptTerms(req.user.userId);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({ termsAcceptedAt: row.terms_accepted_at });
  } catch (err) {
    console.error('Accept terms error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Record tutorial completion for the current user.
router.post('/complete-tutorial', authenticateToken, async (req, res) => {
  try {
    const row = await completeTutorial(req.user.userId);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({ tutorialCompletedAt: row.tutorial_completed_at });
  } catch (err) {
    console.error('Complete tutorial error:', err.message);
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
