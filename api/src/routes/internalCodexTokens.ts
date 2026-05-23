import express from "express";
import { storeOAuthToken, fetchOAuthTokenWithDbFallback, deleteOAuthToken } from "../services/database/oauthTokens.js";
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
  res.json({ ok: true });
});
router.delete("/:ownerId", async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: "ownerId required" });
  await deleteOAuthToken(PROVIDER, SCOPE_TYPE, ownerId);
  res.json({ ok: true });
});
export const internalCodexTokenRoutes = () => router;
