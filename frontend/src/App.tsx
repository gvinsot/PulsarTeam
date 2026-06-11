import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { api } from './api';
import { safeGet, safeSet, safeRemove } from './lib/safeStorage';
import { WsEvents } from './socketEvents';
import Dashboard from './components/Dashboard';
import { VoiceSessionProvider } from './contexts/VoiceSessionContext';
import { X, AlertCircle, CheckCircle, Info } from 'lucide-react';

const LoginPage = lazy(() => import('./components/LoginPage'));
const TermsPage = lazy(() => import('./components/TermsPage'));
const PrivacyPage = lazy(() => import('./components/PrivacyPage'));
const WelcomeTutorialModal = lazy(() => import('./components/WelcomeTutorialModal'));

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dbUnavailable, setDbUnavailable] = useState(false);
  const [agents, setAgents] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [projects, setProjects] = useState([]);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [thinkingMap, setThinkingMap] = useState({});
  const [streamBuffers, setStreamBuffers] = useState({});
  const streamEndedAgents = useRef(new Set()); // Track agents whose stream just ended
  // Agents currently streaming on the server (from STREAM_START/STREAM_RESUME).
  // Used as the source of truth for whether to keep a streamBuffer alive,
  // so we don't race against agent.status updates arriving out of order.
  const activeStreamAgents = useRef(new Set());
  const lastAgentJson = useRef(new Map());    // Dedup: last JSON per agentId
  const [toasts, setToasts] = useState([]);
  const [googleLoading, setGoogleLoading] = useState(false);

  const showToast = useCallback((message, type = 'error', duration = 5000) => {
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

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

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
      const normalized = (repos || []).map(r => ({
        // Canonical id used by the picker and stored as agent.project.
        name: r.fullName || r.name,
        fullName: r.fullName,
        repoName: r.fullName ? r.fullName.split('/').pop() : r.name,
        provider: r.provider,
        description: r.description || '',
        htmlUrl: r.htmlUrl || '',
        defaultBranch: r.defaultBranch || '',
      }));
      // De-duplicate by fullName in case the same repo is exposed by
      // multiple connections.
      const seen = new Set();
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

  // Safety: clear stale thinking state for agents that are no longer busy.
  // Handles edge cases where socket events (STREAM_END) were lost due to
  // reconnection.
  //
  // IMPORTANT: streamBuffers is NOT cleared based on agent.status here.
  // STREAM_START arrives BEFORE the agent:status='busy' event in many flows,
  // and any stale `agent:updated` (with status='idle') that fires between
  // them would prematurely wipe the buffer — that's the bug that caused
  // "I need to refresh to see the stream". streamBuffers is now owned
  // exclusively by the STREAM_* handlers below.
  useEffect(() => {
    const busyIds = new Set(agents.filter(a => a.status === 'busy').map(a => a.id));
    setThinkingMap(prev => {
      let changed = false;
      const copy = { ...prev };
      for (const agentId of Object.keys(copy)) {
        if (!busyIds.has(agentId)) {
          delete copy[agentId];
          changed = true;
        }
      }
      return changed ? copy : prev;
    });
  }, [agents]);

  // Use a ref to hold showToast so socket handlers always call the latest version
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  const SOCKET_EVENTS = [
    WsEvents.AGENTS_LIST, WsEvents.AGENT_CREATED, WsEvents.AGENT_UPDATED, WsEvents.AGENT_DELETED,
    WsEvents.AGENT_STATUS, WsEvents.AGENT_THINKING, WsEvents.STREAM_START, WsEvents.STREAM_CHUNK,
    WsEvents.STREAM_END, WsEvents.STREAM_ERROR, WsEvents.STREAM_RESUME,
    WsEvents.AGENT_ERROR_REPORT, WsEvents.AGENT_HANDOFF
  ];

  const initSocket = useCallback((token) => {
    const sock = connectSocket(token);

    // Remove any previously registered listeners to prevent duplicates
    SOCKET_EVENTS.forEach(ev => sock.off(ev));

    sock.on(WsEvents.AGENTS_LIST, (list) => setAgents(list));
    sock.on(WsEvents.AGENT_CREATED, (agent) => setAgents(prev =>
      prev.some(a => a.id === agent.id) ? prev.map(a => a.id === agent.id ? agent : a) : [...prev, agent]
    ));
    sock.on(WsEvents.AGENT_UPDATED, (agent) => {
      // Dedup: skip if the payload is identical to the last one for this agent
      const json = JSON.stringify(agent);
      if (lastAgentJson.current.get(agent.id) === json) return;
      lastAgentJson.current.set(agent.id, json);

      setAgents(prev => prev.map(a => a.id === agent.id ? agent : a));
      // Safety net: clear thinking when agent data shows it's no longer busy.
      // This handles cases where agent:stream:end was missed (other clients,
      // workflow-triggered executions, socket reconnections).
      if (agent.status !== 'busy') {
        setThinkingMap(prev => {
          if (!(agent.id in prev)) return prev;
          const copy = { ...prev };
          delete copy[agent.id];
          return copy;
        });
      }
      // When an agent's stream just ended, clear its buffer atomically
      // with the history update so the message never disappears.
      if (streamEndedAgents.current.has(agent.id)) {
        streamEndedAgents.current.delete(agent.id);
        setStreamBuffers(prev => {
          const copy = { ...prev };
          delete copy[agent.id];
          return copy;
        });
      }
    });
    sock.on(WsEvents.AGENT_DELETED, ({ id }) => setAgents(prev => prev.filter(a => a.id !== id)));
    sock.on(WsEvents.AGENT_STATUS, ({ id, status }) => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, status } : a));
      // When agent goes idle or error, clear stale thinking state so the
      // card doesn't keep showing "busy" after the agent has finished.
      if (status !== 'busy') {
        setThinkingMap(prev => {
          if (!(id in prev)) return prev;
          const copy = { ...prev };
          delete copy[id];
          return copy;
        });
      }
    });

    sock.on(WsEvents.AGENT_THINKING, ({ agentId, thinking }) => {
      if (!thinking) {
        setThinkingMap(prev => {
          if (!(agentId in prev)) return prev;
          const copy = { ...prev };
          delete copy[agentId];
          return copy;
        });
      } else {
        setThinkingMap(prev => ({ ...prev, [agentId]: thinking }));
      }
    });

    sock.on(WsEvents.STREAM_START, ({ agentId }) => {
      activeStreamAgents.current.add(agentId);
      setStreamBuffers(prev => ({ ...prev, [agentId]: '' }));
    });

    sock.on(WsEvents.STREAM_CHUNK, ({ agentId, chunk }) => {
      activeStreamAgents.current.add(agentId);
      setStreamBuffers(prev => ({
        ...prev,
        [agentId]: (prev[agentId] || '') + chunk
      }));
    });

    // STREAM_RESUME is the server's response to REQ_STREAM_STATE on
    // (re)connect. It carries the FULL list of active streams (possibly
    // empty). We seed buffers for the active ones AND evict any local
    // buffers whose agent isn't streaming anymore — that covers the case
    // where the server crashed before sending STREAM_END.
    sock.on(WsEvents.STREAM_RESUME, ({ streams }) => {
      const list = Array.isArray(streams) ? streams : [];
      const activeIds = new Set(list.map((s: any) => s.agentId));
      activeStreamAgents.current = activeIds;
      setStreamBuffers(prev => {
        const next: Record<string, string> = {};
        for (const s of list) next[s.agentId] = s.buffer || '';
        // Drop any local buffer for an agent that's no longer active server-side.
        for (const id of Object.keys(prev)) {
          if (!activeIds.has(id) && !(id in next)) {
            // intentionally omit — buffer gets evicted
          }
        }
        return next;
      });
    });

    sock.on(WsEvents.STREAM_END, ({ agentId }) => {
      activeStreamAgents.current.delete(agentId);
      setThinkingMap(prev => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
      // Don't clear streamBuffer here — mark the agent so that the next
      // agent:updated event clears it atomically with the history update.
      // This prevents the flash where the message disappears then reappears.
      streamEndedAgents.current.add(agentId);
      // Safety net: if agent:updated doesn't arrive within 3s, clear anyway
      setTimeout(() => {
        if (streamEndedAgents.current.has(agentId)) {
          streamEndedAgents.current.delete(agentId);
          setStreamBuffers(prev => {
            const copy = { ...prev };
            delete copy[agentId];
            return copy;
          });
        }
      }, 3000);
    });

    sock.on(WsEvents.STREAM_ERROR, ({ agentId, error }) => {
      console.error(`Stream error for ${agentId}:`, error);
      activeStreamAgents.current.delete(agentId);
      const errorLower = (error || '').toLowerCase();
      const isModelError = [
        'context length', 'context_length', 'num_ctx', 'context window',
        'too long', 'maximum context', 'exceeds', 'out of memory', 'oom',
        'kv cache', 'model error', 'ollama error'
      ].some(kw => errorLower.includes(kw));
      showToastRef.current(
        error || 'An error occurred while streaming response',
        'error',
        isModelError ? 0 : 8000
      );
      setThinkingMap(prev => {
        if (!(agentId in prev)) return prev;
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
      setStreamBuffers(prev => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
    });

    // REQ_STREAM_STATE on (re)connect is wired in socket.ts so it runs once
    // per socket instance — see connectSocket().

    sock.on(WsEvents.AGENT_ERROR_REPORT, ({ agentName, description, isSystemError }) => {
      const prefix = isSystemError ? '⚙️' : '🚨';
      showToastRef.current(`${prefix} ${agentName}: ${description.slice(0, 200)}`, 'error', 12000);
    });

    sock.on(WsEvents.AGENT_HANDOFF, (data) => {
      console.log('Handoff:', data);
    });

    return sock;
  }, []); // No deps — uses refs for callbacks, setState is stable

  useEffect(() => {
    let cancelled = false;
    const token = safeGet('token');
    if (token) {
      api.verify()
        .then(async (data) => {
          if (cancelled) return;
          const u = data.user;
          setUser({
            username: u.username,
            role: u.role,
            userId: u.userId,
            displayName: u.displayName,
            termsAcceptedAt: u.termsAcceptedAt || null,
            tutorialCompletedAt: u.tutorialCompletedAt || null,
            ...(u.impersonatedBy ? { impersonatedBy: u.impersonatedBy } : {}),
          });
          await loadData();
          if (cancelled) return;
          initSocket(token);
          checkDbHealth();
        })
        .catch((err) => {
          if (cancelled) return;
          // A transient backend stall (request timeout/abort) must not
          // silently log the user out — only drop the token when the
          // server actually rejected it.
          if (err?.name !== 'TimeoutError' && err?.name !== 'AbortError') {
            safeRemove('token');
          }
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      setLoading(false);
    }
    return () => {
      cancelled = true;
      // Cleanup: remove all socket listeners when effect re-runs
      const sock = getSocket();
      if (sock) SOCKET_EVENTS.forEach(ev => sock.off(ev));
    };
  }, [initSocket, loadData]);

  const checkDbHealth = useCallback(async () => {
    try {
      const health = await api.getHealth();
      setDbUnavailable(health.database !== 'connected');
    } catch {
      // Backend unreachable — don't show DB warning on top of connectivity issues
    }
  }, []);

  // Handle OAuth callback URLs (Google + Microsoft)
  useEffect(() => {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return;

    let apiCall: Promise<any> | null = null;

    if (path === '/auth/google/callback') {
      setGoogleLoading(true);
      const redirectUri = sessionStorage.getItem('oauth_redirect_uri') || `${window.location.origin}/auth/google/callback`;
      sessionStorage.removeItem('oauth_redirect_uri');
      window.history.replaceState({}, '', '/');
      apiCall = api.googleCallback(code, redirectUri);
    } else if (path === '/auth/microsoft/callback') {
      setGoogleLoading(true);
      const redirectUri = sessionStorage.getItem('oauth_redirect_uri') || `${window.location.origin}/auth/microsoft/callback`;
      sessionStorage.removeItem('oauth_redirect_uri');
      window.history.replaceState({}, '', '/');
      apiCall = api.microsoftCallback(code, redirectUri);
    } else if (path === '/auth/github/callback') {
      setGoogleLoading(true);
      const redirectUri = sessionStorage.getItem('oauth_redirect_uri') || `${window.location.origin}/auth/github/callback`;
      sessionStorage.removeItem('oauth_redirect_uri');
      window.history.replaceState({}, '', '/');
      apiCall = api.githubAuthCallback(code, redirectUri);
    }

    if (apiCall) {
      apiCall
        .then(async (data) => {
          safeSet('token', data.token);
          setUser({
            username: data.username,
            role: data.role,
            userId: data.userId,
            displayName: data.displayName,
            termsAcceptedAt: data.termsAcceptedAt || null,
            tutorialCompletedAt: data.tutorialCompletedAt || null,
          });
          await loadData();
          initSocket(data.token);
          await checkDbHealth();
        })
        .catch((err) => {
          console.error('OAuth login failed:', err);
          showToast(err.message || 'Login failed', 'error');
        })
        .finally(() => {
          setGoogleLoading(false);
          setLoading(false);
        });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = async (username, password) => {
    const data = await api.login(username, password);
    safeSet('token', data.token);
    setUser({
      username: data.username,
      role: data.role,
      userId: data.userId,
      displayName: data.displayName,
      termsAcceptedAt: data.termsAcceptedAt || null,
      tutorialCompletedAt: data.tutorialCompletedAt || null,
    });
    await loadData();
    initSocket(data.token);
    checkDbHealth();
  };

  const handleLogout = () => {
    safeRemove('token');
    safeRemove('originalToken');
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
      showToastRef.current(`Realtime connection failed: ${detail || 'unknown error'}`, 'error', 8000);
    };
    window.addEventListener('socket:auth-error', onAuthError);
    window.addEventListener('socket:connect-error', onConnectError);
    return () => {
      window.removeEventListener('socket:auth-error', onAuthError);
      window.removeEventListener('socket:connect-error', onConnectError);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImpersonate = (data) => {
    // Save original token so we can return
    const currentToken = safeGet('token');
    safeSet('originalToken', currentToken);
    safeSet('token', data.token);
    setUser({
      username: data.username,
      role: data.role,
      userId: data.userId,
      displayName: data.displayName,
      impersonatedBy: data.impersonatedBy,
    });
    disconnectSocket();
    initSocket(data.token);
    loadData();
  };

  const handleStopImpersonation = () => {
    const originalToken = safeGet('originalToken');
    if (!originalToken) return;
    safeSet('token', originalToken);
    safeRemove('originalToken');
    // Re-verify to get original user info
    api.verify().then((verifyData) => {
      setUser(verifyData.user);
      disconnectSocket();
      initSocket(originalToken);
      loadData();
    }).catch(() => {
      handleLogout();
    });
  };

  const pathname = window.location.pathname;
  if (pathname === '/terms') return <Suspense fallback={null}><TermsPage /></Suspense>;
  if (pathname === '/privacy') return <Suspense fallback={null}><PrivacyPage /></Suspense>;

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
            toast.type === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-400' :
            toast.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
            'bg-blue-500/10 border-blue-500/30 text-blue-400'
          }`}
        >
          {toast.type === 'error' ? <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" /> :
           toast.type === 'success' ? <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" /> :
           <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />}
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
        <Suspense fallback={null}><LoginPage onLogin={handleLogin} googleLoading={googleLoading} /></Suspense>
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
        onAgentCreated={(agent) => setAgents(prev =>
          prev.some(a => a.id === agent.id) ? prev : [...prev, agent]
        )}
      />

      {dbUnavailable && (
        <div className="fixed top-0 inset-x-0 z-[200] flex items-center gap-3 px-4 py-2.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">
            <strong>Database unavailable</strong> — agents and settings will not be persisted. Check your PostgreSQL connection.
          </span>
          <button onClick={() => setDbUnavailable(false)} className="opacity-60 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {(!user.impersonatedBy && (!user.termsAcceptedAt || !user.tutorialCompletedAt)) && (
        <Suspense fallback={null}>
          <WelcomeTutorialModal
            needTerms={!user.termsAcceptedAt}
            needTutorial={!user.tutorialCompletedAt}
            onTermsAccepted={() => setUser(prev => prev ? { ...prev, termsAcceptedAt: new Date().toISOString() } : prev)}
            onTutorialCompleted={() => setUser(prev => prev ? { ...prev, tutorialCompletedAt: new Date().toISOString() } : prev)}
            onDeclineLogout={handleLogout}
            showToast={showToast}
          />
        </Suspense>
      )}

      {toastContainer}
    </VoiceSessionProvider>
  );
}