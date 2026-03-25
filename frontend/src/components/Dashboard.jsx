import { useState, useCallback, useEffect, useRef } from 'react';
import {
  LogOut, Plus, Globe, LayoutGrid, List,
  Zap, Settings, MessageSquare, Key, Users, KanbanSquare, Tag, Menu, DollarSign
} from 'lucide-react';
import AgentCard from './AgentCard';
import AgentDetail from './AgentDetail';
import AddAgentModal from './AddAgentModal';
import BroadcastPanel from './BroadcastPanel';
import SwarmOverview from './SwarmOverview';
import ActiveVoiceIndicator from './ActiveVoiceIndicator';
import ApiKeyModal from './ApiKeyModal';
import TasksBoard from './TasksBoard';
import ProjectsView from './ProjectsView';
import BudgetDashboard from './BudgetDashboard';

export default function Dashboard({
  user, agents, templates, projects, skills, mcpServers, projectContexts, thinkingMap, streamBuffers,
  onLogout, onRefresh, socket, showToast
}) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [viewMode, setViewMode] = useState('grid'); // grid | list
  const [activeView, setActiveViewRaw] = useState(() => {
    const hash = window.location.hash.replace('#', '').toLowerCase();
    return ['agents', 'tasks', 'projects', 'budget', 'about'].includes(hash) ? hash : 'agents';
  });
  const setActiveView = useCallback((view) => {
    setActiveViewRaw(view);
    window.history.replaceState(null, '', `#${view}`);
  }, []);
  const [detailActiveTab, setDetailActiveTab] = useState('chat');
  const [requestedTab, setRequestedTab] = useState(null);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef(null);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace('#', '').toLowerCase();
      if (['agents', 'tasks', 'projects', 'budget', 'about'].includes(hash)) setActiveViewRaw(hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleClickOutside = (e) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target)) {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mobileMenuOpen]);

  const handleNavigateToVoiceAgent = useCallback((agentId) => {
    setSelectedAgent(agentId);
    setRequestedTab('chat');
    // Clear requestedTab after it's consumed
    setTimeout(() => setRequestedTab(null), 100);
  }, []);

  // Sort agents with 'Swarm Leaders' role first
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.role === 'Swarm Leaders' && b.role !== 'Swarm Leaders') return -1;
    if (a.role !== 'Swarm Leaders' && b.role === 'Swarm Leaders') return 1;
    return 0;
  });

  const selectedAgentData = sortedAgents.find(a => a.id === selectedAgent);

  const handleStopAgent = (agentId) => {
    if (socket) {
      socket.emit('agent:stop', { agentId });
    }
  };

  const stats = {
    total: sortedAgents.length,
    busy: sortedAgents.filter(a => a.status === 'busy' || thinkingMap[a.id]).length,
    idle: sortedAgents.filter(a => a.status === 'idle' && !thinkingMap[a.id]).length,
    errors: sortedAgents.filter(a => a.status === 'error').length,
    totalTokensIn: sortedAgents.reduce((sum, a) => sum + (a.metrics?.totalTokensIn || 0), 0),
    totalTokensOut: sortedAgents.reduce((sum, a) => sum + (a.metrics?.totalTokensOut || 0), 0),
    totalMessages: sortedAgents.reduce((sum, a) => sum + (a.metrics?.totalMessages || 0), 0),
  };

  return (
    <div className="min-h-screen bg-dark-950 flex flex-col">
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
                <div className="absolute left-0 top-full mt-2 w-48 bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-50 py-1 sm:hidden">
                  {[
                    { key: 'agents', label: 'Agents', icon: Users },
                    { key: 'tasks', label: 'Tasks', icon: KanbanSquare },
                    { key: 'projects', label: 'Projects', icon: Tag },
                    { key: 'budget', label: 'Budget', icon: DollarSign },
                  ].map(({ key, label, icon: Icon }) => (
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
                </div>
              )}
            </div>
            <div>
              <h1 className="text-lg font-bold text-dark-100" title={`v${import.meta.env.VITE_APP_VERSION || 'dev'}`}>Pulsar Team</h1>
              <p className="text-xs text-dark-400 -mt-0.5">{sortedAgents.length} agents active</p>
            </div>
            <div className="hidden sm:flex items-center border border-dark-700 rounded-lg overflow-hidden ml-2">
              <button
                onClick={() => setActiveView('agents')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                  activeView === 'agents' ? 'bg-dark-700 text-indigo-400' : 'text-dark-400 hover:text-dark-200'
                }`}
                title="Agents view"
              >
                <Users className="w-4 h-4" />
                <span className="hidden md:inline">Agents</span>
              </button>
              <button
                onClick={() => setActiveView('tasks')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                  activeView === 'tasks' ? 'bg-dark-700 text-indigo-400' : 'text-dark-400 hover:text-dark-200'
                }`}
                title="Tasks board"
              >
                <KanbanSquare className="w-4 h-4" />
                <span className="hidden md:inline">Tasks</span>
              </button>
              <button
                onClick={() => setActiveView('projects')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                  activeView === 'projects' ? 'bg-dark-700 text-indigo-400' : 'text-dark-400 hover:text-dark-200'
                }`}
                title="Projects"
              >
                <Tag className="w-4 h-4" />
                <span className="hidden md:inline">Projects</span>
              </button>
              <button
                onClick={() => setActiveView('budget')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                  activeView === 'budget' ? 'bg-dark-700 text-indigo-400' : 'text-dark-400 hover:text-dark-200'
                }`}
                title="Budget"
              >
                <DollarSign className="w-4 h-4" />
                <span className="hidden md:inline">Budget</span>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowBroadcast(!showBroadcast)}
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
              onClick={() => setShowApiKeyModal(true)}
              className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
              title="MCP API Key"
            >
              <Key className="w-4 h-4" />
            </button>
            <div className="ml-2 pl-2 border-l border-dark-700 flex items-center gap-2">
              <span className="text-sm text-dark-400 hidden sm:inline">{user.username}</span>
              <button
                onClick={onLogout}
                className="p-2 text-dark-400 hover:text-red-400 hover:bg-dark-700 rounded-lg transition-colors"
                title="Logout"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex flex-col">
        {/* Stats bar */}
        <SwarmOverview stats={stats} agents={sortedAgents} />

        {/* Broadcast Panel */}
        {showBroadcast && (
          <BroadcastPanel
            agents={sortedAgents}
            projects={projects}
            skills={skills}
            mcpServers={mcpServers}
            socket={socket}
            onClose={() => setShowBroadcast(false)}
            onRefresh={onRefresh}
          />
        )}

        {/* Main content */}
        <div className="flex-1 flex max-w-[1800px] mx-auto w-full min-h-0">
          {activeView === 'tasks' && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <TasksBoard agents={sortedAgents} onRefresh={onRefresh} />
            </div>
          )}
          {activeView === 'projects' && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <ProjectsView
                agents={sortedAgents}
                projectContexts={projectContexts || []}
                onRefresh={onRefresh}
              />
            </div>
          )}
          {activeView === 'budget' && (
            <div className="flex-1 min-h-0 flex flex-col overflow-auto">
              <BudgetDashboard agents={sortedAgents} />
            </div>
          )}
          {/* Agent list */}
          {activeView === 'agents' && (
            <div className={`flex-1 p-4 sm:p-6 overflow-auto ${selectedAgentData ? 'hidden lg:block lg:w-1/2 xl:w-3/5' : ''}`}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-dark-200">
                  Agents
                  <span className="ml-2 text-sm font-normal text-dark-400">({sortedAgents.length})</span>
                </h2>
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
                  <button
                    onClick={() => setShowAddModal(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20"
                  >
                    <Plus className="w-4 h-4" />
                    Add Agent
                  </button>
                </div>
              </div>

              {sortedAgents.length === 0 ? (
                <div className="text-center py-20">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-dark-800 flex items-center justify-center">
                    <MessageSquare className="w-8 h-8 text-dark-500" />
                  </div>
                  <h3 className="text-dark-300 font-medium mb-1">No agents yet</h3>
                  <p className="text-dark-500 text-sm mb-4">Create your first agent to get started</p>
                  <button
                    onClick={() => setShowAddModal(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add Agent
                  </button>
                </div>
              ) : (
                <div className={
                  viewMode === 'grid'
                    ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4'
                    : 'space-y-3'
                }>
                  {sortedAgents.map(agent => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      thinking={thinkingMap[agent.id]}
                      isSelected={selectedAgent === agent.id}
                      viewMode={viewMode}
                      onClick={() => setSelectedAgent(agent.id === selectedAgent ? null : agent.id)}
                      onStop={handleStopAgent}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Agent detail panel */}
          {activeView === 'agents' && selectedAgentData && (
            <div className="lg:w-1/2 xl:w-2/5 border-l border-dark-700 bg-dark-900/50 overflow-auto">
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
              />
            </div>
          )}
        </div>
      </div>

      {/* Add Agent Modal */}
      {showAddModal && (
        <AddAgentModal
          templates={templates}
          projects={projects}
          agents={agents}
          onClose={() => setShowAddModal(false)}
          onCreated={(agent) => {
            setShowAddModal(false);
            setSelectedAgent(agent.id);
          }}
        />
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
    </div>
  );
}