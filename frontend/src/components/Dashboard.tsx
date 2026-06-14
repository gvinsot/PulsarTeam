import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import {
  LogOut, Plus, Globe, LayoutGrid, List,
  Zap, Settings, MessageSquare, Key, Users, KanbanSquare, Tag, Menu, DollarSign, Eye, ChevronDown,
  Sun, Moon, FolderGit2
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { api } from '../api';
import { useClickOutside } from '../hooks/useDismiss';
import { safeGet, safeSet, safeRemove } from '../lib/safeStorage';
import { WsEvents } from '../socketEvents';
import AgentCard from './AgentCard';
import BatchAgentCard from './BatchAgentCard';
import AgentDetail from './AgentDetail';
import SwarmOverview from './SwarmOverview';
import ActiveVoiceIndicator from './ActiveVoiceIndicator';
import ApiKeyModal from './ApiKeyModal';
import { Crown, UserCheck } from 'lucide-react';

const TasksBoard = lazy(() => import('./TasksBoard'));
const AddAgentModal = lazy(() => import('./AddAgentModal'));
const BroadcastPanel = lazy(() => import('./BroadcastPanel'));
const ProjectsView = lazy(() => import('./ProjectsView'));
const BudgetDashboard = lazy(() => import('./BudgetDashboard'));
const AdminPanel = lazy(() => import('./AdminPanel'));

// Hash views the render switch actually handles. Used by both the useState
// initializer and the hashchange effect so the two lists can never drift.
const VALID_VIEWS: string[] = ['agents', 'tasks', 'projects', 'budget'];

// Top-nav items, shared by the mobile dropdown and the desktop view-switcher.
// Only the DATA is shared; the two render maps stay separate (different markup).
const NAV_VIEWS = [
  { key: 'agents', label: 'Agents', icon: Users, title: 'Agents view' },
  { key: 'tasks', label: 'Workflows', icon: KanbanSquare, title: 'Workflows board' },
  { key: 'projects', label: 'Projects', icon: Tag, title: 'Projects' },
  { key: 'budget', label: 'Budget', icon: DollarSign, title: 'Budget' },
];

export default function Dashboard({
  user, agents, templates, projects, skills, mcpServers, thinkingMap, streamBuffers,
  onLogout, onRefresh, socket, showToast, onImpersonate, onStopImpersonation,
  loadTemplates, loadProjects, loadSkills, loadMcpServers,
  onAgentCreated
}) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [viewMode, setViewMode] = useState('grid'); // grid | list
  const [activeView, setActiveViewRaw] = useState(() => {
    const hash = window.location.hash.replace('#', '').toLowerCase();
    return VALID_VIEWS.includes(hash) ? hash : 'tasks';
  });
  const setActiveView = useCallback((view) => {
    setActiveViewRaw(view);
    window.history.replaceState(null, '', `#${view}`);
  }, []);
  const [detailActiveTab, setDetailActiveTab] = useState('chat');
  const [requestedTab, setRequestedTab] = useState(null);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [boards, setBoards] = useState([]);
  const [boardFilter, setBoardFilterRaw] = useState(() => safeGet('activeBoardId') || '');
  const setBoardFilter = useCallback((val) => {
    setBoardFilterRaw(val);
    if (val) safeSet('activeBoardId', val);
    else safeRemove('activeBoardId');
  }, []);
  const [dbProjects, setDbProjects] = useState([]);
  const [projectFilter, setProjectFilterRaw] = useState(() => safeGet('activeProjectId') || '');
  const setProjectFilter = useCallback((val) => {
    setProjectFilterRaw(val);
    if (val) safeSet('activeProjectId', val);
    else safeRemove('activeProjectId');
  }, []);
  const mobileMenuRef = useRef(null);
  const userMenuRef = useRef(null);
  // ThemeContext is untyped (createContext() without a type argument), so type the result locally.
  const { theme, toggleTheme } = useTheme() as { theme: string; toggleTheme: () => void };
  const isAdmin = user?.role === 'admin';
  const isBasic = user?.role === 'basic';

  useEffect(() => {
    api.getBoards().then(setBoards).catch(() => {});
    api.getProjects().then(setDbProjects).catch(() => setDbProjects([]));
  }, []);

  // Build lookup: boardId → project_id (from boards loaded above)
  const boardProjectMap = useMemo(() => {
    const m = new Map();
    (boards || []).forEach(b => { if (b?.id) m.set(b.id, b.project_id || null); });
    return m;
  }, [boards]);

  // Clear stale project filter if the project no longer exists
  useEffect(() => {
    if (!projectFilter || dbProjects.length === 0) return;
    if (!dbProjects.some(p => p.id === projectFilter)) setProjectFilter('');
  }, [dbProjects, projectFilter, setProjectFilter]);

  // Lazy-load data based on active view
  useEffect(() => {
    if (activeView === 'tasks') {
      loadProjects();
    } else if (activeView === 'projects') {
      loadProjects();
    } else if (activeView === 'agents') {
      loadProjects();
      loadSkills();
    }
  }, [activeView, loadProjects, loadSkills]);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace('#', '').toLowerCase();
      if (VALID_VIEWS.includes(hash)) setActiveViewRaw(hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useClickOutside(mobileMenuRef, () => setMobileMenuOpen(false), mobileMenuOpen);
  useClickOutside(userMenuRef, () => setUserMenuOpen(false), userMenuOpen);

  const handleNavigateToVoiceAgent = useCallback((agentId) => {
    setSelectedAgent(agentId);
    setRequestedTab('chat');
    // Clear requestedTab after it's consumed
    setTimeout(() => setRequestedTab(null), 100);
  }, []);

  const handleNavigateToAgent = useCallback((agentId) => {
    setActiveView('agents');
    setSelectedAgent(agentId);
    setRequestedTab('chat');
    setTimeout(() => setRequestedTab(null), 100);
  }, [setActiveView]);

  // Sort agents with 'Swarm Leaders' role first
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.role === 'Swarm Leaders' && b.role !== 'Swarm Leaders') return -1;
    if (a.role !== 'Swarm Leaders' && b.role === 'Swarm Leaders') return 1;
    return 0;
  });

  // Apply the global project filter first (a project groups one or more boards)
  const projectScopedAgents = useMemo(() => {
    if (!projectFilter) return sortedAgents;
    return sortedAgents.filter(a => a.boardId && boardProjectMap.get(a.boardId) === projectFilter);
  }, [sortedAgents, projectFilter, boardProjectMap]);

  const filteredAgents = boardFilter
    ? projectScopedAgents.filter(a => a.boardId === boardFilter)
    : projectScopedAgents;

  const selectedAgentData = sortedAgents.find(a => a.id === selectedAgent);

  const handleStopAgent = (agentId) => {
    if (socket) {
      socket.emit(WsEvents.REQ_STOP, { agentId });
    }
  };

  const stats = {
    total: projectScopedAgents.length,
    busy: projectScopedAgents.filter(a => a.status === 'busy' || thinkingMap[a.id]).length,
    idle: projectScopedAgents.filter(a => a.status === 'idle' && !thinkingMap[a.id]).length,
    errors: projectScopedAgents.filter(a => a.status === 'error').length,
    totalTokensIn: projectScopedAgents.reduce((sum, a) => sum + (a.metrics?.totalTokensIn || 0), 0),
    totalTokensOut: projectScopedAgents.reduce((sum, a) => sum + (a.metrics?.totalTokensOut || 0), 0),
  };

  return (
    <div className="h-[100dvh] bg-dark-950 flex flex-col overflow-hidden">
      {/* Impersonation banner */}
      {user?.impersonatedBy && (
        <div className="sticky top-0 z-[60] flex items-center justify-center gap-3 px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-sm">
          <Eye className="w-4 h-4 flex-shrink-0" />
          <span>Impersonating <strong>{user.displayName || user.username}</strong> (by {user.impersonatedBy})</span>
          <button
            onClick={onStopImpersonation}
            className="ml-2 px-3 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded-lg transition-colors"
          >
            Stop Impersonation
          </button>
        </div>
      )}

      {/* Header */}
      <header className="glass border-b border-dark-700 sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative sm:static" ref={mobileMenuRef}>
              <button
                onClick={() => setMobileMenuOpen(prev => !prev)}
                className="sm:pointer-events-none w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20"
              >
                <Menu className="w-5 h-5 text-white sm:hidden" />
                <Zap className="w-5 h-5 text-white hidden sm:block" />
              </button>
              {mobileMenuOpen && (
                <div className="absolute left-0 top-full mt-2 w-56 bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 py-1 sm:hidden">
                  {NAV_VIEWS.map(({ key, label, icon: Icon }) => (
                    <button
                      key={key}
                      onClick={() => { setActiveView(key); setMobileMenuOpen(false); }}
                      className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium transition-colors ${
                        activeView === key
                          ? 'bg-dark-700 text-indigo-400'
                          : 'text-dark-300 hover:bg-dark-700/50 hover:text-dark-100'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </button>
                  ))}
                  {dbProjects.length > 0 && (
                    <div className="border-t border-dark-700 mt-1 pt-2 px-3 pb-2">
                      <label className="block text-[10px] uppercase tracking-wider text-dark-500 mb-1">Project filter</label>
                      <select
                        value={projectFilter}
                        onChange={(e) => setProjectFilter(e.target.value)}
                        className="w-full h-8 px-2 text-sm bg-dark-900 border border-dark-700 rounded text-dark-200 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">All projects</option>
                        {dbProjects.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <h1 className="text-lg font-bold text-dark-100" title={`v${import.meta.env.VITE_APP_VERSION || 'dev'}`}>Pulsar Team</h1>
              <p className="text-xs text-dark-400 -mt-0.5">{projectScopedAgents.length} agents active</p>
            </div>
            <div className="hidden sm:flex items-center border border-dark-700 rounded-lg overflow-hidden ml-2">
              {NAV_VIEWS.map(({ key, label, icon: Icon, title }) => (
                <button
                  key={key}
                  onClick={() => setActiveView(key)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                    activeView === key ? 'bg-dark-700 text-indigo-400' : 'text-dark-400 hover:text-dark-200'
                  }`}
                  title={title}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden md:inline">{label}</span>
                </button>
              ))}
            </div>
            {dbProjects.length > 0 && (
              <div className="hidden sm:flex items-center gap-1.5 ml-2 pl-2 border-l border-dark-700">
                <FolderGit2 className="w-4 h-4 text-purple-400" />
                <select
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  className="h-9 px-2 pr-7 text-sm bg-dark-800 border border-dark-700 rounded-lg text-dark-200 focus:outline-none focus:border-indigo-500 appearance-none cursor-pointer"
                  style={{ backgroundImage: 'none' }}
                  title="Filter content by project"
                >
                  <option value="">All projects</option>
                  {dbProjects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (!showBroadcast) { loadProjects(); loadSkills(); loadMcpServers(); } setShowBroadcast(!showBroadcast); }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                showBroadcast
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'text-dark-300 hover:bg-dark-700 hover:text-dark-100'
              }`}
            >
              <Globe className="w-4 h-4" />
              <span className="hidden sm:inline">Global</span>
            </button>
            <button
              onClick={toggleTheme}
              className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setShowApiKeyModal(true)}
              className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
              title="MCP API Key"
            >
              <Key className="w-4 h-4" />
            </button>
            <div className="ml-2 pl-2 border-l border-dark-700 relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen(prev => !prev)}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-dark-700 transition-colors"
              >
                <span className="text-sm text-dark-300 hidden sm:inline">{user.displayName || user.username}</span>
                {isAdmin && <Crown className="w-3.5 h-3.5 text-red-400" />}
                {user?.role === 'advanced' && <UserCheck className="w-3.5 h-3.5 text-amber-400" />}
                <ChevronDown className={`w-3.5 h-3.5 text-dark-400 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 py-1">
                  {isAdmin && (
                    <button
                      onClick={() => { setShowAdminPanel(true); setUserMenuOpen(false); }}
                      className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-dark-300 hover:bg-dark-700 hover:text-dark-100 transition-colors"
                    >
                      <Settings className="w-4 h-4" />
                      Admin Settings
                    </button>
                  )}
                  <button
                    onClick={() => { onLogout(); setUserMenuOpen(false); }}
                    className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-dark-300 hover:bg-dark-700 hover:text-red-400 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Stats bar — hidden in Workflows view */}
        {activeView !== 'tasks' && <SwarmOverview stats={stats} agents={projectScopedAgents} />}

        {/* Broadcast Panel */}
        {showBroadcast && (
          <Suspense fallback={null}>
            <BroadcastPanel
              agents={sortedAgents}
              skills={skills}
              mcpServers={mcpServers}
              socket={socket}
              onClose={() => setShowBroadcast(false)}
              onRefresh={onRefresh}
              user={user}
            />
          </Suspense>
        )}

        {/* Main content */}
        <div className="flex-1 flex max-w-[1800px] mx-auto w-full min-h-0 overflow-hidden">
          {activeView === 'tasks' && (
            <Suspense fallback={null}>
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <TasksBoard
                  agents={projectScopedAgents}
                  onRefresh={onRefresh}
                  user={user}
                  onNavigateToAgent={handleNavigateToAgent}
                  onBoardChange={setBoardFilter}
                  projectFilter={projectFilter}
                />
              </div>
            </Suspense>
          )}
          {activeView === 'projects' && (
            <Suspense fallback={null}>
              <div className="flex-1 min-h-0 flex flex-col overflow-auto p-4 sm:p-6">
                <ProjectsView
                  agents={projectScopedAgents}
                  onRefresh={onRefresh}
                  projectFilter={projectFilter}
                />
              </div>
            </Suspense>
          )}
          {activeView === 'budget' && (
            <Suspense fallback={null}>
              <div className="flex-1 min-h-0 flex flex-col overflow-auto">
                <BudgetDashboard agents={projectScopedAgents} />
              </div>
            </Suspense>
          )}
          {/* Agent list */}
          {activeView === 'agents' && (
            <div className={`flex-1 p-4 sm:p-6 overflow-auto ${selectedAgentData ? 'hidden lg:block lg:w-1/2 xl:w-3/5' : ''}`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-dark-200">
                    Agents
                    <span className="ml-2 text-sm font-normal text-dark-400">({filteredAgents.length}{boardFilter ? `/${sortedAgents.length}` : ''})</span>
                  </h2>
                  {boards.length > 1 && (
                    <select
                      value={boardFilter}
                      onChange={(e) => setBoardFilter(e.target.value)}
                      className="h-9 px-2 pr-7 text-sm bg-dark-800 border border-dark-700 rounded-lg text-dark-200 focus:outline-none focus:border-indigo-500 appearance-none"
                      style={{ backgroundImage: 'none' }}
                    >
                      <option value="">All boards</option>
                      {boards.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="hidden sm:flex items-center border border-dark-700 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setViewMode('grid')}
                      className={`p-2 transition-colors ${viewMode === 'grid' ? 'bg-dark-700 text-indigo-400' : 'text-dark-400 hover:text-dark-200'}`}
                    >
                      <LayoutGrid className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setViewMode('list')}
                      className={`p-2 transition-colors ${viewMode === 'list' ? 'bg-dark-700 text-indigo-400' : 'text-dark-400 hover:text-dark-200'}`}
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>
                  {!isBasic && (
                    <button
                      onClick={() => { loadTemplates(); loadProjects(); setShowAddModal(true); }}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20"
                    >
                      <Plus className="w-4 h-4" />
                      Add Agent
                    </button>
                  )}
                </div>
              </div>

              {filteredAgents.length === 0 ? (
                <div className="text-center py-20">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-dark-800 flex items-center justify-center">
                    <MessageSquare className="w-8 h-8 text-dark-500" />
                  </div>
                  <h3 className="text-dark-300 font-medium mb-1">{boardFilter ? 'No agents in this board' : 'No agents yet'}</h3>
                  <p className="text-dark-500 text-sm mb-4">{boardFilter ? 'Try selecting a different board' : isBasic ? 'No agents are available for you' : 'Create your first agent to get started'}</p>
                  {!isBasic && !boardFilter && (
                    <button
                      onClick={() => { loadTemplates(); loadProjects(); setShowAddModal(true); }}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Add Agent
                    </button>
                  )}
                </div>
              ) : (
                <div className={
                  viewMode === 'grid'
                    ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4'
                    : 'space-y-3'
                }>
                  {(() => {
                    // Group agents that share a batchId into a single rendered card.
                    // Standalone agents (batchId == null) render normally. Order is
                    // preserved using the first occurrence of each batch in the list.
                    const groups: Array<{ key: string; isBatch: boolean; members: any[] }> = [];
                    const byBatch = new Map<string, number>();
                    for (const a of filteredAgents) {
                      if (a.batchId) {
                        const idx = byBatch.get(a.batchId);
                        if (idx === undefined) {
                          byBatch.set(a.batchId, groups.length);
                          groups.push({ key: a.batchId, isBatch: true, members: [a] });
                        } else {
                          groups[idx].members.push(a);
                        }
                      } else {
                        groups.push({ key: a.id, isBatch: false, members: [a] });
                      }
                    }
                    return groups.map(g => {
                      if (g.isBatch && g.members.length > 1) {
                        return (
                          <BatchAgentCard
                            key={g.key}
                            members={g.members}
                            thinkingMap={thinkingMap}
                            selectedAgentId={selectedAgent}
                            viewMode={viewMode}
                            onSelect={(id) => setSelectedAgent(id === selectedAgent ? null : id)}
                            onStop={handleStopAgent}
                          />
                        );
                      }
                      const agent = g.members[0];
                      return (
                        <AgentCard
                          key={agent.id}
                          agent={agent}
                          thinking={thinkingMap[agent.id]}
                          isSelected={selectedAgent === agent.id}
                          viewMode={viewMode}
                          onClick={() => setSelectedAgent(agent.id === selectedAgent ? null : agent.id)}
                          onStop={handleStopAgent}
                        />
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Agent detail panel */}
          {activeView === 'agents' && selectedAgentData && (
            <div className="lg:w-1/2 xl:w-2/5 border-l border-dark-700 bg-dark-900/50 min-h-0 overflow-hidden">
              <AgentDetail
                key={selectedAgentData.id}
                agent={selectedAgentData}
                agents={sortedAgents}
                projects={projects}
                skills={skills}
                thinking={thinkingMap[selectedAgentData.id]}
                streamBuffer={streamBuffers[selectedAgentData.id]}
                socket={socket}
                onClose={() => setSelectedAgent(null)}
                onSelectAgent={setSelectedAgent}
                onRefresh={onRefresh}
                onActiveTabChange={setDetailActiveTab}
                requestedTab={requestedTab}
                userRole={user?.role}
                currentUser={user}
                showToast={showToast}
              />
            </div>
          )}
        </div>
      </div>

      {/* Add Agent Modal */}
      {showAddModal && (
        <Suspense fallback={null}>
          <AddAgentModal
            templates={templates}
            projects={projects}
            initialBoardId={boardFilter}
            onClose={() => setShowAddModal(false)}
            onCreated={(agent) => {
              setShowAddModal(false);
              if (onAgentCreated) onAgentCreated(agent);
              setSelectedAgent(agent.id);
            }}
          />
        </Suspense>
      )}

      {/* API Key Modal */}
      {showApiKeyModal && (
        <ApiKeyModal
          onClose={() => setShowApiKeyModal(false)}
          showToast={showToast}
        />
      )}

      {/* Voice session floating indicator */}
      <ActiveVoiceIndicator
        agents={sortedAgents}
        selectedAgentId={selectedAgent}
        activeTab={detailActiveTab}
        onNavigateToAgent={handleNavigateToVoiceAgent}
      />

      {/* Admin Panel */}
      {showAdminPanel && (
        <Suspense fallback={null}>
          <AdminPanel
            onClose={() => setShowAdminPanel(false)}
            onImpersonate={onImpersonate}
            showToast={showToast}
          />
        </Suspense>
      )}
    </div>
  );
}
