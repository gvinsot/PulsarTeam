import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { disconnectSocket, getSocket } from './socket';
import { api, setCsrfToken } from './api';
import { useAgentsSocket } from './hooks/useAgentsSocket';
import Dashboard from './components/Dashboard';
import { VoiceSessionProvider } from './contexts/VoiceSessionContext';
import { X, AlertCircle, CheckCircle, Info } from 'lucide-react';
import type {
  AgentTemplate,
  AppUser,
  ImpersonateResponse,
  McpServer,
  Plugin,
  RepoPickerOption,
  SessionPayload,
  SessionUser,
  Toast,
  ToastType,
} from './types';

const LoginPage = lazy(() => import('./components/LoginPage'));
const TermsPage = lazy(() => import('./components/TermsPage'));
const PrivacyPage = lazy(() => import('./components/PrivacyPage'));
const WelcomeTutorialModal = lazy(() => import('./components/WelcomeTutorialModal'));

/**
 * The common denominator of the three payloads toUser is fed: SessionUser (the
 * nested `user` of GET /auth/verify), SessionPayload (password login, the three
 * OAuth callbacks, /auth/stop-impersonation) and ImpersonateResponse.
 *
 * Both timestamps are OPTIONAL here because ImpersonateResponse carries neither
 * — which is exactly why toUser coalesces them to null below. `impersonatedBy`
 * is optional-never-null, as declared on SessionUser.
 */
type AuthPayload = Pick<SessionPayload, 'username' | 'role' | 'userId' | 'displayName'> &
  Partial<Pick<SessionPayload, 'termsAcceptedAt' | 'tutorialCompletedAt'>> &
  Pick<SessionUser, 'impersonatedBy'>;

// Normalizes the user object from any auth payload (verify, OAuth callback,
// password login, impersonation) — the field names are identical across all
// backend responses. Absent fields normalize to null.
const toUser = (d: AuthPayload): AppUser => ({
  username: d.username,
  role: d.role,
  userId: d.userId,
  displayName: d.displayName,
  termsAcceptedAt: d.termsAcceptedAt || null,
  tutorialCompletedAt: d.tutorialCompletedAt || null,
  ...(d.impersonatedBy ? { impersonatedBy: d.impersonatedBy } : {}),
});

// OAuth callback routes → token-exchange endpoints. Adding a login provider
// is a one-line entry here (plus its api wrapper). Keyed by `window.location
// .pathname`, hence the string index signature rather than the three literals.
const OAUTH_CALLBACKS: Record<
  string,
  ((code: string, redirectUri: string) => Promise<SessionPayload>) | undefined
> = {
  '/auth/google/callback': api.googleCallback,
  '/auth/microsoft/callback': api.microsoftCallback,
  '/auth/github/callback': api.githubAuthCallback,
};

export default function App() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [dbUnavailable, setDbUnavailable] = useState(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  // NOT AvailableRepo[]: loadProjects re-maps the endpoint's rows into the
  // client-normalised picker shape before storing them.
  const [projects, setProjects] = useState<RepoPickerOption[]>([]);
  const [skills, setSkills] = useState<Plugin[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [oauthLoading, setOauthLoading] = useState(false);

  const showToast = useCallback((message: string, type: ToastType = 'error', duration = 5000) => {
    const id = Date.now() + Math.random();
    let added = false;
    setToasts(prev => {
      // Dedupe: if a toast with the same message+type is already displayed,
      // do not stack another one on top.
      if (prev.some(t => t.message === message && t.type === type)) {
        return prev;
      }
      added = true;
      return [...prev, { id, message, type }];
    });
    if (added && duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Use a ref to hold showToast so socket handlers always call the latest version
  const showToastRef = useRef(showToast);
  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  // Agents list + thinking/stream-buffer state and the whole agents/stream
  // socket protocol live in the hook; App only triggers initSocket/teardown.
  const { agents, setAgents, thinkingMap, streamBuffers, initSocket, teardown } =
    useAgentsSocket(showToastRef);

  const loadedRef = useRef({ templates: false, projects: false, skills: false, mcpServers: false });

  const loadData = useCallback(async () => {
    try {
      const result = await api.getAgents();
      setAgents(result);
    } catch (err) {
      console.error('Failed to load agents:', err);
    }
  }, []);

  const loadTemplates = useCallback(async (force = false) => {
    if (loadedRef.current.templates && !force) return;
    loadedRef.current.templates = true;
    try {
      setTemplates(await api.getTemplates());
    } catch (err) {
      console.error('Failed to load templates:', err);
      loadedRef.current.templates = false;
    }
  }, []);

  const loadProjects = useCallback(async (force = false) => {
    if (loadedRef.current.projects && !force) return;
    loadedRef.current.projects = true;
    try {
      // The agent / broadcast / add-agent pickers want to choose **a git
      // repository** to clone into the runner container, not a DB-backed
      // "project" entity. We surface every repo exposed by the configured
      // GitHub/GitLab connections and use the canonical `owner/repo`
      // fullName as the option value (stored in `agent.project`). The API
      // resolves both fullName and the legacy short name, so existing
      // agents keep working.
      const repos = await api.getAvailableRepos();
      const normalized: RepoPickerOption[] = (repos || []).map(r => ({
        // Canonical id used by the picker and stored as agent.project.
        // The `|| r.name` half is dead — neither available-repos route emits a
        // `name` key — but it still widens the expression to `string | undefined`,
        // so a final `|| ''` is needed to match RepoPickerOption.name. That
        // fallback is unreachable: saveTask writes `repoFullName || null` and the
        // route selects `WHERE repo_full_name IS NOT NULL`, so `fullName` is never
        // the empty string here.
        name: r.fullName || r.name || '',
        fullName: r.fullName,
        repoName: r.fullName ? r.fullName.split('/').pop() : r.name,
        provider: r.provider,
        description: r.description || '',
        htmlUrl: r.htmlUrl || '',
        defaultBranch: r.defaultBranch || '',
      }));
      // De-duplicate by fullName in case the same repo is exposed by
      // multiple connections.
      const seen = new Set<string>();
      const deduped = normalized.filter(p => {
        if (seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
      });
      setProjects(deduped);
    } catch (err) {
      console.error('Failed to load repos:', err);
      setProjects([]);
      loadedRef.current.projects = false;
    }
  }, []);

  const loadSkills = useCallback(async (force = false) => {
    if (loadedRef.current.skills && !force) return;
    loadedRef.current.skills = true;
    try {
      setSkills(await api.getPlugins());
    } catch (err) {
      console.error('Failed to load skills:', err);
      setSkills([]);
      loadedRef.current.skills = false;
    }
  }, []);

  const loadMcpServers = useCallback(async (force = false) => {
    if (loadedRef.current.mcpServers && !force) return;
    loadedRef.current.mcpServers = true;
    try {
      setMcpServers(await api.getMcpServers());
    } catch (err) {
      console.error('Failed to load MCP servers:', err);
      setMcpServers([]);
      loadedRef.current.mcpServers = false;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    loadedRef.current = { templates: false, projects: false, skills: false, mcpServers: false };
    await loadData();
  }, [loadData]);

  // Auto-refresh agents when the browser tab regains focus
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && user) loadData();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadData, user]);

  useEffect(() => {
    let cancelled = false;
    // The session cookie is HttpOnly, so the page cannot tell whether it holds
    // one — asking the server is the only way, and a logged-out visitor simply
    // gets a 401 here. /verify is also the handover point for the CSRF token,
    // which is kept in memory and therefore does not survive a reload.
    api
      .verify()
      .then(async data => {
        if (cancelled) return;
        setCsrfToken(data.csrfToken);
        // Not completeLogin: this path needs the `cancelled` guard between
        // loadData and initSocket (StrictMode/unmount).
        setUser(toUser(data.user));
        await loadData();
        if (cancelled) return;
        initSocket();
        checkDbHealth();
      })
      .catch(err => {
        if (cancelled) return;
        // A transient backend stall (request timeout/abort) must not be read
        // as a rejected session — only drop the CSRF token when the server
        // actually answered. Either way `user` stays null, so the login
        // screen is what renders.
        if (err?.name !== 'TimeoutError' && err?.name !== 'AbortError') {
          setCsrfToken(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      // Cleanup: remove all socket listeners when effect re-runs
      teardown();
    };
  }, [initSocket, loadData, teardown]);

  const checkDbHealth = useCallback(async () => {
    try {
      const health = await api.getHealth();
      setDbUnavailable(health.database !== 'connected');
    } catch {
      // Backend unreachable — don't show DB warning on top of connectivity issues
    }
  }, []);

  // Shared post-login sequence (OAuth callback + password login).
  // `awaitHealth` reproduces the OAuth path's behavior of resolving only
  // after the DB health probe returns; password login fires it and resolves.
  const completeLogin = async (data: SessionPayload, { awaitHealth = false } = {}) => {
    // The session arrived as an HttpOnly cookie on this very response. All the
    // page keeps is the CSRF token that pairs with it.
    setCsrfToken(data.csrfToken);
    setUser(toUser(data));
    await loadData();
    initSocket();
    const health = checkDbHealth();
    if (awaitHealth) await health;
  };

  // Handle OAuth callback URLs (Google / Microsoft / GitHub)
  useEffect(() => {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const exchange = OAUTH_CALLBACKS[path];
    if (!code || !exchange) return;

    setOauthLoading(true);
    const redirectUri =
      sessionStorage.getItem('oauth_redirect_uri') || `${window.location.origin}${path}`;
    sessionStorage.removeItem('oauth_redirect_uri');
    window.history.replaceState({}, '', '/');

    exchange(code, redirectUri)
      .then(data => completeLogin(data, { awaitHealth: true }))
      .catch(err => {
        console.error('OAuth login failed:', err);
        showToast(err.message || 'Login failed', 'error');
      })
      .finally(() => {
        setOauthLoading(false);
        setLoading(false);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async (username: string, password: string) => {
    const data = await api.login(username, password);
    await completeLogin(data);
  };

  const handleLogout = () => {
    // Only the server can drop an HttpOnly cookie, so logging out is a request.
    // The local session is torn down regardless of how it goes — a failed
    // logout must not strand the user in a UI they can no longer drive.
    api.logout().catch(() => {});
    setCsrfToken(null);
    disconnectSocket();
    setUser(null);
    setAgents([]);
  };

  // socket.ts signals a definitively rejected handshake via window events:
  // an auth rejection means the token is dead, so force a re-login; other
  // rejections (e.g. CORS) are surfaced as a toast for visibility.
  useEffect(() => {
    const onAuthError = () => {
      showToastRef.current('Session expired — please sign in again.', 'error', 8000);
      handleLogout();
    };
    const onConnectError = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      console.error('WebSocket connection rejected:', detail);
      showToastRef.current(
        `Realtime connection failed: ${detail || 'unknown error'}`,
        'error',
        8000
      );
    };
    window.addEventListener('socket:auth-error', onAuthError);
    window.addEventListener('socket:connect-error', onConnectError);
    return () => {
      window.removeEventListener('socket:auth-error', onAuthError);
      window.removeEventListener('socket:connect-error', onConnectError);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImpersonate = (data: ImpersonateResponse) => {
    // The impersonated session replaced the cookie on this response; the admin's
    // own session is recoverable server-side (the token carries their id), so
    // nothing is stashed locally any more. Not completeLogin: impersonation
    // recycles the socket, skips the DB health probe and doesn't await loadData.
    setCsrfToken(data.csrfToken);
    setUser(toUser(data));
    disconnectSocket();
    initSocket();
    loadData();
  };

  const handleStopImpersonation = () => {
    // Server-side swap back: /auth/stop-impersonation reads the impersonator's
    // id out of the current session and mints them a fresh one.
    api
      .stopImpersonation()
      .then(data => {
        setCsrfToken(data.csrfToken);
        setUser(toUser(data));
        disconnectSocket();
        initSocket();
        loadData();
      })
      .catch(() => {
        handleLogout();
      });
  };

  const pathname = window.location.pathname;
  if (pathname === '/terms')
    return (
      <Suspense fallback={null}>
        <TermsPage />
      </Suspense>
    );
  if (pathname === '/privacy')
    return (
      <Suspense fallback={null}>
        <PrivacyPage />
      </Suspense>
    );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-dark-300 text-sm">Loading PulsarTeam...</p>
        </div>
      </div>
    );
  }

  // Rendered on both the login page and the app so notices fired around a
  // forced logout (e.g. expired socket auth) stay visible.
  const toastContainer = (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 p-4 rounded-lg shadow-lg border backdrop-blur-sm animate-slide-in-right ${
            toast.type === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : toast.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-blue-500/10 border-blue-500/30 text-blue-400'
          }`}
        >
          {toast.type === 'error' ? (
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          ) : toast.type === 'success' ? (
            <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          ) : (
            <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />
          )}
          <p className="text-sm flex-1">{toast.message}</p>
          <button
            onClick={() => dismissToast(toast.id)}
            className="opacity-60 hover:opacity-100 transition-opacity"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );

  if (!user) {
    return (
      <>
        <Suspense fallback={null}>
          <LoginPage onLogin={handleLogin} oauthLoading={oauthLoading} />
        </Suspense>
        {toastContainer}
      </>
    );
  }

  return (
    <VoiceSessionProvider socket={getSocket()} agents={agents}>
      <Dashboard
        user={user}
        agents={agents}
        templates={templates}
        projects={projects}
        skills={skills}
        mcpServers={mcpServers}
        thinkingMap={thinkingMap}
        streamBuffers={streamBuffers}
        onLogout={handleLogout}
        onRefresh={refreshAll}
        socket={getSocket()}
        showToast={showToast}
        onImpersonate={handleImpersonate}
        onStopImpersonation={handleStopImpersonation}
        loadTemplates={loadTemplates}
        loadProjects={loadProjects}
        loadSkills={loadSkills}
        loadMcpServers={loadMcpServers}
        onAgentCreated={agent =>
          setAgents(prev => (prev.some(a => a.id === agent.id) ? prev : [...prev, agent]))
        }
      />

      {dbUnavailable && (
        <div className="fixed top-0 inset-x-0 z-[200] flex items-center gap-3 px-4 py-2.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">
            <strong>Database unavailable</strong> — agents and settings will not be persisted. Check
            your PostgreSQL connection.
          </span>
          <button onClick={() => setDbUnavailable(false)} className="opacity-60 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!user.impersonatedBy && (!user.termsAcceptedAt || !user.tutorialCompletedAt) && (
        <Suspense fallback={null}>
          <WelcomeTutorialModal
            needTerms={!user.termsAcceptedAt}
            needTutorial={!user.tutorialCompletedAt}
            onTermsAccepted={() =>
              setUser(prev =>
                prev ? { ...prev, termsAcceptedAt: new Date().toISOString() } : prev
              )
            }
            onTutorialCompleted={() =>
              setUser(prev =>
                prev ? { ...prev, tutorialCompletedAt: new Date().toISOString() } : prev
              )
            }
            onDeclineLogout={handleLogout}
            showToast={showToast}
          />
        </Suspense>
      )}

      {toastContainer}
    </VoiceSessionProvider>
  );
}
