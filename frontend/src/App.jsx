import { useState, useEffect, useCallback, useRef } from 'react';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { api } from './api';
import LoginPage from './components/LoginPage';
import Dashboard from './components/Dashboard';
import { VoiceSessionProvider } from './contexts/VoiceSessionContext';
import { X, AlertCircle, CheckCircle, Info } from 'lucide-react';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [projects, setProjects] = useState([]);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [thinkingMap, setThinkingMap] = useState({});
  const [streamBuffers, setStreamBuffers] = useState({});
  const streamEndedAgents = useRef(new Set()); // Track agents whose stream just ended
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type = 'error', duration = 5000) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [agentsResult, templatesResult, projectsResult, skillsResult, mcpResult] = await Promise.allSettled([
        api.getAgents(),
        api.getTemplates(),
        api.getProjects(),
        api.getPlugins(),
        api.getMcpServers()
      ]);

      if (agentsResult.status === 'fulfilled') {
        setAgents(agentsResult.value);
      } else {
        console.error('Failed to load agents:', agentsResult.reason);
      }

      if (templatesResult.status === 'fulfilled') {
        setTemplates(templatesResult.value);
      } else {
        console.error('Failed to load templates:', templatesResult.reason);
      }

      if (projectsResult.status === 'fulfilled') {
        setProjects(projectsResult.value);
      } else {
        console.error('Failed to load projects:', projectsResult.reason);
        setProjects([]);
      }

      if (skillsResult.status === 'fulfilled') {
        setSkills(skillsResult.value);
      } else {
        console.error('Failed to load skills:', skillsResult.reason);
        setSkills([]);
      }

      if (mcpResult.status === 'fulfilled') {
        setMcpServers(mcpResult.value);
      } else {
        console.error('Failed to load MCP servers:', mcpResult.reason);
        setMcpServers([]);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, []);

  // Use a ref to hold showToast so socket handlers always call the latest version
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  // All socket event names we register — used for cleanup
  const SOCKET_EVENTS = [
    'agents:list', 'agent:created', 'agent:updated', 'agent:deleted',
    'agent:status', 'agent:thinking', 'agent:stream:start', 'agent:stream:chunk',
    'agent:stream:end', 'agent:stream:error', 'agent:error:report', 'agent:handoff'
  ];

  const initSocket = useCallback((token) => {
    const sock = connectSocket(token);

    // Remove any previously registered listeners to prevent duplicates
    SOCKET_EVENTS.forEach(ev => sock.off(ev));

    sock.on('agents:list', (list) => setAgents(list));
    sock.on('agent:created', (agent) => setAgents(prev => [...prev, agent]));
    sock.on('agent:updated', (agent) => {
      setAgents(prev => prev.map(a => a.id === agent.id ? agent : a));
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
    sock.on('agent:deleted', ({ id }) => setAgents(prev => prev.filter(a => a.id !== id)));
    sock.on('agent:status', ({ id, status }) => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, status } : a));
    });

    sock.on('agent:thinking', ({ agentId, thinking }) => {
      setThinkingMap(prev => ({ ...prev, [agentId]: thinking }));
    });

    sock.on('agent:stream:start', ({ agentId }) => {
      setStreamBuffers(prev => ({ ...prev, [agentId]: '' }));
    });

    sock.on('agent:stream:chunk', ({ agentId, chunk }) => {
      setStreamBuffers(prev => ({
        ...prev,
        [agentId]: (prev[agentId] || '') + chunk
      }));
    });

    sock.on('agent:stream:end', ({ agentId }) => {
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

    sock.on('agent:stream:error', ({ agentId, error }) => {
      console.error(`Stream error for ${agentId}:`, error);
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
      setStreamBuffers(prev => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
    });

    sock.on('agent:error:report', ({ agentName, description }) => {
      showToastRef.current(`🚨 ${agentName} reports an error: ${description.slice(0, 200)}`, 'error', 12000);
    });

    sock.on('agent:handoff', (data) => {
      console.log('Handoff:', data);
    });

    return sock;
  }, []); // No deps — uses refs for callbacks, setState is stable

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      api.verify()
        .then((data) => {
          setUser(data.user);
          initSocket(token);
          loadData();
        })
        .catch(() => {
          localStorage.removeItem('token');
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    return () => {
      // Cleanup: remove all socket listeners when effect re-runs
      const sock = getSocket();
      if (sock) SOCKET_EVENTS.forEach(ev => sock.off(ev));
    };
  }, [initSocket, loadData]);

  const handleLogin = async (username, password) => {
    const data = await api.login(username, password);
    localStorage.setItem('token', data.token);
    setUser({ username: data.username, role: data.role });
    initSocket(data.token);
    await loadData();
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    disconnectSocket();
    setUser(null);
    setAgents([]);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-dark-300 text-sm">Loading Agent Swarm...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />;
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
        onRefresh={loadData}
        socket={getSocket()}
        showToast={showToast}
      />

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
    </VoiceSessionProvider>
  );
}