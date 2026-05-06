import { useEffect, useRef } from 'react';
import {
  X, ArrowRight, Edit3, User, XCircle, Pause, Clock,
  RotateCcw, MessageSquare, Zap,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDate, timeAgo } from './taskConstants';

const MODE_LABELS = { execute: 'Execution', refine: 'Refine', decide: 'Decide', title: 'Title', set_type: 'Set Type' };
const MODE_COLORS = { execute: 'text-blue-300', refine: 'text-violet-300', decide: 'text-amber-300', title: 'text-teal-300', set_type: 'text-pink-300' };

const FIELD_LABELS = {
  title: 'Title',
  text: 'Description',
  project: 'Project',
  taskType: 'Type',
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  isManual: 'Manual mode',
};

function DiffBlock({ label, oldVal, newVal }: { label: string; oldVal?: string; newVal?: string }) {
  return (
    <div className="space-y-2">
      <span className="text-xs font-semibold text-dark-400 uppercase tracking-wide">{label}</span>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3">
          <div className="text-[10px] text-red-400 font-semibold mb-1 uppercase tracking-wider">Before</div>
          <div className="text-xs text-dark-300 whitespace-pre-wrap break-words">
            {oldVal || <span className="italic text-dark-500">empty</span>}
          </div>
        </div>
        <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-3">
          <div className="text-[10px] text-emerald-400 font-semibold mb-1 uppercase tracking-wider">After</div>
          <div className="text-xs text-dark-300 whitespace-pre-wrap break-words">
            {newVal || <span className="italic text-dark-500">empty</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderEntryIcon(entry: any) {
  if (entry.type === 'execution') return <MessageSquare className="w-5 h-5 text-blue-400" />;
  if (entry.type === 'edit') return <Edit3 className="w-5 h-5 text-amber-400" />;
  if (entry.type === 'reassign') return <User className="w-5 h-5 text-indigo-400" />;
  if (entry.type === 'error') return <XCircle className="w-5 h-5 text-red-400" />;
  if (entry.type === 'stopped') return <Pause className="w-5 h-5 text-yellow-400" />;
  if (entry.type === 'restored') return <RotateCcw className="w-5 h-5 text-teal-400" />;
  return <ArrowRight className="w-5 h-5 text-dark-400" />;
}

function renderEntryTitle(entry: any) {
  if (entry.type === 'execution') {
    const modeKey = entry.mode || 'execute';
    const modeLabel = MODE_LABELS[modeKey] || 'Execution';
    return (
      <span className={entry.success ? (MODE_COLORS[modeKey] || 'text-blue-300') : 'text-red-300'}>
        {modeLabel} {entry.success ? '— Success' : '— Failed'}
      </span>
    );
  }
  if (entry.type === 'edit') return <span className="text-amber-300">Field edited</span>;
  if (entry.type === 'reassign') return <span className="text-indigo-300">Reassigned</span>;
  if (entry.type === 'error') return <span className="text-red-300">Error occurred</span>;
  if (entry.type === 'stopped') return <span className="text-yellow-300">Execution stopped</span>;
  if (entry.type === 'restored') return <span className="text-teal-300">Task restored</span>;
  return <span className="text-dark-200">Status change</span>;
}

export default function HistoryDetailModal({ entry, agents, onClose }: { entry: any; agents?: any[]; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const agentName = (id: string) => {
    if (!id) return null;
    const a = agents?.find(a => a.id === id);
    return a ? `${a.icon} ${a.name}` : id.slice(0, 8);
  };

  const duration = entry.startedAt && entry.at
    ? Math.round((new Date(entry.at).getTime() - new Date(entry.startedAt).getTime()) / 1000)
    : null;
  const durationLabel = duration != null
    ? duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m${duration % 60}s`
    : null;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="w-full max-w-2xl max-h-[80vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col animate-fadeIn"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-dark-700 flex-shrink-0">
          <div className="flex items-center gap-3">
            {renderEntryIcon(entry)}
            <span className="text-sm font-semibold">{renderEntryTitle(entry)}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-dark-400">
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              <span title={formatDate(entry.at)}>{timeAgo(entry.at)}</span>
              {formatDate(entry.at) && (
                <span className="text-dark-500">({formatDate(entry.at)})</span>
              )}
            </div>
            {entry.by && (
              <div className="flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" />
                <span className="text-dark-300">{entry.by}</span>
              </div>
            )}
            {durationLabel && (
              <div className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" />
                <span className="font-mono text-dark-300">{durationLabel}</span>
              </div>
            )}
          </div>

          {/* Status transition */}
          {(entry.from || entry.status) && entry.type !== 'execution' && entry.type !== 'edit' && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-dark-800/60 border border-dark-700">
              {entry.from && (
                <>
                  <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-dark-700 text-dark-300 ring-1 ring-dark-600">
                    {entry.from}
                  </span>
                  <ArrowRight className="w-4 h-4 text-dark-500" />
                </>
              )}
              {entry.status && (
                <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/30">
                  {entry.status}
                </span>
              )}
            </div>
          )}

          {/* Edit: show old/new values */}
          {entry.type === 'edit' && (
            <>
              {entry.fields ? (
                entry.fields.map((f: any, i: number) => (
                  <DiffBlock
                    key={i}
                    label={FIELD_LABELS[f.field] || f.field}
                    oldVal={typeof f.oldValue === 'string' ? f.oldValue : JSON.stringify(f.oldValue)}
                    newVal={typeof f.newValue === 'string' ? f.newValue : JSON.stringify(f.newValue)}
                  />
                ))
              ) : entry.field ? (
                <DiffBlock
                  label={FIELD_LABELS[entry.field] || entry.field}
                  oldVal={typeof entry.oldValue === 'string' ? entry.oldValue : JSON.stringify(entry.oldValue)}
                  newVal={typeof entry.newValue === 'string' ? entry.newValue : JSON.stringify(entry.newValue)}
                />
              ) : (
                <div className="text-xs text-dark-500 italic">No change details recorded.</div>
              )}
            </>
          )}

          {/* Reassign: show agent info */}
          {entry.type === 'reassign' && (
            <div className="p-3 rounded-lg bg-dark-800/60 border border-dark-700 space-y-2">
              <div className="text-xs text-dark-400">
                {entry.assignee ? (
                  <>
                    <span>Reassigned to </span>
                    <span className="text-indigo-300 font-medium">
                      {agentName(entry.assignee) || entry.assignee}
                    </span>
                  </>
                ) : (
                  <span className="text-dark-500 italic">Unassigned</span>
                )}
              </div>
            </div>
          )}

          {/* Error: full details */}
          {entry.type === 'error' && entry.error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <div className="text-[10px] text-red-400 font-semibold mb-1.5 uppercase tracking-wider">Error details</div>
              <pre className="text-xs text-red-300/80 whitespace-pre-wrap break-words leading-relaxed font-mono">
                {entry.error}
              </pre>
            </div>
          )}

          {/* Stopped: show context */}
          {entry.type === 'stopped' && (
            <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <div className="text-xs text-yellow-300">
                Execution was manually stopped{entry.by ? ` by ${entry.by}` : ''}.
              </div>
            </div>
          )}

          {/* Restored */}
          {entry.type === 'restored' && (
            <div className="p-3 rounded-lg bg-teal-500/10 border border-teal-500/20">
              <div className="text-xs text-teal-300">
                Task was restored from trash{entry.by ? ` by ${entry.by}` : ''}.
              </div>
            </div>
          )}

          {/* Execution: show message count summary */}
          {entry.type === 'execution' && (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-dark-800/60 border border-dark-700 space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-dark-400">Mode</span>
                  <span className="text-dark-200 font-medium">{MODE_LABELS[entry.mode] || entry.mode || 'execute'}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-dark-400">Result</span>
                  <span className={entry.success ? 'text-emerald-400' : 'text-red-400'}>
                    {entry.success ? 'Success' : 'Failed'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-dark-400">Messages</span>
                  <span className="text-dark-200">{entry.messages?.length || 0}</span>
                </div>
                {durationLabel && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-dark-400">Duration</span>
                    <span className="text-dark-200 font-mono">{durationLabel}</span>
                  </div>
                )}
              </div>

              {/* Messages */}
              {entry.messages?.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] text-dark-500 font-semibold uppercase tracking-wider">
                    Messages ({entry.messages.length})
                  </div>
                  <div className="space-y-2 max-h-[400px] overflow-y-auto">
                    {entry.messages.map((m: any, mi: number) => (
                      <div key={mi} className={`rounded-lg p-3 ${
                        m.role === 'user'
                          ? 'bg-blue-500/10 border border-blue-500/20'
                          : 'bg-dark-800/80 border border-dark-700/50'
                      }`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className={`text-[10px] font-semibold uppercase tracking-wider ${
                            m.role === 'user' ? 'text-blue-400' : 'text-emerald-400'
                          }`}>
                            {m.role === 'user' ? '→ Prompt' : '← Agent'}
                          </span>
                          {m.timestamp && (
                            <span className="text-[10px] text-dark-500">
                              {new Date(m.timestamp).toLocaleTimeString()}
                            </span>
                          )}
                        </div>
                        <div className="text-dark-300 text-xs leading-relaxed">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            className="prose prose-invert prose-xs max-w-none break-words"
                            components={{
                              pre: ({ children }) => <pre className="bg-dark-900 rounded-lg p-2 overflow-x-auto my-1 border border-dark-600 text-[11px]">{children}</pre>,
                              code: ({ inline, children }) => inline
                                ? <code className="bg-dark-700 px-1 py-0.5 rounded text-purple-300 text-[11px]">{children}</code>
                                : <code className="text-green-300 text-[11px]">{children}</code>,
                              p: ({ children }) => <p className="my-0.5">{children}</p>,
                              a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{children}</a>,
                            }}
                          >
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-5 py-3 border-t border-dark-700 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-dark-300 hover:text-dark-100
              bg-dark-800 border border-dark-700 hover:border-dark-500 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
