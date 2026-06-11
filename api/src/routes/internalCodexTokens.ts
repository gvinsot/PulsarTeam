import express from "express";
import { storeOAuthToken, fetchOAuthTokenWithDbFallback, deleteOAuthToken } from "../services/database/oauthTokens.js";
import { getPool } from "../services/database/connection.js";
import { tryDecrypt } from "../lib/crypto.js";
const router = express.Router();
const PROVIDER = "codex";
const SCOPE_TYPE = "user";
router.get("/:ownerId", async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: "ownerId required" });
  const record = await fetchOAuthTokenWithDbFallback(PROVIDER, SCOPE_TYPE, ownerId);
  if (!record) return res.status(404).json({ error: "Token not found" });
  res.json({ accessToken: record.accessToken, expiresAt: record.expiresAt || null, meta: record.meta || {} });
});
router.post("/:ownerId", async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: "ownerId required" });
  const { accessToken, expiresAt, meta } = req.body || {};
  if (!accessToken || typeof accessToken !== "string") return res.status(400).json({ error: "accessToken required" });
  await storeOAuthToken({ provider: PROVIDER, scopeType: SCOPE_TYPE, scopeId: ownerId, accessToken, expiresAt: typeof expiresAt === "number" ? expiresAt : null, meta: meta && typeof meta === "object" ? meta : undefined });
  // storeOAuthToken swallows DB write errors (the in-memory cache always holds
  // the new token). Read back to verify durable persistence so the runner can
  // retry; no pool means a deliberately DB-less deployment: memory IS the store.
  const pool = getPool();
  if (pool) {
    let persisted = false;
    try {
      const result = await pool.query(
        "SELECT access_token FROM oauth_tokens WHERE provider = $1 AND scope_type = $2 AND scope_id = $3",
        [PROVIDER, SCOPE_TYPE, ownerId]
      );
      persisted = result.rows.length > 0 && tryDecrypt(result.rows[0].access_token) === accessToken;
    } catch {
      persisted = false;
    }
    if (!persisted) {
      return res.status(500).json({ error: "failed to persist token" });
    }
  }
  res.json({ ok: true });
});
router.delete("/:ownerId", async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: "ownerId required" });
  await deleteOAuthToken(PROVIDER, SCOPE_TYPE, ownerId);
  res.json({ ok: true });
});
export const internalCodexTokenRoutes = () => router;
