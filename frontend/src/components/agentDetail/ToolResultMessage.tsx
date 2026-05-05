import { useState } from 'react';
import { ChevronDown, ChevronRight, AlertCircle, Terminal } from 'lucide-react';

// Parse legacy tool results from raw [TOOL RESULTS] message content
export function parseLegacyToolResults(content) {
  const results = [];
  const pattern = /---\s*(\w+)\(([^)]*)\)\s*---\n([\s\S]*?)(?=\n---\s*\w+\(|$)/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const output = m[3].trim();
    const isError = output.startsWith('ERROR:');
    results.push({
      tool: m[1],
      args: [m[2]],
      success: !isError,
      result: isError ? undefined : output,
      error: isError ? output.replace(/^ERROR:\s*/, '') : undefined
    });
  }
  return results;
}

// ─── Rich Tool Output (git diff/show/log/status rendering) ─────────────────
function isGitOutput(tool, args, output) {
  const cmd = (args || []).join(' ').toLowerCase();
  if (tool === 'run_command' && /^git\s/.test(cmd)) return true;
  // Detect git-like output by content heuristics
  if (typeof output === 'string' && (
    output.match(/^commit [0-9a-f]{7,40}/m) ||
    output.match(/^diff --git /m) ||
    output.match(/^@@ .+ @@/m)
  )) return true;
  return false;
}

function classifyGitLine(line) {
  if (line.startsWith('commit ') && /^commit [0-9a-f]{7,40}/.test(line)) return 'commit';
  if (line.startsWith('Author:') || line.startsWith('Date:') || line.startsWith('Merge:')) return 'meta';
  if (line.startsWith('diff --git ')) return 'diff-header';
  if (line.startsWith('index ') && /^index [0-9a-f]+/.test(line)) return 'index';
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'file-header';
  if (line.startsWith('@@') && line.includes('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  if (line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('rename ') || line.startsWith('similarity index')) return 'diff-meta';
  return 'plain';
}

const gitLineStyles = {
  'commit':     'text-amber-400 font-semibold',
  'meta':       'text-dark-400',
  'diff-header':'text-indigo-400 font-semibold mt-2',
  'index':      'text-dark-500',
  'file-header':'text-dark-300 font-medium',
  'hunk':       'text-cyan-400 bg-cyan-500/5',
  'added':      'text-emerald-400 bg-emerald-500/10',
  'removed':    'text-red-400 bg-red-500/10',
  'diff-meta':  'text-dark-400 italic',
  'plain':      'text-dark-400',
};

function RichToolOutput({ output, success, tool, args }) {
  const text = typeof output === 'string' ? output.slice(0, 5000) : JSON.stringify(output, null, 2).slice(0, 5000);

  if (isGitOutput(tool, args, output)) {
    const lines = text.split('\n');
    return (
      <div className={`mt-1 ml-3 rounded text-[11px] overflow-x-auto max-h-80 overflow-y-auto border ${
        success ? 'bg-dark-900/80 border-dark-700/50' : 'bg-red-500/5 border-red-500/20'
      }`}>
        <div className="p-2 font-mono leading-relaxed">
          {lines.map((line, i) => {
            const cls = classifyGitLine(line);
            return (
              <div key={i} className={`whitespace-pre-wrap break-all px-1 ${cls === 'commit' && i > 0 ? 'mt-3 pt-2 border-t border-dark-700/50' : ''} ${gitLineStyles[cls]}`}>
                {line || '\u00A0'}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Default: plain pre output
  return (
    <pre className={`mt-1 ml-3 p-2 rounded text-[11px] overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all ${
      success
        ? 'bg-dark-900/80 border border-dark-700/50 text-dark-400'
        : 'bg-red-500/5 border border-red-500/20 text-red-300'
    }`}>
      {text}
    </pre>
  );
}

// ─── Error Report Item (from @report_error) ────────────────────────────────
function ErrorReportItem({ result }) {
  const description = (result.args || [])[0] || result.result || 'Unknown error';
  return (
    <div className="text-xs flex items-start gap-2 p-2 rounded bg-orange-500/5 border border-orange-500/20">
      <AlertCircle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0 mt-0.5" />
      <div>
        <p className="text-orange-300 font-medium text-[11px] mb-0.5">Error escalated to manager</p>
        <p className="text-dark-300">{description}</p>
      </div>
    </div>
  );
}

function ToolResultItem({ result }) {
  const [showOutput, setShowOutput] = useState(!result.success); // auto-expand errors
  const argSummary = (result.args || []).map(a => typeof a === 'string' && a.length > 60 ? a.slice(0, 60) + '...' : a).join(', ');
  // For failed tools, show both the error message AND the actual output (stderr/stdout)
  const output = result.success
    ? result.result
    : [result.error, result.result].filter(Boolean).join('\n\n--- Output ---\n');
  const hasContent = !!output || (result.images && result.images.length > 0);

  return (
    <div className="text-xs">
      <button
        onClick={() => setShowOutput(!showOutput)}
        className="flex items-center gap-1.5 text-dark-400 hover:text-dark-200 transition-colors w-full text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${result.success ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <code className={`font-mono ${result.success ? 'text-dark-300' : 'text-red-300'}`}>@{result.tool}({argSummary})</code>
        {hasContent && (showOutput
          ? <ChevronDown className="w-3 h-3 ml-auto flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 ml-auto flex-shrink-0" />
        )}
      </button>
      {showOutput && hasContent && (
        <>
          {result.images && result.images.length > 0 && (
            <div className="flex gap-2 mt-1 ml-3 flex-wrap">
              {result.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={`Tool result ${i + 1}`}
                  className="max-w-64 max-h-64 rounded-lg border border-dark-600 object-contain cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={() => window.open(`data:${img.mediaType};base64,${img.data}`, '_blank')}
                />
              ))}
            </div>
          )}
          {output && <RichToolOutput output={output} success={result.success} tool={result.tool} args={result.args} />}
        </>
      )}
    </div>
  );
}

// ─── Tool Result Collapsible Message ───────────────────────────────────────
export default function ToolResultMessage({ message }) {
  const results = message.toolResults?.length
    ? message.toolResults
    : parseLegacyToolResults(message.content || '');
  const successCount = results.filter(r => r.success && !r.isErrorReport).length;
  const errorCount = results.filter(r => !r.success).length;
  const reportCount = results.filter(r => r.isErrorReport).length;
  const hasProblems = errorCount > 0 || reportCount > 0;
  const [expanded, setExpanded] = useState(hasProblems); // auto-expand when errors

  return (
    <div className="mx-2 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg transition-colors text-left group ${
          hasProblems
            ? 'bg-red-500/5 border border-red-500/30 hover:border-red-500/50'
            : 'bg-dark-800/70 border border-dark-700/50 hover:border-dark-600'
        }`}
      >
        {hasProblems
          ? <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          : <Terminal className="w-4 h-4 text-amber-400 flex-shrink-0" />
        }
        <span className="text-xs font-medium text-dark-300 flex-1">
          {results.length} tool call{results.length !== 1 ? 's' : ''} executed
          {successCount > 0 && <span className="text-emerald-400 ml-1.5">{successCount} passed</span>}
          {errorCount > 0 && <span className="text-red-400 ml-1.5">{errorCount} failed</span>}
          {reportCount > 0 && <span className="text-orange-400 ml-1.5">{reportCount} error report{reportCount !== 1 ? 's' : ''}</span>}
        </span>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-dark-500 group-hover:text-dark-300 transition-colors" />
          : <ChevronRight className="w-3.5 h-3.5 text-dark-500 group-hover:text-dark-300 transition-colors" />
        }
      </button>
      {expanded && (
        <div className="mt-1 ml-3 border-l-2 border-dark-700 pl-3 space-y-2 py-1">
          {results.map((r, i) => (
            r.isErrorReport
              ? <ErrorReportItem key={i} result={r} />
              : <ToolResultItem key={i} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}
