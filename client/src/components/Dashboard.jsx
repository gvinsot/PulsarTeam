import { useState } from 'react';
import {
  LogOut, Plus, Radio, LayoutGrid, List,
  RefreshCw, Zap, Settings, MessageSquare
} from 'lucide-react';
import AgentCard from './AgentCard';
import AgentDetail from './AgentDetail';
import AddAgentModal from './AddAgentModal';
import BroadcastPanel from './BroadcastPanel';
import SwarmOverview from './SwarmOverview';

export default function Dashboard({
  user, agents, templates, projects, skills, thinkingMap, streamBuffers,
  onLogout, onRefresh, socket, showToast
}) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [viewMode, setViewMode] = useState('grid'); // grid | list

  const selectedAgentData = agents.find(a => a.id === selectedAgent);

  const handleStopAgent = (agentId) => {
    if (socket) {
      socket.emit('agent:stop', { agentId });
    }
  };

  const stats = {
    total: agents.length,
    busy: agents.filter(a => a.status === 'busy').length,
    idle: agents.filter(a => a.status === 'idle').length,
    errors: agents.filter(a => a.status === 'error').length,
    totalTokensIn: agents.reduce((sum, a) => sum + (a.metrics?.totalTokensIn || 0), 0),
    totalTokensOut: agents.reduce((sum, a) => sum + (a.metrics?.totalTokensOut || 0), 0),
    totalMessages: agents.reduce((sum, a) => sum + (a.metrics?.totalMessages || 0), 0),
  };

  return (
    <div className="min-h-screen bg-dark-950 flex flex-col">
      {/* Header */}
      <header className="glass border-b border-dark-700 sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-dark-100">Agent Swarm</h1>
              <p className="text-xs text-dark-400 -mt-0.5">{agents.length} agents active</p>
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
              <Radio className="w-4 h-4" />
              <span className="hidden sm:inline">Broadcast</span>
            </button>
            <button
              onClick={onRefresh}
              className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <div className="hidden sm:flex items-center border border-dark-700 rounded-lg overflow-hidden ml-1">
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
        <SwarmOverview stats={stats} agents={agents} />

        {/* Broadcast Panel */}
        {showBroadcast && (
          <BroadcastPanel
            agents={agents}
            projects={projects}
            skills={skills}
            socket={socket}
            onClose={() => setShowBroadcast(false)}
            onRefresh={onRefresh}
          />
        )}

        {/* Main content */}
        <div className="flex-1 flex max-w-[1800px] mx-auto w-full">
          {/* Agent list */}
          <div className={`flex-1 p-4 sm:p-6 overflow-auto ${selectedAgentData ? 'hidden lg:block lg:w-1/2 xl:w-3/5' : ''}`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-dark-200">
                Agents
                <span className="ml-2 text-sm font-normal text-dark-400">({agents.length})</span>
              </h2>
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20"
              >
                <Plus className="w-4 h-4" />
                Add Agent
              </button>
            </div>

            {agents.length === 0 ? (
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
                {agents.map(agent => (
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

          {/* Agent detail panel */}
          {selectedAgentData && (
            <div className="lg:w-1/2 xl:w-2/5 border-l border-dark-700 bg-dark-900/50 overflow-auto">
              <AgentDetail
                key={selectedAgentData.id}
                agent={selectedAgentData}
                agents={agents}
                projects={projects}
                skills={skills}
                thinking={thinkingMap[selectedAgentData.id]}
                streamBuffer={streamBuffers[selectedAgentData.id]}
                socket={socket}
                onClose={() => setSelectedAgent(null)}
                onRefresh={onRefresh}
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
          onClose={() => setShowAddModal(false)}
          onCreated={(agent) => {
            setShowAddModal(false);
            setSelectedAgent(agent.id);
          }}
        />
      )}
    </div>
  );
}
