import { Mic, PhoneOff, MicOff } from 'lucide-react';
import { useVoiceSession, STATUS } from '../contexts/VoiceSessionContext';
import type { Agent } from '../types';

interface ActiveVoiceIndicatorProps {
  agents: Agent[];
  selectedAgentId?: string | null;
  /** The AgentDetail tab currently open, so the pill hides on the voice agent's chat. */
  activeTab?: string;
  onNavigateToAgent: (agentId: string) => void;
}

export default function ActiveVoiceIndicator({
  agents,
  selectedAgentId,
  activeTab,
  onNavigateToAgent,
}: ActiveVoiceIndicatorProps) {
  const { status, activeAgentId, isActive, disconnect, muted } = useVoiceSession();

  if (!isActive) return null;

  // Don't show if user is already viewing this agent's chat tab
  const isViewingVoiceAgent = selectedAgentId === activeAgentId && activeTab === 'chat';
  if (isViewingVoiceAgent) return null;

  const agent = agents.find(a => a.id === activeAgentId);
  if (!agent) return null;

  const statusColor =
    status === STATUS.LISTENING
      ? 'bg-emerald-500'
      : status === STATUS.SPEAKING
        ? 'bg-indigo-500'
        : status === STATUS.DELEGATING
          ? 'bg-amber-500'
          : 'bg-emerald-500';

  const statusText =
    status === STATUS.LISTENING
      ? 'Listening'
      : status === STATUS.SPEAKING
        ? 'Speaking'
        : status === STATUS.DELEGATING
          ? 'Delegating'
          : 'Connected';

  return (
    <div className="fixed bottom-6 left-6 z-[90] flex items-center gap-2">
      {/* Main pill — click to navigate. `agent` was located by `a.id === activeAgentId`,
          so agent.id IS activeAgentId, without the context's nullable typing. */}

      <button
        onClick={() => onNavigateToAgent(agent.id)}
        className="flex items-center gap-3 px-4 py-2.5 bg-dark-800/95 backdrop-blur-sm border border-dark-600 rounded-full shadow-xl hover:bg-dark-700 transition-colors group"
      >
        {/* Pulsing dot */}
        <span className="relative flex h-3 w-3">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${statusColor} opacity-75`}
          />
          <span className={`relative inline-flex rounded-full h-3 w-3 ${statusColor}`} />
        </span>

        {/* Agent info */}
        <div className="flex items-center gap-2">
          {muted ? (
            <MicOff className="w-4 h-4 text-red-400" />
          ) : (
            <Mic className="w-4 h-4 text-dark-300 group-hover:text-dark-100" />
          )}
          <span className="text-sm font-medium text-dark-200 group-hover:text-dark-100 max-w-[150px] truncate">
            {agent.name}
          </span>
          <span className="text-xs text-dark-400">{statusText}</span>
        </div>
      </button>

      {/* End session button */}
      <button
        onClick={disconnect}
        className="p-2 bg-dark-800/95 backdrop-blur-sm border border-dark-600 rounded-full shadow-xl hover:bg-red-500/20 hover:border-red-500/30 transition-colors group"
        title="End voice session"
      >
        <PhoneOff className="w-4 h-4 text-dark-400 group-hover:text-red-400" />
      </button>
    </div>
  );
}
