import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, Maximize2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MODE_LABELS = { execute: 'Execution', refine: 'Refine', decide: 'Decide', title: 'Title', set_type: 'Set Type' };
const MODE_COLORS = { execute: 'text-blue-300', refine: 'text-violet-300', decide: 'text-amber-300', title: 'text-teal-300', set_type: 'text-pink-300' };
const MODE_ICON_COLORS = { execute: 'text-blue-400', refine: 'text-violet-400', decide: 'text-amber-400', title: 'text-teal-400', set_type: 'text-pink-400' };

function MessageContent({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="prose prose-invert prose-xs max-w-none break-words"
      components={{
        pre: ({ children }) => <pre className="bg-dark-900 rounded-lg p-2 overflow-x-auto my-1 border border-dark-600 text-[11px]">{children}</pre>,
        code: ({ children }) => {
          // react-markdown v9 removed the `inline` prop. Block code content always
          // ends with a newline (added by mdast-util-to-hast), while inline code
          // spans can never contain one — use that to tell them apart.
          const isInline = !String(children).includes('\n');
          return isInline
            ? <code className="bg-dark-700 px-1 py-0.5 rounded text-purple-300 text-[11px]">{children}</code>
            : <code className="text-green-300 text-[11px]">{children}</code>;
        },
        p: ({ children }) => <p className="my-0.5 text-xs leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 text-xs">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 text-xs">{children}</ol>,
        li: ({ children }) => <li className="text-dark-300 text-xs">{children}</li>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline text-xs">{children}</a>,
        h1: ({ children }) => <h1 className="text-sm font-bold text-dark-100 mt-2 mb-0.5">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xs font-bold text-dark-100 mt-2 mb-0.5">{children}</h2>,
        h3: ({ children }) => <h3 className="text-xs font-bold text-dark-100 mt-1 mb-0.5">{children}</h3>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-purple-500 pl-2 my-1 text-dark-400 italic text-xs">{children}</blockquote>,
        table: ({ children }) => <table className="border-collapse border border-dark-600 my-1 w-full text-[11px]">{children}</table>,
        th: ({ children }) => <th className="border border-dark-600 px-1.5 py-0.5 bg-dark-700 text-left text-[11px]">{children}</th>,
        td: ({ children }) => <td className="border border-dark-600 px-1.5 py-0.5 text-[11px]">{children}</td>,
        hr: () => <hr className="border-dark-600 my-2" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function FullScreenLogModal({ entry, onClose }) {
  const messages = entry.messages || [];
  const modeKey = entry.mode || 'execute';
  const modeLabel = MODE_LABELS[modeKey] || 'Execution';
  const duration = entry.startedAt && entry.at
    ? Math.round((new Date(entry.at).getTime() - new Date(entry.startedAt).getTime()) / 1000)
    : null;
  const durationLabel = duration != null
    ? duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m${duration % 60}s`
    : null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[90vw] max-w-6xl h-[90vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col animate-fadeIn"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-dark-700 flex-shrink-0">
          <div className="flex items-center gap-3">
            <MessageSquare className={`w-4 h-4 ${MODE_ICON_COLORS[modeKey] || 'text-blue-400'}`} />
            <span className={`text-sm font-semibold ${entry.success ? (MODE_COLORS[modeKey] || 'text-blue-300') : 'text-red-300'}`}>
              {modeLabel} {entry.success ? '✓' : '✗'}
            </span>
            <span className="text-xs text-dark-500">by {entry.by}</span>
            {durationLabel && (
              <span className="text-xs text-dark-500 font-mono bg-dark-800 px-2 py-0.5 rounded">{durationLabel}</span>
            )}
            <span className="text-xs text-dark-500">{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {messages.map((m, mi) => (
            <div key={mi} className={`rounded-lg p-3 ${
              m.role === 'user'
                ? 'bg-blue-500/10 border border-blue-500/20'
                : 'bg-dark-800/80 border border-dark-700/50'
            }`}>
              <div className="flex items-center justify-between mb-2">
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
              <div className="text-dark-300">
                <MessageContent content={m.content} />
              </div>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="text-center text-dark-500 text-sm py-8">No messages recorded for this execution.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ExecutionLogEntry({ entry, index }) {
  const [expanded, setExpanded] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const messages = entry.messages || [];
  const duration = entry.startedAt && entry.at
    ? Math.round((new Date(entry.at).getTime() - new Date(entry.startedAt).getTime()) / 1000)
    : null;
  const durationLabel = duration != null
    ? duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m${duration % 60}s`
    : null;

  const modeKey = entry.mode || 'execute';
  const modeLabel = MODE_LABELS[modeKey] || 'Execution';

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(o => !o); }}
          className="flex items-center gap-1.5 text-xs group/exec hover:opacity-80 transition-opacity flex-1 min-w-0"
        >
          <MessageSquare className={`w-2.5 h-2.5 ${MODE_ICON_COLORS[modeKey] || 'text-blue-400'} flex-shrink-0`} />
          <span className={`font-medium ${entry.success ? (MODE_COLORS[modeKey] || 'text-blue-300') : 'text-red-300'}`}>
            {modeLabel} {entry.success ? '✓' : '✗'}
          </span>
          <span className="text-dark-500 truncate">by {entry.by}</span>
          {durationLabel && (
            <span className="text-[10px] text-dark-500 font-mono">({durationLabel})</span>
          )}
          {messages.length > 0 && (
            <span className="text-[10px] text-dark-500">
              — {messages.length} msg{messages.length > 1 ? 's' : ''}
            </span>
          )}
          {expanded
            ? <ChevronDown className="w-3 h-3 text-dark-500 flex-shrink-0" />
            : <ChevronRight className="w-3 h-3 text-dark-500 flex-shrink-0" />
          }
        </button>
        {messages.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setFullScreen(true); }}
            className="p-0.5 rounded text-dark-600 hover:text-indigo-400 hover:bg-dark-700/50 transition-colors flex-shrink-0"
            title="Open full log"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {expanded && messages.length > 0 && (
        <div className="mt-2 space-y-2 max-h-[500px] overflow-y-auto scrollbar-thin-dark">
          {messages.map((m, mi) => (
            <div key={mi} className={`rounded-lg p-2.5 text-xs leading-relaxed ${
              m.role === 'user'
                ? 'bg-blue-500/10 border border-blue-500/20'
                : 'bg-dark-700/60 border border-dark-600/50'
            }`}>
              <div className="flex items-center justify-between mb-1">
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
              <div className="text-dark-300">
                <MessageContent content={m.content} />
              </div>
            </div>
          ))}
        </div>
      )}
      {fullScreen && (
        <FullScreenLogModal entry={entry} onClose={() => setFullScreen(false)} />
      )}
    </div>
  );
}
