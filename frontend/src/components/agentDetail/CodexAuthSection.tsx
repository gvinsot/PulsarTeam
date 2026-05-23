import { useState, useEffect } from "react";
import { KeyRound, Upload, X, Check, AlertTriangle, Trash2 } from "lucide-react";
import { api } from "../../api";

interface CodexAuthSectionProps {
  ownerId?: string;
  currentUser?: any;
}

interface CodexAuthStatus {
  authenticated: boolean;
  plan?: "chatgpt-oauth" | "api-key" | "opaque" | "unknown";
  expiresAt?: number | null;
  updatedAt?: number | null;
}

export default function CodexAuthSection({ ownerId, currentUser }: CodexAuthSectionProps) {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const refresh = async () => {
    if (!ownerId) return;
    setLoading(true);
    try {
      const data = await api.getCodexAuthStatus(ownerId);
      setStatus(data);
    } catch {
      setStatus({ authenticated: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ownerId]);

  const handleFile = async (file: File) => {
    setUploadError(null);
    if (!file.name.endsWith(".json")) { setUploadError("Expected a .json file"); return; }
    if (file.size > 256 * 1024) { setUploadError("File too large (>256 KB)"); return; }
    setUploading(true);
    try {
      const text = await file.text();
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { setUploadError("Not valid JSON"); setUploading(false); return; }
      await api.uploadCodexAuth(ownerId, parsed);
      setShowModal(false);
      await refresh();
    } catch (err: any) {
      setUploadError(err?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!ownerId) return;
    if (!confirm("Forget the stored Codex auth.json? Agents will fall back to OPENAI_API_KEY.")) return;
    try { await api.deleteCodexAuth(ownerId); await refresh(); } catch (err) { console.error(err); }
  };

  if (!ownerId) {
    return (
      <div className="px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50 text-xs text-dark-500">
        Codex auth is per-user. Assign an owner to this agent to manage its ChatGPT-plan login.
      </div>
    );
  }

  const planLabel = status?.authenticated
    ? status.plan === "chatgpt-oauth" ? "ChatGPT plan (OAuth)"
      : status.plan === "api-key" ? "OPENAI_API_KEY (uploaded)"
      : "auth.json present"
    : "No auth uploaded";

  return (
    <>
      <div className="px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <KeyRound className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-sm text-dark-200">Codex authentication</div>
              <div className="text-[11px] text-dark-500 mt-0.5 truncate">
                {loading ? "Checking…" : planLabel}
                {status?.updatedAt ? ` · refreshed ${new Date(status.updatedAt).toLocaleString()}` : ""}
              </div>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => { setUploadError(null); setShowModal(true); }}
              className="px-2.5 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 rounded-md text-xs font-medium flex items-center gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" />
              {status?.authenticated ? "Replace" : "Login ChatGPT"}
            </button>
            {status?.authenticated && (
              <button
                onClick={handleDelete}
                className="px-2 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-md text-xs"
                title="Remove the stored auth.json"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-dark-900 border border-dark-700 rounded-xl max-w-lg w-full p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-400" />
                <h3 className="text-base font-semibold text-dark-100">Login with your ChatGPT plan</h3>
              </div>
              <button onClick={() => setShowModal(false)} className="text-dark-500 hover:text-dark-300">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-sm text-dark-300 space-y-3">
              <p>
                The ChatGPT OAuth flow is not exposed to third-party browsers, so the login
                step happens once on your own machine. The runner only needs the resulting
                <code className="mx-1 px-1.5 py-0.5 bg-dark-800 rounded text-xs text-amber-300">auth.json</code>
                file.
              </p>
              <ol className="list-decimal list-inside text-xs text-dark-300 space-y-1.5 bg-dark-800/50 rounded-lg p-3 border border-dark-700/50">
                <li>Install Codex locally: <code className="text-amber-300">npm i -g @openai/codex</code></li>
                <li>Run <code className="text-amber-300">codex login</code> — a browser opens, sign in with your ChatGPT account.</li>
                <li>Locate the generated file at <code className="text-amber-300">~/.codex/auth.json</code>.</li>
                <li>Upload it below — encrypted at rest and shared with every runner replica.</li>
              </ol>
              <label className="block">
                <span className="block text-xs text-dark-400 mb-1.5">auth.json file</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                  disabled={uploading}
                  className="w-full text-xs text-dark-300 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-emerald-500/10 file:text-emerald-300 file:text-xs hover:file:bg-emerald-500/20"
                />
              </label>
              {uploadError && (
                <div className="flex gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-md text-xs text-red-300">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}
              {uploading && (
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <div className="w-3 h-3 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin" />
                  Uploading…
                </div>
              )}
              {status?.authenticated && !uploading && !uploadError && (
                <div className="flex items-center gap-2 text-xs text-emerald-300">
                  <Check className="w-3.5 h-3.5" /> A token is already stored — uploading replaces it.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
