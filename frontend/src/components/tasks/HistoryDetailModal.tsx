import { useEffect, useRef, useState } from 'react';
import {
  X, ArrowRight, Edit3, User, XCircle, Pause, Clock,
  RotateCcw, MessageSquare, Zap, ChevronDown, ChevronRight,
  Terminal, CheckCircle, AlertCircle, Send, Bot,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDate, timeAgo, MODE_LABELS } from './taskConstants';

const MODE_COLORS: Record<string, string> = { execute: 'text-blue-300', refine: 'text-violet-300', decide: 'text-amber-300', title: 'text-teal-300', set_type: 'text-pink-300' };

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  text: 'Description',
  project: 'Project',
  taskType: 'Type',
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  isManual: 'Manual mode',
};

const mdComponents = {
  pre: ({ children }: any) => <pre className="bg-dark-900 rounded-lg p-2 overflow-x-auto my-1 border border-dark-600 text-[11px]">{children}</pre>,
  code: ({ children }: any) => !String(children).includes('\n')
    ? <code className="bg-dark-700 px-1 py-0.5 rounded text-purple-300 text-[11px]">{children}</code>
    : <code className="text-green-300 text-[11px]">{children}</code>,
  p: ({ children }: any) => <p className="my-0.5">{children}</p>,
  a: ({ href, children }: any) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{children}</a>,
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

function isToolResultMessage(m: any): boolean {
  return m.type === 'tool-result' || !!m.toolResults;
}

function ToolCallDetail({ tr }: { tr: any }) {
  const [expanded, setExpanded] = useState(false);
  const resultText = tr.result || tr.error || '';
  const isLong = resultText.length > 200;
  const displayText = expanded || !isLong ? resultText : resultText.slice(0, 200) + '…';
  const argsDisplay = Array.isArray(tr.args)
    ? tr.args.map((a: any) => typeof a === 'string' ? (a.length > 80 ? a.slice(0, 80) + '…' : a) : JSON.stringify(a)).join(', ')
    : typeof tr.args === 'object' ? JSON.stringify(tr.args) : String(tr.args || '');

  return (
    <div className={`rounded-lg border p-2.5 ${
      tr.success === false
        ? 'bg-red-500/5 border-red-500/20'
        : 'bg-dark-800/40 border-dark-700/50'
    }`}>
      <div className="flex items-center gap-2 mb-1">
        <Terminal className="w-3 h-3 text-dark-400 flex-shrink-0" />
        <span className="text-[11px] font-mono font-semibold text-indigo-300">{tr.tool}</span>
        {tr.success === false ? (
          <AlertCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
        ) : (
          <CheckCircle className="w-3 h-3 text-emerald-400 flex-shrink-0" />
        )}
      </div>
      {argsDisplay && (
        <div className="text-[10px] text-dark-400 font-mono mb-1.5 break-all leading-relaxed">
          ({argsDisplay})
        </div>
      )}
      {displayText && (
        <div className="relative">
          <pre className="text-[10px] text-dark-300 whitespace-pre-wrap break-words leading-relaxed font-mono bg-dark-900/60 rounded p-2 max-h-[300px] overflow-y-auto">
            {displayText}
          </pre>
          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultsBlock({ toolResults }: { toolResults: any[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!toolResults || toolResults.length === 0) return null;

  const successCount = toolResults.filter(t => t.success !== false).length;
  const errorCount = toolResults.length - successCount;

  return (
    <div className="rounded-lg bg-dark-800/30 border border-dark-700/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-dark-700/30 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-dark-400" /> : <ChevronRight className="w-3.5 h-3.5 text-dark-400" />}
        <Terminal className="w-3.5 h-3.5 text-indigo-400" />
        <span className="text-[11px] font-medium text-dark-300">
          {toolResults.length} tool call{toolResults.length > 1 ? 's' : ''}
        </span>
        {successCount > 0 && (
          <span className="text-[10px] text-emerald-400">{successCount} ok</span>
        )}
        {errorCount > 0 && (
          <span className="text-[10px] text-red-400">{errorCount} error{errorCount > 1 ? 's' : ''}</span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {toolResults.map((tr: any, i: number) => (
            <ToolCallDetail key={i} tr={tr} />
          ))}
        </div>
      )}
    </div>
  );
}

function ExecutionConversation({ messages }: { messages: any[] }) {
  if (!messages || messages.length === 0) {
    return <div className="text-xs text-dark-500 italic">No conversation recorded.</div>;
  }

  // Separate the initial prompt from the rest
  const initialPrompt = messages[0]?.role === 'user' ? messages[0] : null;
  const conversation = initialPrompt ? messages.slice(1) : messages;

  // Group conversation into exchanges: assistant response + following tool-result
  const exchanges: { agent: any; toolResults?: any }[] = [];
  for (let i = 0; i < conversation.length; i++) {
    const m = conversation[i];
    if (m.role === 'assistant') {
      const next = conversation[i + 1];
      const hasToolResults = next && next.role === 'user' && isToolResultMessage(next);
      exchanges.push({
        agent: m,
        toolResults: hasToolResults ? next : undefined,
      });
      if (hasToolResults) i++;
    } else if (m.role === 'user' && !isToolResultMessage(m)) {
      exchanges.push({ agent: { role: 'system', content: m.content, timestamp: m.timestamp } });
    }
  }

  return (
    <div className="space-y-3">
      {/* Initial prompt / input */}
      {initialPrompt && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-dark-500 font-semibold uppercase tracking-wider flex items-center gap-1.5">
            <Send className="w-3 h-3" />
            Input sent to agent
          </div>
          <div className="rounded-lg bg-blue-500/8 border border-blue-500/20 p-3">
            {initialPrompt.timestamp && (
              <div className="text-[10px] text-dark-500 mb-1.5">
                {new Date(initialPrompt.timestamp).toLocaleTimeString()}
              </div>
            )}
            <div className="text-dark-300 text-xs leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]} className="prose prose-invert prose-xs max-w-none break-words" components={mdComponents}>
                {initialPrompt.content}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      {/* Agent responses and tool calls */}
      {exchanges.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-dark-500 font-semibold uppercase tracking-wider flex items-center gap-1.5">
            <Bot className="w-3 h-3" />
            Agent activity ({exchanges.length} exchange{exchanges.length > 1 ? 's' : ''})
          </div>
          <div className="space-y-2">
            {exchanges.map((ex, i) => (
              <div key={i} className="space-y-1.5">
                {/* Agent response */}
                <div className={`rounded-lg p-3 ${
                  ex.agent.role === 'system'
                    ? 'bg-amber-500/8 border border-amber-500/20'
                    : 'bg-dark-800/60 border border-dark-700/50'
                }`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${
                      ex.agent.role === 'system' ? 'text-amber-400' : 'text-emerald-400'
                    }`}>
                      {ex.agent.role === 'system' ? '→ System' : `← Agent response #${i + 1}`}
                    </span>
                    {ex.agent.timestamp && (
                      <span className="text-[10px] text-dark-500">
                        {new Date(ex.agent.timestamp).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <div className="text-dark-300 text-xs leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} className="prose prose-invert prose-xs max-w-none break-words" components={mdComponents}>
                      {ex.agent.content}
                    </ReactMarkdown>
                  </div>
                </div>

                {/* Tool results (collapsible) */}
                {ex.toolResults?.toolResults ? (
                  <ToolResultsBlock toolResults={ex.toolResults.toolResults} />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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

  const isExecution = entry.type === 'execution';
  const msgCount = entry.messages?.length || 0;
  const toolCallCount = entry.messages?.reduce((acc: number, m: any) => acc + (m.toolResults?.length || 0), 0) || 0;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className={`w-full ${isExecution ? 'max-w-4xl' : 'max-w-2xl'} max-h-[85vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col animate-fadeIn`}
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
            {isExecution && (
              <>
                <div className="flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span className="text-dark-300">{msgCount} msg{msgCount !== 1 ? 's' : ''}</span>
                </div>
                {toolCallCount > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5" />
                    <span className="text-dark-300">{toolCallCount} tool call{toolCallCount !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Execution summary bar */}
          {isExecution && (
            <div className="flex items-center gap-4 p-2.5 rounded-lg bg-dark-800/60 border border-dark-700">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-dark-400">Mode</span>
                <span className={`font-medium ${MODE_COLORS[entry.mode] || 'text-dark-200'}`}>
                  {MODE_LABELS[entry.mode] || entry.mode || 'execute'}
                </span>
              </div>
              <div className="w-px h-4 bg-dark-700" />
              <div className="flex items-center gap-2 text-xs">
                <span className="text-dark-400">Result</span>
                <span className={entry.success ? 'text-emerald-400 font-medium' : 'text-red-400 font-medium'}>
                  {entry.success ? 'Success' : 'Failed'}
                </span>
              </div>
              {durationLabel && (
                <>
                  <div className="w-px h-4 bg-dark-700" />
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-dark-400">Duration</span>
                    <span className="text-dark-200 font-mono">{durationLabel}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Status transition (non-execution) */}
          {(entry.from || entry.status) && !isExecution && entry.type !== 'edit' && (
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

          {/* Reassign */}
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

          {/* Error */}
          {entry.type === 'error' && entry.error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <div className="text-[10px] text-red-400 font-semibold mb-1.5 uppercase tracking-wider">Error details</div>
              <pre className="text-xs text-red-300/80 whitespace-pre-wrap break-words leading-relaxed font-mono">
                {entry.error}
              </pre>
            </div>
          )}

          {/* Stopped */}
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

          {/* Execution: full conversation with structured tool calls */}
          {isExecution && (
            <ExecutionConversation messages={entry.messages} />
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
