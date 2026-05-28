import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronDown, ChevronRight, ArrowRight, Clock, Scissors,
} from 'lucide-react';

const markdownRemarkPlugins = [remarkGfm];
import { cleanToolSyntax } from './cleanToolSyntax';
import ToolResultMessage from './ToolResultMessage';
import DelegationResultMessage from './DelegationResultMessage';

/**
 * Split text into interleaved text segments and @delegate() blocks.
 * Returns an array of { type: 'text'|'delegation', content?, agent?, task? }.
 */
function parseDelegationBlocks(text) {
  if (!text) return [{ type: 'text', content: text }];
  const segments = [];
  // Regex to find @delegate(Agent, "task") or @delegate(Agent, 'task')
  const re = /@delegate\s*\(\s*([^,]+?)\s*,\s*(["'])/gi;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Push text before this match
    if (m.index > lastIdx) {
      segments.push({ type: 'text', content: text.slice(lastIdx, m.index) });
    }
    const agentName = m[1].trim();
    const quoteChar = m[2];
    // Scan for matching closing quote followed by )
    let i = re.lastIndex;
    let task = '';
    let found = false;
    while (i < text.length) {
      if (text[i] === '\\' && i + 1 < text.length) {
        task += text[i] + text[i + 1];
        i += 2;
        continue;
      }
      if (text[i] === quoteChar) {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (j < text.length && text[j] === ')') {
          found = true;
          lastIdx = j + 1;
          break;
        }
        task += text[i];
        i++;
        continue;
      }
      task += text[i];
      i++;
    }
    if (found) {
      segments.push({ type: 'delegation', agent: agentName, task: task.trim() });
      re.lastIndex = lastIdx;
    } else {
      // Couldn't parse — include as text
      segments.push({ type: 'text', content: text.slice(m.index, re.lastIndex) });
      lastIdx = re.lastIndex;
    }
  }
  if (lastIdx < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIdx) });
  }
  return segments;
}

/** Styled delegation block shown in leader assistant messages */
function DelegationCallBlock({ agent, task }) {
  const [expanded, setExpanded] = useState(false);
  const preview = task.length > 140 ? task.slice(0, 140) + '…' : task;
  const needsExpand = task.length > 140;

  return (
    <div className="my-2 rounded-lg border border-indigo-500/30 bg-indigo-500/5 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-indigo-500/10 transition-colors"
        onClick={() => needsExpand && setExpanded(e => !e)}
      >
        <ArrowRight className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
        <span className="text-xs font-semibold text-indigo-300">Delegate to</span>
        <span className="text-xs font-bold text-indigo-200 bg-indigo-500/20 px-1.5 py-0.5 rounded">{agent}</span>
        {needsExpand && (
          expanded
            ? <ChevronDown className="w-3 h-3 text-dark-400 ml-auto" />
            : <ChevronRight className="w-3 h-3 text-dark-400 ml-auto" />
        )}
      </div>
      <div className="px-3 pb-2">
        <div className="markdown-content text-xs text-dark-300 leading-relaxed">
          <ReactMarkdown remarkPlugins={markdownRemarkPlugins}>{expanded || !needsExpand ? task : preview}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSec}s`;
}

// Reconstruct Claude Code CLI OAuth URLs that get wrapped across multiple lines
// in the terminal output. The CLI prints something like:
//   https://claude.com/cai/oauth/authorize?code=
//   abc123def
//   ghi456jkl
//
// We join the URL prefix with the following non-empty trimmed lines (which
// contain no spaces) until a blank line is encountered, producing a single URL.
function reconstructWrappedOAuthUrls(text) {
  if (typeof text !== 'string') return text;
  const marker = /https?:\/\/claude\.com\/cai\/oauth\/authorize\?code=\S*/g;
  let result = '';
  let lastIdx = 0;
  let m;
  while ((m = marker.exec(text)) !== null) {
    result += text.slice(lastIdx, m.index);
    let url = m[0];
    let i = m.index + m[0].length;
    // Continue consuming subsequent lines (separated by \n) that are non-empty
    // and contain no whitespace, stopping at a blank line or whitespace.
    while (i < text.length && text[i] === '\n') {
      // Find next newline
      let j = i + 1;
      while (j < text.length && text[j] !== '\n') j++;
      const line = text.slice(i + 1, j);
      const trimmed = line.trim();
      // Stop on blank line, or any line containing spaces/tabs (real prose).
      if (trimmed === '' || /\s/.test(trimmed)) break;
      url += trimmed;
      i = j;
    }
    result += url;
    lastIdx = i;
    marker.lastIndex = i;
  }
  result += text.slice(lastIdx);
  return result;
}

// Convert raw URLs to markdown links so ReactMarkdown renders them clickable
function linkifyRawUrls(text) {
  if (typeof text !== 'string') return text;
  const reconstructed = reconstructWrappedOAuthUrls(text);
  return reconstructed.replace(/(https?:\/\/[^\s,)"']+)/g, (url) => `[${url}](${url})`);
}

// Make all links open in a new tab
const markdownLinkNewTab = { a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> };

/** Renders assistant content with @delegate blocks styled as cards */
export function RichAssistantContent({ text }) {
  const cleaned = cleanToolSyntax(text);
  const segments = parseDelegationBlocks(cleaned);
  // If there are no delegation blocks, fast-path to plain markdown
  if (segments.length === 1 && segments[0].type === 'text') {
    return <ReactMarkdown remarkPlugins={markdownRemarkPlugins} components={markdownLinkNewTab}>{linkifyRawUrls(segments[0].content)}</ReactMarkdown>;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'delegation'
          ? <DelegationCallBlock key={i} agent={seg.agent} task={seg.task} />
          : <ReactMarkdown key={i} remarkPlugins={markdownRemarkPlugins} components={markdownLinkNewTab}>{linkifyRawUrls(seg.content)}</ReactMarkdown>
      )}
    </>
  );
}

export default function ChatMessage({ message, index, isLast, onTruncate }) {
  const isUser = message.role === 'user';
  const isToolResult = message.type === 'tool-result'
    || (!message.type && isUser && message.content?.startsWith('[TOOL RESULTS]'));
  const isDelegationResult = message.type === 'delegation-result'
    || (!message.type && isUser && message.content?.startsWith('[DELEGATION RESULTS]'));
  const isDelegationTask = message.type === 'delegation-task'
    || (!message.type && isUser && message.content?.startsWith('[TASK from '));
  const isNudge = message.type === 'nudge'
    || (!message.type && isUser && message.content?.startsWith('[SYSTEM]'));
  const isSystemMessage = isToolResult || isDelegationResult;

  // Hide internal nudge messages from chat
  if (isNudge) return null;

  // Render tool/delegation results as a collapsible sub-element
  if (isSystemMessage) {
    return (
      <div className="group relative">
        {isToolResult
          ? <ToolResultMessage message={message} />
          : <DelegationResultMessage message={message} />
        }
        {!isLast && onTruncate && (
          <button
            onClick={() => onTruncate(index - 1)}
            className="absolute -right-1 top-1 opacity-0 group-hover:opacity-100 p-1 bg-dark-700 hover:bg-red-500/20 text-dark-400 hover:text-red-400 rounded-md transition-all border border-dark-600 hover:border-red-500/30"
            title="Restart from here"
          >
            <Scissors className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }

  // Render delegation tasks with special attribution
  if (isDelegationTask) {
    const fromAgent = message.fromAgent || message.content?.match(/^\[TASK from (.+?)\]/)?.[1] || 'Leader';
    // Extract just the task text (remove the [TASK from ...]: prefix)
    const taskText = message.content?.replace(/^\[TASK from .+?\]:\s*/, '') || message.content;
    return (
      <div className="group relative flex gap-3">
        <div className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center flex-shrink-0 text-sm">
          {'📨'}
        </div>
        <div className="flex-1 rounded-xl p-3 bg-amber-500/5 border border-amber-500/20">
          <p className="text-[10px] text-amber-400 font-medium mb-1.5 flex items-center gap-1">
            Task from {fromAgent}
          </p>
          <div className="markdown-content text-sm text-dark-200">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins}>{taskText}</ReactMarkdown>
          </div>
          {message.timestamp && (
            <p className="text-[10px] text-dark-500 mt-2 flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {new Date(message.timestamp).toLocaleTimeString()}
            </p>
          )}
        </div>
        {!isLast && onTruncate && (
          <button
            onClick={() => onTruncate(index - 1)}
            className="absolute -right-1 top-1 opacity-0 group-hover:opacity-100 p-1 bg-dark-700 hover:bg-red-500/20 text-dark-400 hover:text-red-400 rounded-md transition-all border border-dark-600 hover:border-red-500/30"
            title="Restart from here"
          >
            <Scissors className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`group relative flex gap-3 ${isUser ? '' : ''}`}>
      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-xs font-bold ${
        isUser
          ? 'bg-dark-700 text-dark-300'
          : 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white'
      }`}>
        {isUser ? 'You' : 'AI'}
      </div>
      <div className={`flex-1 rounded-xl p-3 ${
        isUser ? 'bg-dark-700/50 border border-dark-600/50' : 'bg-dark-800/50 border border-dark-700/50'
      }`}>
        {/* Show attached images for user messages and tool results */}
        {message.images && message.images.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img.preview || `data:${img.mediaType};base64,${img.data}`}
                alt={`Attached ${i + 1}`}
                className="max-w-48 max-h-48 rounded-lg border border-dark-600 object-contain cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => window.open(img.preview || `data:${img.mediaType};base64,${img.data}`, '_blank')}
              />
            ))}
          </div>
        )}
        <div className="markdown-content text-sm text-dark-200">
          {isUser
            ? <ReactMarkdown remarkPlugins={markdownRemarkPlugins}>{message.content}</ReactMarkdown>
            : <RichAssistantContent text={message.content} />
          }
        </div>
        {message.timestamp && (
          <p className="text-[10px] text-dark-500 mt-2 flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {new Date(message.timestamp).toLocaleTimeString()}
            </span>
            {!isUser && (message.durationMs != null || message.outputTokens != null) && (
              <>
                <span className="text-dark-600">·</span>
                {message.durationMs != null && (
                  <span title="Response duration">
                    {formatDuration(message.durationMs)}
                  </span>
                )}
                {message.outputTokens != null && (
                  <>
                    <span className="text-dark-600">·</span>
                    <span title="Output tokens">
                      {message.outputTokens.toLocaleString()} tok
                    </span>
                  </>
                )}
                {message.durationMs != null && message.outputTokens != null && message.durationMs > 0 && (
                  <>
                    <span className="text-dark-600">·</span>
                    <span title="Tokens per second">
                      {(message.outputTokens / (message.durationMs / 1000)).toFixed(1)} tok/s
                    </span>
                  </>
                )}
              </>
            )}
          </p>
        )}
      </div>
      {!isLast && onTruncate && (
        <button
          onClick={() => onTruncate(index - 1)}
          className="absolute -right-1 top-1 opacity-0 group-hover:opacity-100 p-1 bg-dark-700 hover:bg-red-500/20 text-dark-400 hover:text-red-400 rounded-md transition-all border border-dark-600 hover:border-red-500/30"
          title="Restart from here"
        >
          <Scissors className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
