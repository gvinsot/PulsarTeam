import express from "express";
import { storeOAuthToken, fetchOAuthTokenWithDbFallback, deleteOAuthToken } from "../services/database/oauthTokens.js";
const router = express.Router();
const PROVIDER = "codex";
const SCOPE_TYPE = "user";
function ownerIdFor(req: any, paramOwnerId: string): string | null {
  if (req.user?.role === "admin") return paramOwnerId;
  if (!req.user?.userId) return null;
  return paramOwnerId === req.user.userId ? paramOwnerId : null;
}
router.get("/:ownerId/status", async (req, res) => {
  const ownerId = ownerIdFor(req, req.params.ownerId);
  if (!ownerId) return res.status(403).json({ error: "Forbidden" });
  const record = await fetchOAuthTokenWithDbFallback(PROVIDER, SCOPE_TYPE, ownerId);
  if (!record) return res.json({ authenticated: false, ownerId });
  let plan = "unknown"; let updatedAt: number | null = null;
  try {
    const parsed = JSON.parse(record.accessToken || "{}");
    if (parsed?.tokens?.access_token || parsed?.tokens?.id_token) plan = "chatgpt-oauth";
    else if (parsed?.OPENAI_API_KEY) plan = "api-key";
    if (typeof parsed?.last_refresh === "string") { const t = Date.parse(parsed.last_refresh); if (!Number.isNaN(t)) updatedAt = t; }
  } catch { plan = "opaque"; }
  res.json({ authenticated: true, ownerId, plan, expiresAt: record.expiresAt || null, updatedAt });
});
router.post("/:ownerId", async (req, res) => {
  const ownerId = ownerIdFor(req, req.params.ownerId);
  if (!ownerId) return res.status(403).json({ error: "Forbidden" });
  const { authJson } = req.body || {};
  if (!authJson || typeof authJson !== "object") return res.status(400).json({ error: "authJson required" });
  const hasTokens = !!(authJson?.tokens?.access_token || authJson?.tokens?.id_token);
  const hasApiKey = typeof authJson?.OPENAI_API_KEY === "string" && authJson.OPENAI_API_KEY.length > 0;
  if (!hasTokens && !hasApiKey) return res.status(400).json({ error: "Invalid auth.json" });
  try {
    await storeOAuthToken({ provider: PROVIDER, scopeType: SCOPE_TYPE, scopeId: ownerId, accessToken: JSON.stringify(authJson), expiresAt: null }, { throwOnPersistError: true });
  } catch {
    return res.status(500).json({ error: "failed to persist token" });
  }
  res.json({ ok: true });
});
router.delete("/:ownerId", async (req, res) => {
  const ownerId = ownerIdFor(req, req.params.ownerId);
  if (!ownerId) return res.status(403).json({ error: "Forbidden" });
  await deleteOAuthToken(PROVIDER, SCOPE_TYPE, ownerId);
  res.json({ ok: true });
});
export const codexAuthRoutes = () => router;
