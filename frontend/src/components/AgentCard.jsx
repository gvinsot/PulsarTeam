import { MessageSquare, Clock, Cpu, Zap, FolderOpen, Crown, StopCircle } from 'lucide-react';

const STATUS_STYLES = {
  idle: { dot: 'bg-emerald-500', label: 'Idle', textColor: 'text-emerald-400' },
  busy: { dot: 'bg-amber-500 animate-pulse', label: 'Working...', textColor: 'text-amber-400' },
  error: { dot: 'bg-red-500', label: 'Error', textColor: 'text-red-400' },
};

export default function AgentCard({ agent, thinking, isSelected, viewMode, onClick, onStop }) {
  const effectiveStatus = thinking ? 'busy' : agent.status;
  const status = STATUS_STYLES[effectiveStatus] || STATUS_STYLES.idle;
  const truncatedThinking = thinking ? thinking.slice(-120) + (thinking.length > 120 ? '' : '') : null;
  const disabled = agent.enabled === false;

  if (viewMode === 'list') {
    return (
      <div
        onClick={onClick}
        className={`flex items-center gap-4 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 border ${
          disabled ? 'opacity-50' : ''
        } ${
          isSelected
            ? 'bg-indigo-500/10 border-indigo-500/40'
            : 'bg-dark-800/50 border-dark-700/50 hover:bg-dark-800 hover:border-dark-600'
        }`}
      >
        <div className="text-2xl flex-shrink-0">{agent.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-dark-100 truncate">{agent.name}</span>
            {agent.isLeader && <Crown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" title="Leader" />}
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${status.dot}`} />
          </div>
          <p className="text-xs text-dark-400 truncate">{agent.role} · {agent.provider}/{agent.model}</p>
          {agent.project && (
            <p className="text-xs text-indigo-400 truncate flex items-center gap-1">
              <FolderOpen className="w-3 h-3" />
              {agent.project}
            </p>
          )}
        </div>
        {thinking && (
          <div className="hidden sm:block text-xs text-dark-400 truncate max-w-[200px] font-mono">
            {truncatedThinking}
          </div>
        )}
        <div className="flex items-center gap-3 flex-shrink-0 text-xs text-dark-400">
          <span className="flex items-center gap-1">
            <MessageSquare className="w-3 h-3" />
            {agent.metrics?.totalMessages || 0}
          </span>
          {disabled ? (
            <span className="text-dark-500">Disabled</span>
          ) : effectiveStatus === 'busy' && onStop ? (
            <button
              onClick={(e) => { e.stopPropagation(); onStop(agent.id); }}
              className="flex items-center gap-1 px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
              title="Stop agent"
            >
              <StopCircle className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
          ) : (
            <span className={status.textColor}>{status.label}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      className={`rounded-xl cursor-pointer transition-all duration-200 border overflow-hidden group ${
        disabled ? 'opacity-50' : ''
      } ${
        isSelected
          ? 'bg-indigo-500/10 border-indigo-500/40 shadow-lg shadow-indigo-500/10'
          : 'bg-dark-800/50 border-dark-700/50 hover:bg-dark-800 hover:border-dark-600 hover:shadow-lg hover:shadow-black/20'
      }`}
    >
      {/* Color accent bar */}
      <div className="h-1" style={{ backgroundColor: agent.color }} />

      <div className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="text-2xl p-2 rounded-lg bg-dark-700/50">{agent.icon}</div>
            <div>
              <h3 className="font-semibold text-dark-100 text-sm">{agent.name}</h3>
              <p className="text-xs text-dark-400 capitalize">{agent.role}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {agent.isLeader && <Crown className="w-3.5 h-3.5 text-amber-400" title="Leader" />}
            {disabled ? (
              <span className="text-xs font-medium text-dark-500">Disabled</span>
            ) : effectiveStatus === 'busy' && onStop ? (
              <button
                onClick={(e) => { e.stopPropagation(); onStop(agent.id); }}
                className="flex items-center gap-1 px-2 py-0.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors text-xs"
                title="Stop agent"
              >
                <StopCircle className="w-3 h-3" />
                Stop
              </button>
            ) : (
              <>
                <div className={`w-2 h-2 rounded-full ${status.dot}`} />
                <span className={`text-xs font-medium ${status.textColor}`}>{status.label}</span>
              </>
            )}
          </div>
        </div>

        {/* Provider info */}
        <div className="flex items-center gap-2 mb-3 text-xs">
          <span className={`px-2 py-0.5 rounded-full ${
            agent.provider === 'claude'
              ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
              : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
          }`}>
            {agent.provider}
          </span>
          <span className="text-dark-400 truncate font-mono text-[11px]">{agent.model}</span>
          {agent.project && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 truncate">
              <FolderOpen className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{agent.project}</span>
            </span>
          )}
        </div>

        {/* Thinking/streaming indicator */}
        {thinking && (
          <div className="mb-3 p-2 rounded-lg bg-dark-900/80 border border-dark-600/50 animate-fadeIn">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              <span className="text-[11px] text-amber-400 font-medium">Thinking...</span>
            </div>
            <p className="text-[11px] text-dark-300 font-mono leading-relaxed line-clamp-2">
              {truncatedThinking}
            </p>
          </div>
        )}

        {/* Description */}
        {agent.description && (
          <p className="text-xs text-dark-400 line-clamp-2 mb-3">{agent.description}</p>
        )}

        {/* Metrics bar */}
        <div className="flex items-center justify-between text-[11px] text-dark-400 pt-2 border-t border-dark-700/50">
          <span className="flex items-center gap-1">
            <MessageSquare className="w-3 h-3" />
            {agent.metrics?.totalMessages || 0} msgs
          </span>
          <span className="flex items-center gap-1">
            <Zap className="w-3 h-3" />
            {formatTokens(agent.metrics?.totalTokensIn || 0, agent.metrics?.totalTokensOut || 0)}
          </span>
          <span className="flex items-center gap-1">
            <Cpu className="w-3 h-3" />
            {agent.todoList?.filter(t => t.status !== 'done').length || 0} tasks
          </span>
        </div>
      </div>
    </div>
  );
}

function formatTokens(inp, out) {
  const total = inp + out;
  if (total >= 1000000) return (total / 1000000).toFixed(1) + 'M';
  if (total >= 1000) return (total / 1000).toFixed(1) + 'K';
  return total + ' tok';
}
