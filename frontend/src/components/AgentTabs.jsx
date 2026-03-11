export default function AgentTabs({ agents, activeAgentId, onChange, voiceConnected }) {
  return (
    <div className="rounded-lg border border-slate-800 p-2">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-slate-300">Agents</span>
        {voiceConnected ? (
          <span className="text-xs text-emerald-400">Voice session active</span>
        ) : (
          <span className="text-xs text-slate-500">Voice disconnected</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {agents.map((agent) => {
          const active = agent.id === activeAgentId;
          return (
            <button
              key={agent.id}
              onClick={() => onChange(agent.id)}
              className={`rounded px-3 py-1 text-sm ${
                active ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'
              }`}
            >
              {agent.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}