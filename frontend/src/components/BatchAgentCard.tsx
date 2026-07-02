import { useState, useEffect, useMemo } from 'react';
import { Users, ChevronDown } from 'lucide-react';
import AgentCard from './AgentCard';

/**
 * Wraps an AgentCard for a group of agents that share the same batchId.
 * Renders a single card representing one selected member, with a dropdown
 * to switch which member is shown / opened in the side panel. Per-agent
 * data (status, thinking, tasks) is still pulled from the individual
 * agent that the dropdown has selected, so the card stays live.
 */
export default function BatchAgentCard({
  members,
  thinkingMap,
  selectedAgentId,
  viewMode,
  onSelect,
  onStop,
}) {
  const sorted = useMemo(
    () => [...members].sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0)),
    [members]
  );

  // Default to whichever member is currently selected in the parent (if any),
  // otherwise to the first one. This keeps the dropdown in sync when the
  // user clicks a specific member elsewhere.
  const [activeId, setActiveId] = useState(() => {
    if (selectedAgentId && sorted.some(a => a.id === selectedAgentId)) return selectedAgentId;
    return sorted[0]?.id;
  });

  useEffect(() => {
    if (selectedAgentId && sorted.some(a => a.id === selectedAgentId) && selectedAgentId !== activeId) {
      setActiveId(selectedAgentId);
    }
  }, [selectedAgentId, sorted]);

  const active = sorted.find(a => a.id === activeId) || sorted[0];
  if (!active) return null;

  const busyCount = sorted.filter(a => a.status === 'busy' || thinkingMap?.[a.id]).length;
  const errorCount = sorted.filter(a => a.status === 'error').length;
  const baseName = active.name.replace(/\s+#\d+$/, '');

  // Member switcher lives in the card's reserved footer slot (not an absolute
  // overlay) so it never covers the metrics row underneath.
  const memberFooter = (
    <div
      className="flex items-center justify-between gap-2 w-full pt-2 border-t border-dark-700/50"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        className="flex items-center gap-1 text-[10px] font-medium text-indigo-300"
        title={`${sorted.length} agents in batch — ${busyCount} busy, ${errorCount} error`}
      >
        <Users className="w-3 h-3" />
        {sorted.length} members
        {busyCount > 0 && <span className="text-amber-300">· {busyCount} busy</span>}
        {errorCount > 0 && <span className="text-red-300">· {errorCount} err</span>}
      </span>
      <div className="relative flex-shrink-0">
        <select
          value={activeId}
          onChange={(e) => {
            const id = e.target.value;
            setActiveId(id);
            onSelect(id);
          }}
          className="appearance-none pl-2 pr-7 py-1 bg-dark-900/80 border border-dark-600 rounded-md text-[11px] text-dark-200 hover:border-indigo-500/40 focus:outline-none focus:border-indigo-500 cursor-pointer"
          title={`Batch "${baseName}" — ${sorted.length} members`}
        >
          {sorted.map(m => (
            <option key={m.id} value={m.id}>
              #{m.batchIndex ?? '?'} {m.status === 'busy' || thinkingMap?.[m.id] ? '· busy' : m.status === 'error' ? '· err' : ''}
            </option>
          ))}
        </select>
        <ChevronDown className="w-3 h-3 absolute right-1.5 top-1/2 -translate-y-1/2 text-dark-400 pointer-events-none" />
      </div>
    </div>
  );

  return (
    <AgentCard
      agent={active}
      thinking={thinkingMap?.[active.id]}
      isSelected={selectedAgentId === active.id}
      viewMode={viewMode}
      onClick={() => onSelect(active.id)}
      onStop={onStop}
      emphasizedBorder
      footer={memberFooter}
    />
  );
}
