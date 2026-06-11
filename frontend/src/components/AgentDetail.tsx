import { useState, useRef, useEffect } from 'react';
import {
  X, MessageSquare, Settings,
  StopCircle, FolderCode, Activity, Wrench, ArrowLeft, Layers, Shield, Loader2,
} from 'lucide-react';
import { api } from '../api';
import { WsEvents } from '../socketEvents';
import { safeGet } from '../lib/safeStorage';

// How long the client waits for the server's ack before assuming the
// REQ_CHAT message was lost (socket reconnecting, server crash, etc.).
// Long enough to absorb a slow round-trip; short enough that the user
// gets feedback while their attention is still on the chat.
const CHAT_ACK_TIMEOUT_MS = 8000;
import VoiceChatTab from './VoiceChatTab';
import ExternalVoiceChatTab from './ExternalVoiceChatTab';
import ChatTab from './agentDetail/ChatTab';
import TerminalTab from './agentDetail/TerminalTab';
import PluginsTab from './agentDetail/PluginsTab';

// CLI runners that get a real TUI in a shared PTY instead of the chat
// surface. The terminal is the canonical interactive interface for these —
// the chat would just relay a flaky approximation of the real CLI output.
const CLI_RUNNERS = new Set(['claudecode', 'codex', 'opencode', 'openclaw', 'hermes', 'aider']);
import ContextTab from './agentDetail/ContextTab';
import ActionLogsTab from './agentDetail/ActionLogsTab';
import SettingsTab from './agentDetail/SettingsTab';
import PermissionsTab from './agentDetail/PermissionsTab';

// Re-export cleanToolSyntax so existing imports (e.g. BroadcastPanel) keep working
export { cleanToolSyntax } from './agentDetail/cleanToolSyntax';

const TABS = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'context', label: 'Context', icon: Layers },
  { id: 'plugins', label: 'Plugins', icon: Wrench },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'logs', label: 'Action Logs', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function AgentDetail({ agent, agents, projects, skills, thinking, streamBuffer, socket, onClose, onSelectAgent, onRefresh, onActiveTabChange, requestedTab, userRole, currentUser, showToast }) {
  const [activeTab, setActiveTab] = useState('chat');
  const isCliRunner = CLI_RUNNERS.has(agent.runner);

  // Notify parent of active tab changes
  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    onActiveTabChange?.(tabId);
  };

  // Notify parent of initial tab on mount
  useEffect(() => {
    onActiveTabChange?.('chat');
  }, []);

  // Handle requested tab from parent (e.g., from voice indicator navigation)
  useEffect(() => {
    if (requestedTab && requestedTab !== activeTab) {
      setActiveTab(requestedTab);
      onActiveTabChange?.(requestedTab);
    }
  }, [requestedTab]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false); // Ref-based guard to prevent double-sends
  const [history, setHistory] = useState(agent?.conversationHistory || []);
  const [pendingImages, setPendingImages] = useState([]);
  const chatEndRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [currentProject, setCurrentProject] = useState(agent?.project || '');
  const [projectSaving, setProjectSaving] = useState(false);

  // Repo list sourced from the agent's board GitHub plugin OAuth — same list
  // as CreateTaskModal uses, so the chat picker isn't artificially restricted
  // to repos already referenced by an existing task on the board.
  const [boardRepos, setBoardRepos] = useState([]);
  useEffect(() => {
    if (!agent?.boardId) { setBoardRepos([]); return; }
    let cancelled = false;
    api.getBoardAvailableRepos(agent.boardId)
      .then(repos => { if (!cancelled) setBoardRepos(Array.isArray(repos) ? repos : []); })
      .catch(() => { if (!cancelled) setBoardRepos([]); });
    return () => { cancelled = true; };
  }, [agent?.boardId]);

  // Merge the board's available repos with the global projects list as a
  // fallback. Always include the currently-selected project so the dropdown
  // can render it even when the board OAuth isn't connected.
  const repoOptions = (() => {
    const map = new Map();
    for (const r of boardRepos) {
      const key = r.fullName || r.name;
      if (!key) continue;
      map.set(key, {
        name: key,
        fullName: r.fullName || key,
        description: r.description || '',
        htmlUrl: r.htmlUrl || '',
      });
    }
    if (boardRepos.length === 0) {
      for (const p of (projects || [])) {
        if (!p?.name) continue;
        if (!map.has(p.name)) map.set(p.name, p);
      }
    }
    if (currentProject && !map.has(currentProject)) {
      map.set(currentProject, { name: currentProject, fullName: currentProject });
    }
    return Array.from(map.values());
  })();

  useEffect(() => {
    setCurrentProject(agent?.project || '');
  }, [agent?.id, agent?.project]);

  const handleProjectChange = async (project) => {
    setCurrentProject(project);
    setProjectSaving(true);

    try {
      await api.updateAgent(agent.id, { project });
      onRefresh();
      // Trigger background indexing of the new project folder
      if (project) {
        api.indexProject(project).catch(() => {});
      }
    } catch (err) {
      console.error(err);
      setCurrentProject(agent?.project || '');
    } finally {
      setProjectSaving(false);
    }
  };

  // The repo switch isn't done when updateAgent returns — the runner still has
  // to clone the new repo and restart the CLI in the new working directory.
  // The backend reports that phase via `agent.projectSwitching`, so keep the
  // waiting animation up until it clears.
  const switching = projectSaving || agent?.projectSwitching === true;

  // Sync history from agent object (pushed via socket) instead of fetching from API.
  // This eliminates the flash between stream end and API response.
  useEffect(() => {
    if (agent?.conversationHistory) {
      setHistory(agent.conversationHistory);
    }
  }, [agent?.id, agent?.conversationHistory?.length]);

  // Auto-scroll chat
  useEffect(() => {
    if (autoScroll) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [history, streamBuffer, thinking, autoScroll]);

  // Release send guard when agent finishes processing (stream ends)
  useEffect(() => {
    if (sendingRef.current && agent?.status !== 'busy') {
      sendingRef.current = false;
      setSending(false);
    }
  }, [agent?.status]);

  const handleSend = async (msgOverride?: string) => {
    const hasImages = pendingImages.length > 0;
    if ((!(msgOverride ?? message).trim() && !hasImages) || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const msg = (msgOverride ?? message).trim() || (hasImages ? '(image)' : '');
    const imagesToSend = hasImages ? pendingImages.map(img => ({ data: img.data, mediaType: img.mediaType })) : null;
    const imagePreviewsForHistory = hasImages ? pendingImages.map(img => ({ data: img.data, mediaType: img.mediaType })) : undefined;
    setMessage('');
    setPendingImages([]);

    if (socket) {
      // Each REQ_CHAT carries a unique messageId so the server can dedup
      // legitimate retries (e.g. ack timeout below). The ack callback tells
      // us whether the server actually accepted the message — without it
      // (and with the old volatile.emit) silently-dropped messages would
      // vanish from the UI after the next agent:updated re-sync.
      const messageId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const payload: any = { agentId: agent.id, message: msg, messageId };
      if (imagesToSend) payload.images = imagesToSend;

      // Optimistically add the user message to history. If the ack reports
      // an error we roll it back so the user sees something is wrong.
      const histEntry: any = { role: 'user', content: msg, timestamp: new Date().toISOString(), _pendingMessageId: messageId };
      if (imagePreviewsForHistory) histEntry.images = imagePreviewsForHistory;
      setHistory(prev => [...prev, histEntry]);

      const rollbackOptimistic = (reason: string) => {
        // Drop the optimistic entry by its tag (so concurrent sends don't
        // accidentally remove the wrong one). Restore the input so the user
        // can retry without retyping.
        setHistory(prev => prev.filter((m: any) => m._pendingMessageId !== messageId));
        setMessage(prev => prev || msg);
        if (imagesToSend) setPendingImages(prev => prev.length ? prev : pendingImages);
        sendingRef.current = false;
        setSending(false);
        if (showToast) showToast(reason, 'error', 6000);
      };

      let ackHandled = false;
      const ackTimer = setTimeout(() => {
        if (ackHandled) return;
        ackHandled = true;
        rollbackOptimistic('Message non délivré (timeout réseau). Vérifie ta connexion et réessaie.');
      }, CHAT_ACK_TIMEOUT_MS);

      socket.emit(WsEvents.REQ_CHAT, payload, (ackResp: any) => {
        if (ackHandled) return;
        ackHandled = true;
        clearTimeout(ackTimer);

        const status = ackResp?.status;
        if (status === 'accepted' || status === 'duplicate') {
          // Strip the pending tag — the message is now real history.
          setHistory(prev => prev.map((m: any) =>
            m._pendingMessageId === messageId ? { ...m, _pendingMessageId: undefined } : m
          ));
          // sending/sendingRef are released when status flips off 'busy'
          return;
        }

        // Anything else (forbidden / rate_limit / busy / invalid / network)
        // means the server never queued the message — undo the optimism.
        const human = ackResp?.message || 'Le serveur a rejeté le message.';
        rollbackOptimistic(human);
      });
    } else {
      try {
        const result = await api.chatAgent(agent.id, msg);
        const histEntry: any = { role: 'user', content: msg, timestamp: new Date().toISOString() };
        if (imagePreviewsForHistory) histEntry.images = imagePreviewsForHistory;
        setHistory(prev => [
          ...prev,
          histEntry,
          { role: 'assistant', content: result.response, timestamp: new Date().toISOString() }
        ]);
      } catch (err) {
        console.error(err);
        if (showToast) showToast('Échec d\'envoi du message.', 'error', 6000);
      }
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleClearHistory = async () => {
    if (!confirm('Clear all conversation history?')) return;
    await api.clearHistory(agent.id);
    setHistory([]);
    onRefresh();
  };

  const handleReloadHistory = async () => {
    try {
      const fresh = await api.reloadHistory(agent.id);
      setHistory(Array.isArray(fresh) ? fresh : []);
      onRefresh?.();
    } catch (err) {
      console.error('Failed to reload conversation from DB:', err);
    }
  };

  const handleTruncateHistory = async (afterIndex) => {
    if (!confirm('Restart from this message? Everything after it will be deleted.')) return;
    const newHistory = await api.truncateHistory(agent.id, afterIndex);
    setHistory(newHistory);
    onRefresh();
  };

  return (
    <div className="flex flex-col h-full animate-slideIn">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
        <div className="flex items-center gap-3 min-w-0">
          {/* Mobile back button */}
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 -ml-1 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors flex-shrink-0"
            title="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Mobile agent + project switchers */}
          <div className="lg:hidden flex items-center gap-2 min-w-0 flex-1">
            <select
              value={agent.id}
              onChange={(e) => onSelectAgent?.(e.target.value)}
              className="min-w-0 flex-1 px-2 py-1 bg-dark-800 border border-dark-600 rounded-lg text-sm font-bold text-dark-100 focus:outline-none focus:border-indigo-500 truncate appearance-none"
              title="Active agent"
            >
              {agents.filter(a => a.enabled !== false).map(a => (
                <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
              ))}
            </select>
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <FolderCode className="w-3.5 h-3.5 text-dark-500 flex-shrink-0" />
              <select
                value={currentProject}
                onChange={(e) => handleProjectChange(e.target.value)}
                disabled={switching}
                className="min-w-0 flex-1 px-2 py-1 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                title="Working project"
              >
                <option value="">No repository</option>
                {repoOptions.map(p => (
                  <option key={p.name} value={p.name} title={p.description || p.htmlUrl || p.name}>
                    {p.fullName || p.name}
                  </option>
                ))}
              </select>
              {switching && <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin flex-shrink-0" />}
            </div>
          </div>
          {/* Desktop: agent icon + name */}
          <span className="text-2xl flex-shrink-0 hidden lg:inline">{agent.icon}</span>
          <div className="min-w-0 hidden lg:block">
            <h2 className="font-bold text-dark-100">{agent.name}</h2>
            <div className="flex items-center gap-2 text-xs">
              <span className={`inline-flex items-center gap-1 ${
                agent.status === 'busy' ? 'text-amber-400' :
                agent.status === 'error' ? 'text-red-400' : 'text-emerald-400'
              }`}>
                <div className={`w-1.5 h-1.5 rounded-full ${
                  agent.status === 'busy' ? 'bg-amber-500 animate-pulse' :
                  agent.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'
                }`} />
                {agent.status}
              </span>
              {agent.isVoice && (
                <>
                  <span className="text-dark-500">·</span>
                  <span className="text-amber-400 font-medium">Voice</span>
                </>
              )}
              <span className="text-dark-500">·</span>
              <span className="text-dark-400 truncate">{agent.provider}/{agent.model}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Project selector — auto-saves (hidden on mobile) */}
          <div className="hidden lg:flex items-center gap-1.5">
            <FolderCode className="w-3.5 h-3.5 text-dark-500 flex-shrink-0" />
            <select
              value={currentProject}
              onChange={(e) => handleProjectChange(e.target.value)}
              disabled={switching}
              className="px-2 py-1 bg-dark-800 border border-dark-600 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-indigo-500 max-w-[160px] disabled:opacity-60"
              title="Working project"
            >
              <option value="">No repository</option>
              {repoOptions.map(p => (
                <option key={p.name} value={p.name} title={p.description || p.htmlUrl || p.name}>
                  {p.fullName || p.name}
                </option>
              ))}
            </select>
            {switching && <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin flex-shrink-0" />}
          </div>
          {agent.status === 'busy' && socket && (
            <button
              onClick={() => socket.emit(WsEvents.REQ_STOP, { agentId: agent.id })}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors text-sm font-medium"
              title="Stop agent"
            >
              <StopCircle className="w-4 h-4" />
              Stop
            </button>
          )}
          <button onClick={onClose} className="hidden lg:block p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-dark-700 px-2 overflow-x-auto">
        {TABS.filter(tab => !(userRole === 'basic' && (tab.id === 'settings' || tab.id === 'permissions'))).map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-dark-400 hover:text-dark-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className={`relative flex-1 min-h-0 ${activeTab === 'chat' && isCliRunner ? 'overflow-hidden' : 'overflow-auto'}`}>
        {switching && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-dark-900/80 backdrop-blur-sm">
            <div className="relative">
              <Loader2 className="w-10 h-10 text-indigo-400 animate-spin" />
              <FolderCode className="w-4 h-4 text-indigo-300 absolute inset-0 m-auto" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-dark-100">Switching repository…</p>
              <p className="text-xs text-dark-400 mt-1">
                Cloning <span className="font-mono text-dark-300">{currentProject || 'workspace'}</span> and restarting the agent
              </p>
            </div>
          </div>
        )}
        {activeTab === 'chat' && (
          isCliRunner ? (
            // CLI runners (claudecode, codex, opencode, openclaw) drive a real
            // TUI in a shared PTY — bypassing the chat surface entirely.
            <TerminalTab agent={agent} token={safeGet('token') || ''} />
          ) : agent.isVoice ? (
            agent.voiceMode === 'external'
              ? <ExternalVoiceChatTab agent={agent} />
              : <VoiceChatTab agent={agent} />
          ) : (
            <ChatTab
              agent={agent}
              history={history}
              thinking={thinking}
              streamBuffer={streamBuffer}
              message={message}
              setMessage={setMessage}
              sending={sending || agent.status === 'busy'}
              isBusy={agent.status === 'busy'}
              onSend={handleSend}
              onStop={() => socket?.emit(WsEvents.REQ_STOP, { agentId: agent.id })}
              onClear={handleClearHistory}
              onReload={handleReloadHistory}
              onTruncate={handleTruncateHistory}
              chatEndRef={chatEndRef}
              agentName={agent.name}
              autoScroll={autoScroll}
              onToggleAutoScroll={() => setAutoScroll(s => !s)}
              supportsImages={agent.supportsImages || false}
              pendingImages={pendingImages}
              onAddImages={(imgs) => setPendingImages(prev => [...prev, ...imgs].slice(0, 5))}
              onRemoveImage={(idx) => setPendingImages(prev => prev.filter((_, i) => i !== idx))}
            />
          )
        )}
        {activeTab === 'context' && (
          <ContextTab agent={agent} agents={agents} socket={socket} onRefresh={onRefresh} />
        )}
        {activeTab === 'plugins' && (
          <PluginsTab agent={agent} plugins={skills} onRefresh={onRefresh} />
        )}
        {activeTab === 'permissions' && (
          <PermissionsTab agent={agent} onRefresh={onRefresh} />
        )}
        {activeTab === 'logs' && (
          <ActionLogsTab agent={agent} />
        )}
        {activeTab === 'settings' && (
          <SettingsTab agent={agent} projects={projects} currentProject={currentProject} onRefresh={onRefresh} userRole={userRole} currentUser={currentUser} />
        )}
      </div>
    </div>
  );
}
