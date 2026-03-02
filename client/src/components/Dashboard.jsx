import { useState } from 'react';
import AddAgentModal from './AddAgentModal';
import AgentDetail from './AgentDetail';
import GlobalControlPanelModal from './GlobalControlPanelModal';

export default function Dashboard({
  user,
  agents,
  templates,
  projects,
  skills,
  mcpServers,
  thinkingMap,
  streamBuffers,
  onLogout,
  onRefresh,
  socket,
  showToast
}) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [showGlobalControl, setShowGlobalControl] = useState(false);

  return (
    <div className="min-h-screen bg-dark-950 text-dark-100">
      <header className="border-b border-dark-800 bg-dark-900/80 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Agent Swarm UI</h1>
            <p className="text-sm text-dark-400">Welcome, {user?.username}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowGlobalControl(true)}
              className="px-3 py-2 rounded-lg border border-dark-700 hover:bg-dark-800 text-sm"
            >
              Global Plugins Control
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm"
            >
              Add Agent
            </button>
            <button
              onClick={onRefresh}
              className="px-3 py-2 rounded-lg border border-dark-700 hover:bg-dark-800 text-sm"
            >
              Refresh
            </button>
            <button
              onClick={onLogout}
              className="px-3 py-2 rounded-lg border border-dark-700 hover:bg-dark-800 text-sm"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setSelectedAgent(agent)}
              className="text-left p-4 rounded-xl border border-dark-800 bg-dark-900 hover:bg-dark-800"
            >
              <div className="font-medium">{agent.name}</div>
              <div className="text-sm text-dark-400">{agent.role}</div>
              <div className="text-xs mt-2 text-dark-500">Status: {agent.status || 'idle'}</div>
            </button>
          ))}
        </div>
      </main>

      {showAddModal && (
        <AddAgentModal
          isOpen={showAddModal}
          onClose={() => setShowAddModal(false)}
          templates={templates}
          projects={projects}
          skills={skills}
          mcpServers={mcpServers}
          onCreated={onRefresh}
          showToast={showToast}
        />
      )}

      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          skills={skills}
          mcpServers={mcpServers}
          thinking={thinkingMap[selectedAgent.id]}
          streamBuffer={streamBuffers[selectedAgent.id]}
          socket={socket}
          onRefresh={onRefresh}
          showToast={showToast}
        />
      )}

      <GlobalControlPanelModal
        isOpen={showGlobalControl}
        onClose={() => setShowGlobalControl(false)}
      />
    </div>
  );
}