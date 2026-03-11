import express from 'express';

/**
 * OneDrive OAuth2 routes.
 *
 * Flow:
 * 1. Client calls GET /api/onedrive/auth-url → receives the Microsoft login URL
 * 2. User logs in on Microsoft, gets redirected to the configured redirect URI
 * 3. Client captures the auth code and POST /api/onedrive/callback with { code }
 * 4. Server exchanges the code for access + refresh tokens via Microsoft identity platform
 * 5. Tokens are stored in-memory (per-user) and used by the OneDrive MCP proxy
 *
 * Environment variables:
 *   ONEDRIVE_CLIENT_ID     — Azure App Registration client ID
 *   ONEDRIVE_CLIENT_SECRET — Azure App Registration client secret
 *   ONEDRIVE_REDIRECT_URI  — Must match the redirect URI configured in Azure
 *   ONEDRIVE_TENANT_ID     — (optional) defaults to "common" for multi-tenant
 */

// In-memory token store: username → { accessToken, refreshToken, expiresAt }
const tokenStore = new Map();

function getConfig() {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;
  const redirectUri = process.env.ONEDRIVE_REDIRECT_URI;
  const tenantId = process.env.ONEDRIVE_TENANT_ID || 'common';

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return { clientId, clientSecret, redirectUri, tenantId };
}

export function getTokenStore() {
  return tokenStore;
}

export function onedriveRoutes() {
  const router = express.Router();

  // Check if OneDrive is configured
  router.get('/status', (req, res) => {
    const config = getConfig();
    const username = req.user?.username;
    const tokens = username ? tokenStore.get(username) : null;
    const connected = tokens && tokens.expiresAt > Date.now();

    res.json({
      configured: !!config,
      connected,
      username: connected ? username : null,
    });
  });

  // Get the Microsoft OAuth authorization URL
  router.get('/auth-url', (req, res) => {
    const config = getConfig();
    if (!config) {
      return res.status(500).json({
        error: 'OneDrive not configured. Set ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET, and ONEDRIVE_REDIRECT_URI.',
      });
    }

    const scopes = [
      'Files.Read',
      'Files.Read.All',
      'Files.ReadWrite',
      'Files.ReadWrite.All',
      'Sites.Read.All',
      'User.Read',
      'offline_access',
    ];

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      scope: scopes.join(' '),
      response_mode: 'query',
      state: req.user?.username || 'unknown',
    });

    const authUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params}`;
    res.json({ authUrl });
  });

  // Exchange authorization code for tokens
  router.post('/callback', async (req, res) => {
    const config = getConfig();
    if (!config) {
      return res.status(500).json({ error: 'OneDrive not configured' });
    }

    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    try {
      const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      });

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('[OneDrive] Token exchange failed:', data);
        return res.status(400).json({
          error: data.error_description || data.error || 'Token exchange failed',
        });
      }

      const username = req.user?.username || 'default';
      tokenStore.set(username, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000, // subtract 60s buffer
      });

      console.log(`✅ [OneDrive] OAuth tokens stored for user "${username}"`);
      res.json({ success: true, expiresIn: data.expires_in });
    } catch (err) {
      console.error('[OneDrive] Token exchange error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Disconnect (clear tokens)
  router.post('/disconnect', (req, res) => {
    const username = req.user?.username || 'default';
    tokenStore.delete(username);
    console.log(`🔌 [OneDrive] Disconnected user "${username}"`);
    res.json({ success: true });
  });

  return router;
}

/**
 * Refresh the access token using the stored refresh token.
 * Called automatically by the MCP proxy when the access token expires.
 */
export async function refreshAccessToken(username) {
  const config = getConfig();
  if (!config) throw new Error('OneDrive not configured');

  const tokens = tokenStore.get(username);
  if (!tokens?.refreshToken) throw new Error('No refresh token available');

  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[OneDrive] Token refresh failed:', data);
    tokenStore.delete(username);
    throw new Error(data.error_description || 'Token refresh failed');
  }

  tokenStore.set(username, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  });

  console.log(`🔄 [OneDrive] Token refreshed for user "${username}"`);
  return data.access_token;
}

/**
 * Get a valid access token for the user, refreshing if needed.
 */
export async function getAccessToken(username = 'default') {
  const tokens = tokenStore.get(username);
  if (!tokens) throw new Error('Not connected to OneDrive. Please authenticate first.');

  if (Date.now() >= tokens.expiresAt) {
    return refreshAccessToken(username);
  }

  return tokens.accessToken;
}
