import express from 'express';
import { errorMessage } from '../lib/errors.js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import {
  getUserByUsername,
  getUserById,
  createUser,
  countUsers,
  getUserByGoogleId,
  createGoogleUser,
  linkGoogleId,
  getUserByMicrosoftId,
  createMicrosoftUser,
  linkMicrosoftId,
  getUserByGitHubId,
  createGitHubUser,
  linkGitHubId,
  acceptTerms,
  completeTutorial,
  isDatabaseConnected,
} from '../services/database.js';
import { provisionNewUser } from '../services/userProvisioning.js';
import type { UserRow } from '../services/database/users.js';
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
import { authenticateToken, sessionUser } from '../middleware/auth.js';
import {
  clearSessionCookie,
  resolveSessionToken,
  setSessionCookie,
  signSessionToken,
  verifySessionToken,
} from '../middleware/session.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = express.Router();

// Rate limiting for login — max 5 attempts per IP per 15 minutes
const loginAttempts = new Map<string, { count: number; resetAt: number }>(); // ip -> { count, resetAt }
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

function checkLoginRateLimit(ip: string) {
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
  if (env)
    return env
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
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
 * The columns `sendLoginResponse` echoes back. Picked from `UserRow` rather
 * than restated so the two follow the table together, and narrowed to six
 * fields because the OAuth find-or-create path builds its user from provider
 * helpers that each RETURN their own column list.
 */
type LoginResponseUser = Pick<
  UserRow,
  'id' | 'username' | 'role' | 'display_name' | 'terms_accepted_at' | 'tutorial_completed_at'
>;

/**
 * Mint a 24h session for `user`, install it as an HttpOnly cookie and write the
 * standard login response.
 *
 * The JWT itself is deliberately absent from the body: it lives only in the
 * cookie, where page scripts cannot reach it. What the SPA gets instead is
 * `csrfToken`, the per-session secret it must echo in `X-CSRF-Token` on every
 * state-changing request (middleware/csrf.ts). That one is meant to be held in
 * memory and re-fetched from /verify after a reload — never persisted.
 *
 * The OAuth callbacks pass `extra.avatarUrl` (which may be null for Microsoft /
 * GitHub accounts without a photo). The /login route passes nothing, leaving
 * avatarUrl undefined — res.json drops undefined-valued keys, so the password
 * login payload keeps its original shape (no avatarUrl key).
 */
function sendLoginResponse(
  res: express.Response,
  user: LoginResponseUser,
  extra: { avatarUrl?: string | null } = {}
) {
  const { token, csrfToken } = signSessionToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  setSessionCookie(res, token);
  res.json({
    csrfToken,
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
  createUser: (
    id: string,
    loginUsername: string,
    displayName: string,
    avatarUrl: string | null,
    role: string
  ) => Promise<any>;
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
  user = await opts.createUser(
    opts.providerId,
    opts.loginUsername,
    opts.displayName,
    opts.avatarUrl,
    role
  );
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
    console.error('Failed to seed admin user:', errorMessage(err));
  }
}

// Login
router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    try {
      const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
      if (!checkLoginRateLimit(clientIp)) {
        res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
        return;
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
        console.error(
          'Login attempted while database is not connected — check DATABASE_CONNECTION_STRING.'
        );
        res
          .status(503)
          .json({ error: 'Authentication backend unavailable. Please contact the administrator.' });
        return;
      }

      const user = await getUserByUsername(username);
      if (!user || !user.password) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      sendLoginResponse(res, user);
    } catch (err) {
      console.error('Login error:', errorMessage(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Verify the current session.
//
// The SPA calls this on boot for two reasons now: it is the only way to learn
// whether the HttpOnly cookie is still valid (nothing in the page can read it),
// and it re-hands the CSRF token, which is held in memory and therefore lost on
// every reload.
router.get(
  '/verify',
  asyncHandler(async (req, res) => {
    const resolved = resolveSessionToken(req);
    if (!resolved) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const decoded = verifySessionToken(resolved.token);
    if (!decoded) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    try {
      // Fetch fresh user data from DB to catch role changes
      const user = await getUserById(decoded.userId);
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }

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

      res.json({ valid: true, user: responseUser, csrfToken: decoded.csrf });
    } catch (err) {
      res.status(401).json({ error: 'Invalid token' });
    }
  })
);

// Log out. A stateless JWT cannot be revoked server-side, so dropping the
// cookie the page cannot read *is* the logout. csrfProtection waves through a
// request whose session cookie no longer verifies, so an expired session can
// always be cleaned up.
router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Impersonate user (admin only) — authenticateToken applied inline
// The route's params type is passed explicitly (the express typings ask for
// it): without it `P` is inferred from the middleware as the loose
// `ParamsDictionary`, whose values are `string | string[]`.
router.post<{ userId: string }>(
  '/impersonate/:userId',
  authenticateToken,
  validateParams(impersonateParamsSchema),
  asyncHandler(async (req, res) => {
    try {
      const adminUser = req.user;
      if (!adminUser || adminUser.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
      }

      const targetUser = await getUserById(req.params.userId);
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const { token, csrfToken } = signSessionToken({
        userId: targetUser.id,
        username: targetUser.username,
        role: targetUser.role,
        impersonatedBy: adminUser.username,
        // Carries the way back: /stop-impersonation mints the admin's own
        // session from this instead of the frontend stashing their old token.
        impersonatorId: adminUser.userId,
      });
      setSessionCookie(res, token);

      res.json({
        csrfToken,
        username: targetUser.username,
        role: targetUser.role,
        userId: targetUser.id,
        displayName: targetUser.display_name,
        impersonatedBy: adminUser.username,
      });
    } catch (err) {
      console.error('Impersonate error:', errorMessage(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * End an impersonation and hand the admin their own session back.
 *
 * While the token lived in localStorage the frontend simply kept the admin's
 * original JWT next to the impersonated one and swapped them back. It cannot do
 * that any more — nothing in the page can read a cookie — so the way back rides
 * inside the impersonation token (`impersonatorId`) and the real session is
 * minted here, server-side.
 */
router.post(
  '/stop-impersonation',
  authenticateToken,
  asyncHandler(async (req, res) => {
    try {
      const current = req.user;
      if (!current?.impersonatorId) {
        res.status(400).json({ error: 'Not impersonating' });
        return;
      }

      const admin = await getUserById(current.impersonatorId);
      // Refuse to restore a session that is no longer entitled to one: the
      // impersonator may have been demoted or deleted mid-impersonation.
      if (!admin || admin.role !== 'admin') {
        clearSessionCookie(res);
        res.status(403).json({ error: 'Original account is no longer an administrator' });
        return;
      }

      sendLoginResponse(res, admin);
    } catch (err) {
      console.error('Stop impersonation error:', errorMessage(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// ── Table-driven OAuth login providers ────────────────────────────────────────
// Google, Microsoft and GitHub previously carried three structurally identical
// /url + /status + /callback flows. They now share the handleUrl/handleStatus/
// handleCallback handlers below and only declare what actually differs via a
// LoginProviderSpec — mirroring the plugin-side oauthProviderRoutes.ts pattern.

/** Shape returned by every provider's fetchProfile — the local-user identity. */
interface LoginProfile {
  providerId: string;
  loginUsername: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * A wire-level failure inside a callback (bad token exchange, unfetchable
 * profile, …). Carries the exact HTTP status + message each provider used to
 * return inline, so the shared handleCallback preserves every wire response.
 */
class LoginError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'LoginError';
  }
}

/**
 * Everything that differs between the three login providers. Everything else —
 * the not-configured guard, redirect_uri validation, find-or-create, JWT
 * issuance — lives in the shared handlers.
 */
interface LoginProviderSpec<TConfig = any> {
  /** Route mount key: /:provider/status|url|callback. */
  provider: string;
  /** Human label used in "<label> OAuth not configured" errors and log lines. */
  label: string;
  /** Provider OAuth config, or null when not configured. */
  getConfig(): TConfig | null;
  /** clientId reported by GET /status (may be non-null even when not configured — GitHub). */
  statusClientId(): string | null;
  /** Builds the provider consent URL for GET /url (scopes/endpoint/extras live here). */
  buildAuthUrl(config: TConfig, redirectUri: string): string;
  /** Exchanges the authorization code for an access token. Throws LoginError on failure. */
  exchangeToken(code: string, redirectUri: string, config: TConfig): Promise<string>;
  /** Fetches the provider profile and maps it to a LoginProfile. Throws LoginError on failure. */
  fetchProfile(accessToken: string): Promise<LoginProfile>;
  // DB hooks — the provider-specific columns findOrCreateOAuthUser touches.
  getByProviderId(id: string): Promise<any>;
  linkProviderId(userId: string, id: string, avatarUrl: string | null): Promise<any>;
  createUser(
    id: string,
    loginUsername: string,
    displayName: string,
    avatarUrl: string | null,
    role: string
  ): Promise<any>;
}

// ── Google ────────────────────────────────────────────────────────────────────
// Shares getGoogleOAuthConfig() with the Gmail and Drive plugins — one
// GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI pair lights up login + both plugins.
const googleSpec: LoginProviderSpec = {
  provider: 'google',
  label: 'Google',
  getConfig: () => getGoogleOAuthConfig(),
  statusClientId: () => getGoogleOAuthConfig()?.clientId || null,
  buildAuthUrl(cfg, redirectUri) {
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },
  async exchangeToken(code, redirectUri, cfg) {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Google token exchange failed:', tokenData);
      throw new LoginError(401, 'Google authentication failed');
    }
    return tokenData.access_token;
  },
  async fetchProfile(accessToken) {
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = await userInfoRes.json();
    if (!userInfoRes.ok || !profile.id) {
      console.error('Google userinfo failed:', profile);
      throw new LoginError(401, 'Failed to fetch Google profile');
    }
    return {
      providerId: profile.id,
      loginUsername: profile.email,
      displayName: profile.name || profile.email,
      avatarUrl: profile.picture || null,
    };
  },
  getByProviderId: getUserByGoogleId,
  linkProviderId: linkGoogleId,
  createUser: createGoogleUser,
};

// ── Microsoft / Live.com ────────────────────────────────────────────────────
// Shares getMicrosoftOAuthConfig() with the OneDrive and Outlook plugins — one
// MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI/TENANT_ID set lights up login + both
// plugins. For login we only need OIDC scopes — Graph scopes (Files.*, Mail.*)
// live on the per-plugin OAuth tokens, not on the login JWT.
const microsoftSpec: LoginProviderSpec = {
  provider: 'microsoft',
  label: 'Microsoft',
  getConfig: () => getMicrosoftOAuthConfig(),
  statusClientId: () => getMicrosoftOAuthConfig()?.clientId || null,
  buildAuthUrl(cfg, redirectUri) {
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile User.Read',
      response_mode: 'query',
      prompt: 'select_account',
    });
    return `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize?${params}`;
  },
  async exchangeToken(code, redirectUri, cfg) {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: 'openid email profile User.Read',
        }),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Microsoft token exchange failed:', tokenData);
      throw new LoginError(401, 'Microsoft authentication failed');
    }
    return tokenData.access_token;
  },
  async fetchProfile(accessToken) {
    const userInfoRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = await userInfoRes.json();
    if (!userInfoRes.ok || !profile.id) {
      console.error('Microsoft userinfo failed:', profile);
      throw new LoginError(401, 'Failed to fetch Microsoft profile');
    }

    let avatarUrl: string | null = null;
    try {
      const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (photoRes.ok) {
        const buf = await photoRes.arrayBuffer();
        const base64 = Buffer.from(buf).toString('base64');
        const contentType = photoRes.headers.get('content-type') || 'image/jpeg';
        avatarUrl = `data:${contentType};base64,${base64}`;
      }
    } catch {}

    const email = profile.mail || profile.userPrincipalName;
    return {
      providerId: profile.id,
      loginUsername: email,
      displayName: profile.displayName || email,
      avatarUrl,
    };
  },
  getByProviderId: getUserByMicrosoftId,
  linkProviderId: linkMicrosoftId,
  createUser: createMicrosoftUser,
};

// ── GitHub ──────────────────────────────────────────────────────────────────
// Reuses the same GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET that the
// GitHub MCP plugin already requires. The redirect URI is a frontend route
// (/auth/github/callback) — distinct from the plugin's /api/github/oauth-redirect
// — so a single GitHub OAuth App can serve both flows by registering both
// callback URLs in its settings. GitHub login is temporarily disabled; flip
// GITHUB_LOGIN_ENABLED=true to re-enable.
function isGitHubLoginEnabled() {
  return process.env.GITHUB_LOGIN_ENABLED === 'true';
}

function isGitHubConfigured() {
  if (!isGitHubLoginEnabled()) return false;
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && readSecret('GITHUB_OAUTH_CLIENT_SECRET'));
}

const githubSpec: LoginProviderSpec = {
  provider: 'github',
  label: 'GitHub',
  getConfig: () => {
    if (!isGitHubConfigured()) return null;
    return {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID as string,
      clientSecret: readSecret('GITHUB_OAUTH_CLIENT_SECRET') as string,
    };
  },
  // /status reports the configured client id even when login is disabled.
  statusClientId: () => process.env.GITHUB_OAUTH_CLIENT_ID || null,
  buildAuthUrl(cfg, redirectUri) {
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      allow_signup: 'true',
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },
  async exchangeToken(code, redirectUri, cfg) {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
      console.error('GitHub token exchange failed:', tokenData);
      throw new LoginError(401, 'GitHub authentication failed');
    }
    return tokenData.access_token;
  },
  async fetchProfile(accessToken) {
    const ghHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'PulsarTeam',
    };

    const userInfoRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
    const profile = await userInfoRes.json();
    if (!userInfoRes.ok || !profile.id) {
      console.error('GitHub userinfo failed:', profile);
      throw new LoginError(401, 'Failed to fetch GitHub profile');
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
            const primary =
              emails.find((e: any) => e.primary && e.verified) ||
              emails.find((e: any) => e.verified);
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
      throw new LoginError(401, 'Could not determine a username for this GitHub account');
    }

    return {
      providerId: String(profile.id),
      // GitHub passes a computed login username (email OR <login>@users.noreply.github.com)
      loginUsername: username,
      displayName: profile.name || profile.login || username,
      avatarUrl: profile.avatar_url || null,
    };
  },
  getByProviderId: getUserByGitHubId,
  linkProviderId: linkGitHubId,
  createUser: createGitHubUser,
};

const LOGIN_PROVIDERS: LoginProviderSpec[] = [googleSpec, microsoftSpec, githubSpec];

// GET /:provider/status — whether the provider is configured, plus its clientId.
function handleStatus(spec: LoginProviderSpec) {
  return (_req: express.Request, res: express.Response) => {
    res.json({ enabled: !!spec.getConfig(), clientId: spec.statusClientId() });
  };
}

// GET /:provider/url — the provider consent URL for the frontend to redirect to.
function handleUrl(spec: LoginProviderSpec) {
  return (req: express.Request, res: express.Response) => {
    const cfg = spec.getConfig();
    if (!cfg) {
      res.status(501).json({ error: `${spec.label} OAuth not configured` });
      return;
    }

    const redirectUri = resolveLoginRedirectUri(req.query.redirect_uri as string);
    if (!redirectUri) {
      res.status(400).json({ error: 'redirect_uri query parameter required' });
      return;
    }

    res.json({ url: spec.buildAuthUrl(cfg, redirectUri), redirect_uri: redirectUri });
  };
}

// POST /:provider/callback — exchange code → profile → find/create user → JWT.
function handleCallback(spec: LoginProviderSpec) {
  return async (req: express.Request, res: express.Response) => {
    const cfg = spec.getConfig();
    if (!cfg) {
      res.status(501).json({ error: `${spec.label} OAuth not configured` });
      return;
    }

    const { code, redirect_uri } = req.body;

    const canonicalRedirectUri = resolveLoginRedirectUri(redirect_uri);
    if (!canonicalRedirectUri) {
      res.status(400).json({ error: 'redirect_uri required' });
      return;
    }

    try {
      const accessToken = await spec.exchangeToken(code, canonicalRedirectUri, cfg);
      const profile = await spec.fetchProfile(accessToken);

      const user = await findOrCreateOAuthUser({
        getByProviderId: spec.getByProviderId,
        linkProviderId: spec.linkProviderId,
        createUser: spec.createUser,
        providerId: profile.providerId,
        loginUsername: profile.loginUsername,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      });

      sendLoginResponse(res, user, { avatarUrl: user.avatar_url || profile.avatarUrl });
    } catch (err) {
      // LoginError carries each provider's exact wire status/message; anything
      // else is an unexpected fault → generic 500 (matching the old per-provider catch).
      if (err instanceof LoginError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error(`${spec.label} OAuth error:`, (err as any).message);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

for (const spec of LOGIN_PROVIDERS) {
  router.get(`/${spec.provider}/status`, handleStatus(spec));
  router.get(`/${spec.provider}/url`, validateQuery(oauthUrlQuerySchema), handleUrl(spec));
  router.post(
    `/${spec.provider}/callback`,
    validateBody(oauthCallbackSchema),
    asyncHandler(handleCallback(spec))
  );
}

// ── Terms & onboarding ─────────────────────────────────────────────────────
// Record terms acceptance for the current user. Required: a valid JWT.
router.post(
  '/accept-terms',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    try {
      const row = await acceptTerms(user.userId);
      if (!row) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ termsAcceptedAt: row.terms_accepted_at });
    } catch (err) {
      console.error('Accept terms error:', errorMessage(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Record tutorial completion for the current user.
router.post(
  '/complete-tutorial',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    try {
      const row = await completeTutorial(user.userId);
      if (!row) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ tutorialCompletedAt: row.tutorial_completed_at });
    } catch (err) {
      console.error('Complete tutorial error:', errorMessage(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  })
);

export { router as authRouter };
