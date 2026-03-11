import { useState, useRef, useEffect } from 'react';
import {
  X, Send, Trash2, Plus, Settings, MessageSquare,
  CheckSquare, FileText, ArrowRightLeft, RotateCcw,
  ChevronDown, ChevronRight, Edit3, Save, Clock, Zap, AlertCircle, FolderCode, StopCircle, Terminal, Users,
  Play, PlayCircle, ArrowRight, Scissors, Activity, Wrench, ArrowLeft, Loader, XCircle, RotateCw, ArrowDownToLine
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api';
import VoiceChatTab from './VoiceChatTab';
import PluginEditor from './PluginEditor';


const TODO_STATUS_META = {
  pending: { label: 'Pending', dot: 'bg-amber-400', text: 'text-amber-300', ring: 'ring-amber-500/30 bg-amber-500/10' },
  in_progress: { label: 'In Progress', dot: 'bg-blue-400 animate-pulse', text: 'text-blue-300', ring: 'ring-blue-500/30 bg-blue-500/10' },
  error: { label: 'Error', dot: 'bg-red-400', text: 'text-red-300', ring: 'ring-red-500/30 bg-red-500/10' },
  done: { label: 'Completed', dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'ring-emerald-500/30 bg-emerald-500/10' }
};

const TABS = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'todos', label: 'Tasks', icon: CheckSquare },
  { id: 'rag', label: 'RAG', icon: FileText },
  { id: 'handoff', label: 'Handoff', icon: ArrowRightLeft },
  { id: 'plugins', label: 'Plugins', icon: Wrench },
  { id: 'logs', label: 'Action Logs', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

// Tool-call syntax patterns to match in assistant messages
const TOOL_NAMES = 'read_file|write_file|list_dir|search_files|run_command|append_file';

// Clean raw @tool() syntax and [Executing:...] markers from assistant text.
// Replaces them with clean markdown code blocks showing the command and hides
// the internal @tool_name wrapper.
// ── Balanced parsing helpers (mirrors server-side logic) ─────────────────────

function _findBalancedCloseUI(text, start) {
  let depth = 1, inTQ = false, inDQ = false, inSQ = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"' && text[i+1] === '"' && text[i+2] === '"') {
      if (inTQ) { inTQ = false; i += 2; continue; }
      if (!inDQ && !inSQ) { inTQ = true; i += 2; continue; }
    }
    if (inTQ) continue;
    if (text[i] === '\\' && (inDQ || inSQ)) { i++; continue; }
    if (text[i] === '"' && !inSQ) { inDQ = !inDQ; continue; }
    if (text[i] === "'" && !inDQ) { inSQ = !inSQ; continue; }
    if (!inDQ && !inSQ) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') { depth--; if (depth === 0) return i; }
    }
  }
  return -1;
}

function _findTopLevelCommaUI(text) {
  let inTQ = false, inDQ = false, inSQ = false, depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && text[i+1] === '"' && text[i+2] === '"') {
      if (inTQ) { inTQ = false; i += 2; continue; }
      if (!inDQ && !inSQ) { inTQ = true; i += 2; continue; }
    }
    if (inTQ) continue;
    if (text[i] === '\\' && (inDQ || inSQ)) { i++; continue; }
    if (text[i] === '"' && !inSQ) { inDQ = !inDQ; continue; }
    if (text[i] === "'" && !inDQ) { inSQ = !inSQ; continue; }
    if (!inDQ && !inSQ) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (text[i] === ',' && depth === 0) return i;
    }
  }
  return -1;
}

function _stripWrapperQuotes(s) {
  s = s.trim();
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return s.slice(1, -1);
  }
  return s;
}

export function cleanToolSyntax(text) {
  if (!text) return text;
  let cleaned = text;

  // Remove <think>...</think> reasoning blocks (from reasoning models like Qwen3)
  // Also handles unclosed <think> blocks (model ran out of tokens mid-reasoning)
  cleaned = cleaned.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');

  // Remove wrapper tags
  cleaned = cleaned.replace(/<\|?\/?tool_call\|?>/gi, '');
  cleaned = cleaned.replace(/<\|?\/?tool_use\|?>/gi, '');
  cleaned = cleaned.replace(/\[TOOL_CALLS?\]/gi, '');
  cleaned = cleaned.replace(/\n?\[Executing: @(?:read_file|write_file|list_dir|search_files|run_command|append_file)\([^)]*\)\.{3}\]\n?/gi, '');

  // Use balanced parser to find and replace @tool(...) calls
  const ALL_TOOLS = 'read_file|write_file|append_file|list_dir|search_files|run_command|report_error';
  const toolPattern = new RegExp(`@(${ALL_TOOLS})\\s*\\(`, 'gi');
  let m;
  // Process from end to start so replacements don't shift indices
  const replacements = [];

  while ((m = toolPattern.exec(cleaned)) !== null) {
    const toolName = m[1].toLowerCase();
    const argsStart = m.index + m[0].length;
    const closeIdx = _findBalancedCloseUI(cleaned, argsStart);
    if (closeIdx === -1) continue;

    const argsString = cleaned.slice(argsStart, closeIdx);
    let replacement;

    if (toolName === 'run_command') {
      const cmd = _stripWrapperQuotes(argsString);
      replacement = `\n\`\`\`bash\n$ ${cmd}\n\`\`\`\n`;
    } else if (toolName === 'read_file') {
      const p = _stripWrapperQuotes(argsString);
      replacement = `\n> **Reading** \`${p}\`\n`;
    } else if (toolName === 'list_dir') {
      const p = _stripWrapperQuotes(argsString) || '.';
      replacement = `\n> **Listing** \`${p}\`\n`;
    } else if (toolName === 'write_file' || toolName === 'append_file') {
      const commaIdx = _findTopLevelCommaUI(argsString);
      if (commaIdx !== -1) {
        const p = _stripWrapperQuotes(argsString.slice(0, commaIdx));
        let content = argsString.slice(commaIdx + 1).trim();
        if (content.startsWith('"""') && content.endsWith('"""')) content = content.slice(3, -3);
        replacement = `\n> **Writing** \`${p}\`\n\`\`\`\n${content}\n\`\`\`\n`;
      } else {
        replacement = `\n> **Writing** \`${argsString.trim()}\`\n`;
      }
    } else if (toolName === 'search_files') {
      const commaIdx = _findTopLevelCommaUI(argsString);
      if (commaIdx !== -1) {
        const pat = argsString.slice(0, commaIdx).trim();
        const q = argsString.slice(commaIdx + 1).trim();
        replacement = `\n> **Searching** \`${pat}\` for *${q}*\n`;
      } else {
        replacement = `\n> **Searching** \`${argsString.trim()}\`\n`;
      }
    } else if (toolName === 'report_error') {
      const desc = _stripWrapperQuotes(argsString);
      replacement = `\n> 🚨 **Error reported:** ${desc}\n`;
    }

    if (replacement) {
      replacements.push({ start: m.index, end: closeIdx + 1, replacement });
    }
    toolPattern.lastIndex = closeIdx + 1;
  }

  // Apply replacements from end to start
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    cleaned = cleaned.slice(0, r.start) + r.replacement + cleaned.slice(r.end);
  }

  return cleaned;
}

/**
 * Split text into interleaved text segments and @delegate() blocks.
 * Returns an array of { type: 'text'|'delegation', content?, agent?, task? }.
 */
function parseDelegationBlocks(text) {
  if (!text) return [{ type: 'text', content: text }];
  const segments = [];
  // Regex to find @delegate(Agent, "task") or @delegate(Agent, 'task')
  // Uses a balanced approach: match up to the closing quote+)
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
          <ReactMarkdown>{expanded || !needsExpand ? task : preview}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

/** Renders assistant content with @delegate blocks styled as cards */
// Convert raw URLs to markdown links so ReactMarkdown renders them clickable
function linkifyRawUrls(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/(https?:\/\/[^\s,)"']+)/g, (url) => `[${url}](${url})`);
}

// Make all links open in a new tab
const markdownLinkNewTab = { a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> };

function RichAssistantContent({ text }) {
  const cleaned = cleanToolSyntax(text);
  const segments = parseDelegationBlocks(cleaned);
  // If there are no delegation blocks, fast-path to plain markdown
  if (segments.length === 1 && segments[0].type === 'text') {
    return <ReactMarkdown components={markdownLinkNewTab}>{linkifyRawUrls(segments[0].content)}</ReactMarkdown>;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'delegation'
          ? <DelegationCallBlock key={i} agent={seg.agent} task={seg.task} />
          : <ReactMarkdown key={i} components={markdownLinkNewTab}>{linkifyRawUrls(seg.content)}</ReactMarkdown>
      )}
    </>
  );
}

export default function AgentDetail({ agent, agents, projects, skills, thinking, streamBuffer, socket, onClose, onSelectAgent, onRefresh, onActiveTabChange, requestedTab }) {
  const [activeTab, setActiveTab] = useState('chat');

  // Notify parent of active tab changes
  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    onActiveTabChange?.(tabId);
  };

  // Notify parent of initial tab on mount
  useEffect(() => {
    onActiveTabChange?.('chat');
  }, []);

  // Handle requested tab from parent (e.g., from voice indicator navigation)
  useEffect(() => {
    if (requestedTab && requestedTab !== activeTab) {
      setActiveTab(requestedTab);
      onActiveTabChange?.(requestedTab);
    }
  }, [requestedTab]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false); // Ref-based guard to prevent double-sends
  const [history, setHistory] = useState(agent?.conversationHistory || []);
  const chatEndRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [currentProject, setCurrentProject] = useState(agent?.project || '');
  const [projectSaving, setProjectSaving] = useState(false);

  useEffect(() => {
    setCurrentProject(agent?.project || '');
  }, [agent?.id, agent?.project]);

  const handleProjectChange = async (project) => {
    setCurrentProject(project);
    setProjectSaving(true);

    try {
      await api.updateAgent(agent.id, { project });
      onRefresh();
    } catch (err) {
      console.error(err);
      setCurrentProject(agent?.project || '');
    } finally {
      setProjectSaving(false);
    }
  };

  // Sync history from agent object (pushed via socket) instead of fetching from API.
  // This eliminates the flash between stream end and API response.
  useEffect(() => {
    if (agent?.conversationHistory) {
      setHistory(agent.conversationHistory);
    }
  }, [agent?.id, agent?.conversationHistory?.length]);

  // Auto-scroll chat
  useEffect(() => {
    if (autoScroll) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [history, streamBuffer, thinking, autoScroll]);

  const handleSend = async () => {
    if (!message.trim() || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const msg = message.trim();
    setMessage('');

    // Use socket for streaming
    if (socket) {
      socket.emit('agent:chat', { agentId: agent.id, message: msg });
      // Optimistically add user message to history
      setHistory(prev => [...prev, { role: 'user', content: msg, timestamp: new Date().toISOString() }]);
    } else {
      try {
        const result = await api.chatAgent(agent.id, msg);
        setHistory(prev => [
          ...prev,
          { role: 'user', content: msg, timestamp: new Date().toISOString() },
          { role: 'assistant', content: result.response, timestamp: new Date().toISOString() }
        ]);
      } catch (err) {
        console.error(err);
      }
    }
    sendingRef.current = false;
    setSending(false);
  };

  const handleClearHistory = async () => {
    if (!confirm('Clear all conversation history?')) return;
    await api.clearHistory(agent.id);
    setHistory([]);
    onRefresh();
  };

  const handleTruncateHistory = async (afterIndex) => {
    if (!confirm('Restart from this message? Everything after it will be deleted.')) return;
    const newHistory = await api.truncateHistory(agent.id, afterIndex);
    setHistory(newHistory);
    onRefresh();
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] animate-slideIn">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
        <div className="flex items-center gap-3 min-w-0">
          {/* Mobile back button */}
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 -ml-1 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors flex-shrink-0"
            title="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Mobile agent + project switchers */}
          <div className="lg:hidden flex items-center gap-2 min-w-0 flex-1">
            <select
              value={agent.id}
              onChange={(e) => onSelectAgent?.(e.target.value)}
              className="min-w-0 flex-1 px-2 py-1 bg-dark-800 border border-dark-600 rounded-lg text-sm font-bold text-dark-100 focus:outline-none focus:border-indigo-500 truncate appearance-none"
              title="Active agent"
            >
              {agents.filter(a => a.enabled !== false).map(a => (
                <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
              ))}
            </select>
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <FolderCode className="w-3.5 h-3.5 text-dark-500 flex-shrink-0" />
              <select
                value={currentProject}
                onChange={(e) => handleProjectChange(e.target.value)}
                disabled={projectSaving}
                className="min-w-0 flex-1 px-2 py-1 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                title="Working project"
              >
                <option value="">No project</option>
                {projects?.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          {/* Desktop: agent icon + name */}
          <span className="text-2xl flex-shrink-0 hidden lg:inline">{agent.icon}</span>
          <div className="min-w-0 hidden lg:block">
            <h2 className="font-bold text-dark-100">{agent.name}</h2>
            <div className="flex items-center gap-2 text-xs">
              <span className={`inline-flex items-center gap-1 ${
                agent.status === 'busy' ? 'text-amber-400' :
                agent.status === 'error' ? 'text-red-400' : 'text-emerald-400'
              }`}>
                <div className={`w-1.5 h-1.5 rounded-full ${
                  agent.status === 'busy' ? 'bg-amber-500 animate-pulse' :
                  agent.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'
                }`} />
                {agent.status}
              </span>
              {agent.isVoice && (
                <>
                  <span className="text-dark-500">·</span>
                  <span className="text-amber-400 font-medium">Voice</span>
                </>
              )}
              <span className="text-dark-500">·</span>
              <span className="text-dark-400 truncate">{agent.provider}/{agent.model}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Project selector — auto-saves (hidden on mobile) */}
          <div className="hidden lg:flex items-center gap-1.5">
            <FolderCode className="w-3.5 h-3.5 text-dark-500 flex-shrink-0" />
            <select
              value={currentProject}
              onChange={(e) => handleProjectChange(e.target.value)}
              disabled={projectSaving}
              className="px-2 py-1 bg-dark-800 border border-dark-600 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-indigo-500 max-w-[160px] disabled:opacity-60"
              title="Working project"
            >
              <option value="">No project</option>
              {projects?.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
          {agent.status === 'busy' && socket && (
            <button
              onClick={() => socket.emit('agent:stop', { agentId: agent.id })}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors text-sm font-medium"
              title="Stop agent"
            >
              <StopCircle className="w-4 h-4" />
              Stop
            </button>
          )}
          <button onClick={onClose} className="hidden lg:block p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-dark-700 px-2 overflow-x-auto">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-dark-400 hover:text-dark-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'chat' && (
          agent.isVoice ? (
            <VoiceChatTab agent={agent} />
          ) : (
            <ChatTab
              history={history}
              thinking={thinking}
              streamBuffer={streamBuffer}
              message={message}
              setMessage={setMessage}
              sending={sending || agent.status === 'busy'}
              isBusy={agent.status === 'busy'}
              onSend={handleSend}
              onStop={() => socket?.emit('agent:stop', { agentId: agent.id })}
              onClear={handleClearHistory}
              onTruncate={handleTruncateHistory}
              chatEndRef={chatEndRef}
              agentName={agent.name}
              autoScroll={autoScroll}
              onToggleAutoScroll={() => setAutoScroll(s => !s)}
            />
          )
        )}
        {activeTab === 'todos' && (
          <TodoTab agent={agent} socket={socket} onRefresh={onRefresh} />
        )}
        {activeTab === 'rag' && (
          <RagTab agent={agent} onRefresh={onRefresh} />
        )}
        {activeTab === 'handoff' && (
          <HandoffTab agent={agent} agents={agents} socket={socket} onRefresh={onRefresh} />
        )}
        {activeTab === 'plugins' && (
          <PluginsTab agent={agent} plugins={skills} onRefresh={onRefresh} />
        )}
        {activeTab === 'logs' && (
          <ActionLogsTab agent={agent} onRefresh={onRefresh} />
        )}
        {activeTab === 'settings' && (
          <SettingsTab agent={agent} projects={projects} currentProject={currentProject} onRefresh={onRefresh} />
        )}
      </div>
    </div>
  );
}

// ─── Chat Tab ──────────────────────────────────────────────────────────────
function ChatTab({ history, thinking, streamBuffer, message, setMessage, sending, isBusy, onSend, onStop, onClear, onTruncate, chatEndRef, agentName, autoScroll, onToggleAutoScroll }) {
  // When streamBuffer is active, the last assistant message in history may be
  // a duplicate (agent:updated can arrive before the buffer is cleared).
  // Hide it to prevent a brief "doubled text" flash.
  const displayHistory = (streamBuffer && history.length > 0 && history[history.length - 1].role === 'assistant')
    ? history.slice(0, -1)
    : history;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {displayHistory.length === 0 && !streamBuffer && (
          <div className="text-center py-12 text-dark-500">
            <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Start a conversation with {agentName}</p>
          </div>
        )}

        {displayHistory.map((msg, i) => (
          <ChatMessage key={i} message={msg} index={i} isLast={i === displayHistory.length - 1} onTruncate={onTruncate} />
        ))}

        {/* Thinking indicator (shown during reasoning before/alongside text) */}
        {thinking && !streamBuffer && (
          <div className="flex gap-3 animate-fadeIn">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
              AI
            </div>
            <div className="flex-1 bg-dark-800/50 rounded-xl p-3 border border-amber-500/20">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-xs text-amber-400 font-medium">Thinking...</span>
              </div>
              <div className="text-xs text-dark-400 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">
                {thinking.slice(-500)}
              </div>
            </div>
          </div>
        )}

        {/* Streaming response */}
        {streamBuffer && (
          <div className="flex gap-3 animate-fadeIn">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
              AI
            </div>
            <div className="flex-1 bg-dark-800/50 rounded-xl p-3 border border-dark-700/50">
              {thinking && (
                <details className="mb-2">
                  <summary className="text-xs text-amber-400 cursor-pointer hover:text-amber-300 flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Thinking...
                  </summary>
                  <div className="mt-1 text-xs text-dark-400 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto border-l-2 border-amber-500/30 pl-2">
                    {thinking.slice(-500)}
                  </div>
                </details>
              )}
              <div className="markdown-content text-sm text-dark-200">
                <RichAssistantContent text={streamBuffer} />
              </div>
              <div className="flex items-center gap-1 mt-2">
                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" />
                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" style={{ animationDelay: '0.2s' }} />
                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" style={{ animationDelay: '0.4s' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-dark-700 p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onClear}
            className="p-2 text-dark-500 hover:text-red-400 hover:bg-dark-700 rounded-lg transition-colors flex-shrink-0"
            title="Clear history"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={onToggleAutoScroll}
            className={`p-2 rounded-lg transition-colors flex-shrink-0 ${autoScroll ? 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20' : 'text-dark-500 hover:text-dark-300 hover:bg-dark-700'}`}
            title={autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
          >
            <ArrowDownToLine className="w-4 h-4" />
          </button>
          <div className="flex-1 relative">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              className="w-full px-4 py-2.5 bg-dark-800 border border-dark-600 rounded-xl text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 resize-none"
              placeholder="Type a message... (Shift+Enter for new line)"
              rows={1}
              disabled={sending}
            />
          </div>
          {isBusy ? (
            <button
              onClick={onStop}
              className="p-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-xl transition-colors flex-shrink-0"
              title="Stop agent"
            >
              <StopCircle className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={sending || !message.trim()}
              className="p-2.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ message, index, isLast, onTruncate }) {
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
            onClick={() => onTruncate(index)}
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
            <ReactMarkdown>{taskText}</ReactMarkdown>
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
            onClick={() => onTruncate(index)}
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
        <div className="markdown-content text-sm text-dark-200">
          {isUser
            ? <ReactMarkdown>{message.content}</ReactMarkdown>
            : <RichAssistantContent text={message.content} />
          }
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
          onClick={() => onTruncate(index)}
          className="absolute -right-1 top-1 opacity-0 group-hover:opacity-100 p-1 bg-dark-700 hover:bg-red-500/20 text-dark-400 hover:text-red-400 rounded-md transition-all border border-dark-600 hover:border-red-500/30"
          title="Restart from here"
        >
          <Scissors className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// Parse legacy tool results from raw [TOOL RESULTS] message content
function parseLegacyToolResults(content) {
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

// Parse legacy delegation results from raw [DELEGATION RESULTS] message content
function parseLegacyDelegationResults(content) {
  const results = [];
  const pattern = /---\s*Response from\s+(.+?)\s*---\n([\s\S]*?)(?=\n---\s*Response from|$)/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    results.push({ agentName: m[1].trim(), response: m[2].trim(), error: null });
  }
  return results;
}

// ─── Tool Result Collapsible Message ───────────────────────────────────────
function ToolResultMessage({ message }) {
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

function ToolResultItem({ result }) {
  const [showOutput, setShowOutput] = useState(!result.success); // auto-expand errors
  const argSummary = (result.args || []).map(a => typeof a === 'string' && a.length > 60 ? a.slice(0, 60) + '...' : a).join(', ');
  // For failed tools, show both the error message AND the actual output (stderr/stdout)
  const output = result.success
    ? result.result
    : [result.error, result.result].filter(Boolean).join('\n\n--- Output ---\n');
  const hasContent = !!output;

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
        <pre className={`mt-1 ml-3 p-2 rounded text-[11px] overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all ${
          result.success
            ? 'bg-dark-900/80 border border-dark-700/50 text-dark-400'
            : 'bg-red-500/5 border border-red-500/20 text-red-300'
        }`}>
          {typeof output === 'string' ? output.slice(0, 3000) : JSON.stringify(output, null, 2).slice(0, 3000)}
        </pre>
      )}
    </div>
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

// ─── Delegation Result Collapsible Message ─────────────────────────────────
function DelegationResultMessage({ message }) {
  const [expanded, setExpanded] = useState(false);
  const results = message.delegationResults?.length
    ? message.delegationResults
    : parseLegacyDelegationResults(message.content || '');
  const successCount = results.filter(r => r.response && !r.error).length;
  const errorCount = results.filter(r => r.error).length;

  return (
    <div className="mx-2 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-dark-800/70 border border-dark-700/50 hover:border-dark-600 transition-colors text-left group"
      >
        <Users className="w-4 h-4 text-indigo-400 flex-shrink-0" />
        <span className="text-xs font-medium text-dark-300 flex-1">
          {results.length} delegation{results.length !== 1 ? 's' : ''} completed
          {successCount > 0 && <span className="text-emerald-400 ml-1.5">{successCount} succeeded</span>}
          {errorCount > 0 && <span className="text-red-400 ml-1.5">{errorCount} failed</span>}
        </span>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-dark-500 group-hover:text-dark-300 transition-colors" />
          : <ChevronRight className="w-3.5 h-3.5 text-dark-500 group-hover:text-dark-300 transition-colors" />
        }
      </button>
      {expanded && (
        <div className="mt-1 ml-3 border-l-2 border-dark-700 pl-3 space-y-2 py-1">
          {results.map((r, i) => (
            <DelegationResultItem key={i} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function DelegationResultItem({ result }) {
  const [showDetail, setShowDetail] = useState(false);
  const output = result.response || result.error;

  return (
    <div className="text-xs">
      <button
        onClick={() => setShowDetail(!showDetail)}
        className="flex items-center gap-1.5 text-dark-400 hover:text-dark-200 transition-colors w-full text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${result.error ? 'bg-red-500' : 'bg-emerald-500'}`} />
        <span className="text-dark-300 font-medium">{result.agentName}</span>
        {result.task && <span className="text-dark-500 truncate max-w-[200px]">— {result.task.slice(0, 80)}</span>}
        {output && (showDetail
          ? <ChevronDown className="w-3 h-3 ml-auto flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 ml-auto flex-shrink-0" />
        )}
      </button>
      {showDetail && output && (
        <div className="mt-1 ml-3 p-2 rounded bg-dark-900/80 border border-dark-700/50 text-[11px] text-dark-400 overflow-x-auto max-h-48 overflow-y-auto">
          <ReactMarkdown>{typeof output === 'string' ? output.slice(0, 5000) : JSON.stringify(output, null, 2)}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ─── Todo Tab ──────────────────────────────────────────────────────────────
function TodoItem({ todo, executing, agentStatus, onToggle, onExecute, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const firstLine = todo.text.split('\n')[0];
  const isMultiline = todo.text.includes('\n') && todo.text.trim() !== firstLine.trim();

  useEffect(() => {
    const el = textRef.current;
    if (el) {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
  }, [todo.text]);

  const canExpand = isMultiline || isTruncated;
  const isDone = todo.status === 'done';
  const isInProgress = todo.status === 'in_progress';
  const isError = todo.status === 'error';
  const isPending = todo.status === 'pending' || !todo.status;
  const statusKey = todo.status || 'pending';
  const statusMeta = TODO_STATUS_META[statusKey] || TODO_STATUS_META.pending;

  const borderClass = isInProgress
    ? 'border-amber-500/50 bg-amber-500/5'
    : isError
      ? 'border-red-500/50 bg-red-500/5'
      : 'border-dark-700/50';

  const checkboxClass = isDone
    ? 'bg-indigo-500 border-indigo-500 text-white'
    : isInProgress
      ? 'bg-amber-500/20 border-amber-500 text-amber-400'
      : isError
        ? 'bg-red-500/20 border-red-500 text-red-400'
        : 'border-dark-500 hover:border-indigo-400';

  const textClass = isDone
    ? 'line-through text-dark-500'
    : isError
      ? 'text-red-300'
      : isInProgress
        ? 'text-amber-200'
        : 'text-dark-200';

  return (
    <div className={`bg-dark-800/50 rounded-lg border group transition-colors ${borderClass}`}>
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          onClick={() => onToggle(todo.id)}
          disabled={isInProgress}
          className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${checkboxClass}`}
        >
          {isDone && <span className="text-xs">✓</span>}
          {isInProgress && <Loader className="w-3 h-3 animate-spin" />}
          {isError && <XCircle className="w-3 h-3" />}
        </button>
        <div
          className={`flex-1 min-w-0 text-sm ${canExpand ? 'cursor-pointer select-none' : ''} ${textClass}`}
          onClick={() => canExpand && setExpanded(e => !e)}
        >
          <div className="flex items-center gap-1.5">
            {canExpand && (
              expanded
                ? <ChevronDown className="w-3 h-3 text-dark-400 flex-shrink-0" />
                : <ChevronRight className="w-3 h-3 text-dark-400 flex-shrink-0" />
            )}
            <span ref={textRef} className={expanded ? 'whitespace-normal break-words' : 'truncate'}>{firstLine}</span>
            {isInProgress && <span className="text-xs text-amber-400 font-medium ml-1 flex-shrink-0">In Progress</span>}
            {isError && <span className="text-xs text-red-400 font-medium ml-1 flex-shrink-0">Error</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {(isPending || isError) && (
            <button
              onClick={() => onExecute(todo.id)}
              disabled={!!executing || agentStatus === 'busy'}
              className="p-1 text-dark-500 hover:text-emerald-400 opacity-0 group-hover:opacity-100 disabled:opacity-30 transition-all"
              title={isError ? 'Retry this task' : 'Execute this task'}
            >
              {isError ? <RotateCw className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={() => onDelete(todo.id)}
            className="p-1 text-dark-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {isError && todo.error && (
        <div className="px-3 pb-2 ml-8">
          <p className="text-xs text-red-400/70">{todo.error}</p>
        </div>
      )}
      {canExpand && expanded && isMultiline && (
        <div className={`px-3 pb-2 ml-8 border-t border-dark-700/30 pt-2 ${isDone ? 'opacity-50' : ''}`}>
          <div className="markdown-content text-xs text-dark-300 leading-relaxed">
            <ReactMarkdown>{todo.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

function TodoTab({ agent, socket, onRefresh }) {
  const [newTodo, setNewTodo] = useState('');
  const [executing, setExecuting] = useState(null); // todoId or 'all'

  const handleAdd = async () => {
    if (!newTodo.trim()) return;
    await api.addTodo(agent.id, newTodo.trim(), agent.project || undefined);
    setNewTodo('');
    onRefresh();
  };

  const handleToggle = async (todoId) => {
    await api.toggleTodo(agent.id, todoId);
    onRefresh();
  };

  const handleDelete = async (todoId) => {
    await api.deleteTodo(agent.id, todoId);
    onRefresh();
  };

  const handleExecute = (todoId) => {
    if (!socket || executing) return;
    setExecuting(todoId);
    socket.emit('agent:todo:execute', { agentId: agent.id, todoId });
  };

  const handleExecuteAll = () => {
    if (!socket || executing) return;
    setExecuting('all');
    socket.emit('agent:todo:executeAll', { agentId: agent.id });
  };

  // Reset executing state when agent goes idle
  useEffect(() => {
    if (agent.status !== 'busy' && executing) {
      setExecuting(null);
    }
  }, [agent.status]);

  const done = agent.todoList?.filter(t => t.status === 'done').length || 0;
  const inProgress = agent.todoList?.filter(t => t.status === 'in_progress').length || 0;
  const errors = agent.todoList?.filter(t => t.status === 'error').length || 0;
  const total = agent.todoList?.length || 0;
  const runnable = agent.todoList?.filter(t => t.status === 'pending' || t.status === 'error').length || 0;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-dark-200 text-sm">Task List</h3>
        <div className="flex items-center gap-2">
          {runnable > 0 && (
            <button
              onClick={handleExecuteAll}
              disabled={!!executing || agent.status === 'busy'}
              className="flex items-center gap-1 px-2 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-md text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Execute all pending tasks"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              Run all ({runnable})
            </button>
          )}
          {total > 0 && (
            <span className="text-xs text-dark-400">
              {done}/{total} completed
              {inProgress > 0 && <span className="text-amber-400 ml-1">({inProgress} running)</span>}
              {errors > 0 && <span className="text-red-400 ml-1">({errors} failed)</span>}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="w-full bg-dark-700 rounded-full h-1.5 flex overflow-hidden">
          <div
            className="bg-indigo-500 h-1.5 transition-all duration-500"
            style={{ width: `${(done / total) * 100}%` }}
          />
          <div
            className="bg-amber-500 h-1.5 transition-all duration-500"
            style={{ width: `${(inProgress / total) * 100}%` }}
          />
          <div
            className="bg-red-500 h-1.5 transition-all duration-500"
            style={{ width: `${(errors / total) * 100}%` }}
          />
        </div>
      )}

      {/* Add todo */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          className="flex-1 px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
          placeholder="Add a new task..."
        />
        <button
          onClick={handleAdd}
          disabled={!newTodo.trim()}
          className="px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40 transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Todo list */}
      <div className="space-y-2">
        {(agent.todoList || []).map(todo => (
          <TodoItem
            key={todo.id}
            todo={todo}
            executing={executing}
            agentStatus={agent.status}
            onToggle={handleToggle}
            onExecute={handleExecute}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {total === 0 && (
        <p className="text-center text-dark-500 text-sm py-8">No tasks yet</p>
      )}
    </div>
  );
}

// ─── Plugins Tab ──────────────────────────────────────────────────────────

function PluginsTab({ agent, plugins, onRefresh }) {
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [editingPluginId, setEditingPluginId] = useState(null);
  const [savingPlugin, setSavingPlugin] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    description: '',
    category: 'coding',
    icon: '🔧',
    instructions: '',
    userConfig: {},
    mcps: [],
  });

  const agentPluginIds = agent.skills || [];
  const assignedPlugins = plugins.filter(s => agentPluginIds.includes(s.id));
  const availablePlugins = plugins.filter(s => !agentPluginIds.includes(s.id));

  const categories = ['all', ...new Set(plugins.map(s => s.category).filter(Boolean))];
  const filteredAvailable = categoryFilter === 'all'
    ? availablePlugins
    : availablePlugins.filter(s => s.category === categoryFilter);

  const handleAssign = async (pluginId) => {
    await api.assignPlugin(agent.id, pluginId);
    onRefresh();
  };

  const handleRemove = async (pluginId) => {
    await api.removePlugin(agent.id, pluginId);
    onRefresh();
  };

  const resetDraft = () => {
    setDraft({
      name: '',
      description: '',
      category: 'coding',
      icon: '🔧',
      instructions: '',
      userConfig: {},
      mcps: [],
    });
    setEditingPluginId(null);
    setShowCreate(false);
  };

  const handleCreate = async () => {
    if (!draft.name.trim() || !draft.instructions.trim()) return;
    setSavingPlugin(true);
    try {
      await api.createPlugin(draft);
      resetDraft();
      onRefresh();
    } finally {
      setSavingPlugin(false);
    }
  };

  const handleEdit = (plugin) => {
    setEditingPluginId(plugin.id);
    setShowCreate(false);
    setDraft({
      name: plugin.name || '',
      description: plugin.description || '',
      category: plugin.category || 'general',
      icon: plugin.icon || '🔧',
      instructions: plugin.instructions || '',
      userConfig: plugin.userConfig || {},
      mcps: Array.isArray(plugin.mcps) ? plugin.mcps : [],
    });
  };

  const handleUpdate = async () => {
    if (!editingPluginId || !draft.name.trim() || !draft.instructions.trim()) return;
    setSavingPlugin(true);
    try {
      await api.updatePlugin(editingPluginId, draft);
      resetDraft();
      onRefresh();
    } finally {
      setSavingPlugin(false);
    }
  };

  const handleDelete = async (pluginId, pluginName) => {
    if (!confirm(`Delete plugin "${pluginName}"?`)) return;
    await api.deletePlugin(pluginId);
    if (editingPluginId === pluginId) resetDraft();
    onRefresh();
  };

  const categoryColors = {
    coding: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    devops: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    writing: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    security: 'bg-red-500/20 text-red-400 border-red-500/30',
    analysis: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    general: 'bg-dark-500/20 text-dark-300 border-dark-500/30',
  };

  const getCategoryClass = (cat) => categoryColors[cat] || categoryColors.general;

  return (
    <div className="p-4 space-y-5 overflow-auto">
      <div>
        <h3 className="font-medium text-dark-200 text-sm mb-3">
          Assigned Plugins
          <span className="ml-2 text-dark-400 font-normal">({assignedPlugins.length})</span>
        </h3>
        {assignedPlugins.length > 0 ? (
          <div className="space-y-2">
            {assignedPlugins.map(plugin => (
              <div key={plugin.id} className="flex items-center gap-3 p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 group">
                <span className="text-lg flex-shrink-0">{plugin.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-dark-200">{plugin.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
                      {plugin.category}
                    </span>
                    {(plugin.mcps || []).length > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                        {(plugin.mcps || []).length} MCP
                      </span>
                    )}
                    {plugin.userConfig && Object.keys(plugin.userConfig).length > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-500/20 text-amber-400 border-amber-500/30">
                        config utilisateur
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-dark-400 truncate">{plugin.description}</p>
                </div>
                <button
                  onClick={() => handleEdit(plugin)}
                  className="p-1 text-dark-500 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                  title="Edit plugin"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleRemove(plugin.id)}
                  className="p-1 text-dark-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                  title="Remove plugin"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-4 border border-dashed border-dark-700 rounded-lg">
            <Wrench className="w-5 h-5 mx-auto mb-1 text-dark-500 opacity-40" />
            <p className="text-dark-500 text-xs">No plugins assigned</p>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-dark-200 text-sm">
            Available Plugins
            <span className="ml-2 text-dark-400 font-normal">({filteredAvailable.length})</span>
          </h3>
          <button
            onClick={() => {
              setEditingPluginId(null);
              setShowCreate(v => !v);
              if (!showCreate) {
                setDraft({
                  name: '',
                  description: '',
                  category: 'coding',
                  icon: '🔧',
                  instructions: '',
                  userConfig: {},
                  mcps: [],
                });
              }
            }}
            className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors border ${
                categoryFilter === cat
                  ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                  : 'bg-dark-800 text-dark-400 border-dark-700 hover:text-dark-200'
              }`}
            >
              {cat === 'all' ? 'All' : cat}
            </button>
          ))}
        </div>

        {showCreate && (
          <PluginEditor
            value={draft}
            onChange={setDraft}
            onSubmit={handleCreate}
            onCancel={resetDraft}
            saving={savingPlugin}
            submitLabel="Create Plugin"
          />
        )}

        {editingPluginId && (
          <PluginEditor
            value={draft}
            onChange={setDraft}
            onSubmit={handleUpdate}
            onCancel={resetDraft}
            saving={savingPlugin}
            submitLabel="Save Plugin"
          />
        )}

        <div className="space-y-2 mt-3">
          {filteredAvailable.map(plugin => (
            <div key={plugin.id} className="flex items-center gap-3 p-3 bg-dark-800/30 rounded-lg border border-dark-700/30 hover:border-dark-600 transition-colors group">
              <span className="text-lg flex-shrink-0">{plugin.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-dark-300">{plugin.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
                    {plugin.category}
                  </span>
                  {(plugin.mcps || []).length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                      {(plugin.mcps || []).length} MCP
                    </span>
                  )}
                  {plugin.userConfig && Object.keys(plugin.userConfig).length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-500/20 text-amber-400 border-amber-500/30">
                      config utilisateur
                    </span>
                  )}
                </div>
                <p className="text-xs text-dark-500 truncate">{plugin.description}</p>
              </div>
              <button
                onClick={() => handleEdit(plugin)}
                className="p-1 text-dark-500 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                title="Edit plugin"
              >
                <Edit3 className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(plugin.id, plugin.name)}
                className="p-1 text-dark-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                title="Delete plugin"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleAssign(plugin.id)}
                className="px-2.5 py-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 rounded-md text-xs font-medium transition-colors flex-shrink-0"
              >
                Add
              </button>
            </div>
          ))}
          {filteredAvailable.length === 0 && !showCreate && !editingPluginId && (
            <p className="text-center text-dark-500 text-xs py-4">
              {availablePlugins.length === 0 ? 'All plugins assigned' : 'No plugins in this category'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── RAG Tab ───────────────────────────────────────────────────────────────
function RagTab({ agent, onRefresh }) {
  const [showAdd, setShowAdd] = useState(false);
  const [docName, setDocName] = useState('');
  const [docContent, setDocContent] = useState('');

  const handleAdd = async () => {
    if (!docName.trim() || !docContent.trim()) return;
    await api.addRagDoc(agent.id, docName.trim(), docContent.trim());
    setDocName('');
    setDocContent('');
    setShowAdd(false);
    onRefresh();
  };

  const handleDelete = async (docId) => {
    if (!confirm('Remove this document?')) return;
    await api.deleteRagDoc(agent.id, docId);
    onRefresh();
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      setDocName(file.name);
      setDocContent(ev.target.result);
      setShowAdd(true);
    };
    reader.readAsText(file);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-dark-200 text-sm">
          RAG Documents
          <span className="ml-2 text-dark-400 font-normal">({agent.ragDocuments?.length || 0})</span>
        </h3>
        <div className="flex gap-2">
          <label className="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-xs cursor-pointer transition-colors">
            Upload File
            <input type="file" className="hidden" accept=".txt,.md,.json,.csv,.xml,.yaml,.yml" onChange={handleFileUpload} />
          </label>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 space-y-3 animate-fadeIn">
          <input
            type="text"
            value={docName}
            onChange={(e) => setDocName(e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
            placeholder="Document name"
          />
          <textarea
            value={docContent}
            onChange={(e) => setDocContent(e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
            placeholder="Document content..."
            rows={6}
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={!docName.trim() || !docContent.trim()}
              className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40"
            >
              Add Document
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {(agent.ragDocuments || []).map(doc => (
          <div key={doc.id} className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 group">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                <span className="text-sm font-medium text-dark-200">{doc.name}</span>
              </div>
              <button
                onClick={() => handleDelete(doc.id)}
                className="p-1 text-dark-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-xs text-dark-400 font-mono line-clamp-3">{doc.content}</p>
            <p className="text-[10px] text-dark-500 mt-1">{doc.content.length} chars · Added {new Date(doc.addedAt).toLocaleDateString()}</p>
          </div>
        ))}
      </div>

      {(!agent.ragDocuments || agent.ragDocuments.length === 0) && !showAdd && (
        <div className="text-center py-8">
          <FileText className="w-8 h-8 mx-auto mb-2 text-dark-500 opacity-30" />
          <p className="text-dark-500 text-sm">No documents attached</p>
          <p className="text-dark-600 text-xs mt-1">Add reference documents for context-aware responses</p>
        </div>
      )}
    </div>
  );
}

// ─── Handoff Tab ───────────────────────────────────────────────────────────
function HandoffTab({ agent, agents, socket, onRefresh }) {
  const [targetId, setTargetId] = useState('');
  const [context, setContext] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const otherAgents = agents.filter(a => a.id !== agent.id && a.enabled !== false);

  const handleHandoff = async () => {
    if (!targetId || !context.trim()) return;
    setSending(true);
    setResult(null);

    try {
      if (socket) {
        socket.emit('agent:handoff', { fromId: agent.id, toId: targetId, context: context.trim() });
        socket.once('agent:handoff:complete', (data) => {
          setResult({ success: true, response: data.response });
          setSending(false);
        });
        socket.once('agent:handoff:error', (data) => {
          setResult({ success: false, error: data.error });
          setSending(false);
        });
      } else {
        const res = await api.handoff(agent.id, targetId, context.trim());
        setResult({ success: true, response: res.response });
        setSending(false);
      }
    } catch (err) {
      setResult({ success: false, error: err.message });
      setSending(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <h3 className="font-medium text-dark-200 text-sm">Handoff Conversation</h3>
      <p className="text-xs text-dark-400">
        Transfer the conversation context from <strong>{agent.name}</strong> to another agent.
      </p>

      {otherAgents.length === 0 ? (
        <div className="text-center py-8">
          <ArrowRightLeft className="w-8 h-8 mx-auto mb-2 text-dark-500 opacity-30" />
          <p className="text-dark-500 text-sm">No other agents available for handoff</p>
        </div>
      ) : (
        <>
          <div>
            <label className="block text-xs text-dark-400 mb-1.5">Target Agent</label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
            >
              <option value="">Select an agent...</option>
              {otherAgents.map(a => (
                <option key={a.id} value={a.id}>{a.icon} {a.name} ({a.role})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-dark-400 mb-1.5">Handoff Context</label>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 resize-none"
              placeholder="Describe what the next agent should continue working on..."
              rows={4}
            />
          </div>

          <button
            onClick={handleHandoff}
            disabled={sending || !targetId || !context.trim()}
            className="w-full py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
          >
            {sending ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Handing off...
              </>
            ) : (
              <>
                <ArrowRightLeft className="w-4 h-4" />
                Initiate Handoff
              </>
            )}
          </button>

          {result && (
            <div className={`p-3 rounded-lg border text-sm animate-fadeIn ${
              result.success
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
            }`}>
              {result.success ? (
                <div>
                  <p className="font-medium mb-1">Handoff successful!</p>
                  <div className="text-dark-300 markdown-content">
                    <ReactMarkdown>{result.response}</ReactMarkdown>
                  </div>
                </div>
              ) : (
                <p className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  {result.error}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Action Logs Tab ───────────────────────────────────────────────────────
function formatDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function ActionLogsTab({ agent, onRefresh }) {
  const logs = agent.actionLogs || [];

  const handleClear = async () => {
    if (!confirm('Clear all action logs?')) return;
    await api.clearActionLogs(agent.id);
    onRefresh();
  };

  const typeConfig = {
    busy:  { icon: Zap,          color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   label: 'Busy' },
    idle:  { icon: Clock,        color: 'text-emerald-400', bg: 'bg-emerald-500/10',  border: 'border-emerald-500/20', label: 'Idle' },
    error: { icon: AlertCircle,  color: 'text-red-400',     bg: 'bg-red-500/10',      border: 'border-red-500/20',     label: 'Error' },
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-dark-200 text-sm">Action Logs</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-dark-400">{logs.length} entries</span>
          {logs.length > 0 && (
            <button
              onClick={handleClear}
              className="flex items-center gap-1 px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-md text-xs font-medium transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>
          )}
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="text-center py-12 text-dark-500">
          <Activity className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No action logs yet</p>
          <p className="text-xs mt-1">Logs appear when the agent starts working, finishes, or encounters errors.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {[...logs].reverse().map(log => {
            const config = typeConfig[log.type] || typeConfig.idle;
            const Icon = config.icon;
            return (
              <div
                key={log.id}
                className={`flex items-start gap-3 p-3 rounded-lg border ${config.bg} ${config.border}`}
              >
                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${config.color}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold ${config.color}`}>
                        {config.label}
                      </span>
                      {log.durationMs != null && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${config.bg} ${config.color} opacity-80`}>
                          {formatDuration(log.durationMs)}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-dark-500">
                      {new Date(log.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-dark-300 mt-0.5">{log.message}</p>
                  {log.error && (
                    <pre className="text-xs text-red-300/80 mt-1 whitespace-pre-wrap break-words bg-red-500/5 rounded p-2">
                      {log.error}
                    </pre>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Settings Tab ──────────────────────────────────────────────────────────
function SettingsTab({ agent, projects, currentProject, onRefresh }) {
  const [form, setForm] = useState({
    name: agent.name,
    role: agent.role,
    description: agent.description,
    instructions: agent.instructions,
    temperature: agent.temperature,
    temperatureEnabled: agent.temperature != null,
    maxTokens: agent.maxTokens,
    contextLength: agent.contextLength || 0,
    provider: agent.provider,
    model: agent.model,
    endpoint: agent.endpoint || '',
    apiKey: agent.apiKey || '',
    icon: agent.icon,
    color: agent.color,
    project: agent.project || '',
    enabled: agent.enabled !== false,
    isReasoning: agent.isReasoning || false,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset form when switching agents
  useEffect(() => {
    setForm({
      name: agent.name,
      role: agent.role,
      description: agent.description,
      instructions: agent.instructions,
      temperature: agent.temperature,
      temperatureEnabled: agent.temperature != null,
      maxTokens: agent.maxTokens,
      contextLength: agent.contextLength || 0,
      provider: agent.provider,
      model: agent.model,
      endpoint: agent.endpoint || '',
      apiKey: agent.apiKey || '',
      icon: agent.icon,
      color: agent.color,
      project: agent.project || '',
      enabled: agent.enabled !== false,
      isReasoning: agent.isReasoning || false,
    });
    setSaved(false);
  }, [agent.id]);

  useEffect(() => {
    setForm(prev => {
      const nextProject = currentProject || '';
      return prev.project === nextProject ? prev : { ...prev, project: nextProject };
    });
  }, [currentProject]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { temperatureEnabled, ...payload } = form;
      payload.temperature = temperatureEnabled ? payload.temperature : null;
      await api.updateAgent(agent.id, payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteAgent(agent.id);
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setDeleting(false);
    }
  };

  const updateField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  return (
    <div className="p-4 space-y-4">
      {/* Enabled toggle */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <div>
          <span className="text-sm text-dark-200">Agent enabled</span>
          <p className="text-[11px] text-dark-500 mt-0.5">Disabled agents are excluded from delegation, broadcast, and handoff</p>
        </div>
        <button
          onClick={() => updateField('enabled', !form.enabled)}
          className={`relative w-10 h-5 rounded-full transition-colors ${form.enabled ? 'bg-indigo-500' : 'bg-dark-600'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${form.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Name</label>
          <input
            type="text" value={form.name}
            onChange={(e) => updateField('name', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Role</label>
          <input
            type="text" value={form.role}
            onChange={(e) => updateField('role', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Icon</label>
          <input
            type="text" value={form.icon}
            onChange={(e) => updateField('icon', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
            maxLength={4}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 resize-none"
            rows={2}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">System Instructions</label>
          <textarea
            value={form.instructions}
            onChange={(e) => updateField('instructions', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono resize-none"
            rows={6}
          />
        </div>
        <div className="col-span-2 hidden lg:block">
          <label className="block text-xs text-dark-400 mb-1.5 flex items-center gap-1.5">
            <FolderCode className="w-3.5 h-3.5" /> Working Project
          </label>
          <select
            value={form.project}
            onChange={(e) => updateField('project', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="">No project selected</option>
            {projects?.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Provider</label>
          <select
            value={form.provider}
            onChange={(e) => updateField('provider', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="ollama">Ollama</option>
            <option value="claude">Claude</option>
            <option value="openai">OpenAI</option>
            <option value="mistral">Mistral AI</option>
            <option value="vllm">vLLM (Custom Server)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Model</label>
          <input
            type="text" value={form.model}
            onChange={(e) => updateField('model', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
          />
        </div>
        {form.provider === 'ollama' && (
          <div className="col-span-2">
            <label className="block text-xs text-dark-400 mb-1.5">Endpoint URL</label>
            <input
              type="text" value={form.endpoint}
              onChange={(e) => updateField('endpoint', e.target.value)}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
              placeholder="https://..."
            />
          </div>
        )}
        {form.provider === 'claude' && (
          <div className="col-span-2">
            <label className="block text-xs text-dark-400 mb-1.5">API Key</label>
            <input
              type="password" value={form.apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
              placeholder="sk-ant-..."
            />
            <p className="text-[11px] text-dark-500 mt-1">Leave blank to use server default key</p>
          </div>
        )}
        {form.provider === 'openai' && (
          <div className="col-span-2">
            <label className="block text-xs text-dark-400 mb-1.5">API Key</label>
            <input
              type="password" value={form.apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
              placeholder="sk-..."
            />
            <p className="text-[11px] text-dark-500 mt-1">Leave blank to use server default key</p>
          </div>
        )}
        {form.provider === 'vllm' && (
          <>
            <div className="col-span-2">
              <label className="block text-xs text-dark-400 mb-1.5">Server URL *</label>
              <input
                type="text" value={form.endpoint}
                onChange={(e) => updateField('endpoint', e.target.value)}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                placeholder="http://localhost:8000"
              />
              <p className="text-[11px] text-dark-500 mt-1">Base URL of your vLLM server (OpenAI-compatible API)</p>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-dark-400 mb-1.5">API Key (optional)</label>
              <input
                type="password" value={form.apiKey}
                onChange={(e) => updateField('apiKey', e.target.value)}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                placeholder="token-..."
              />
              <p className="text-[11px] text-dark-500 mt-1">Leave blank if your vLLM server doesn't require authentication</p>
            </div>
          </>
        )}
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <input
              type="checkbox" checked={form.temperatureEnabled}
              onChange={(e) => {
                updateField('temperatureEnabled', e.target.checked);
                if (e.target.checked && form.temperature == null) updateField('temperature', 0.7);
              }}
              className="accent-indigo-500"
            />
            <label className="text-xs text-dark-400">
              Temperature{form.temperatureEnabled ? `: ${form.temperature}` : ' (disabled — using model default)'}
            </label>
          </div>
          {form.temperatureEnabled && (
            <input
              type="range" min="0" max="1" step="0.1" value={form.temperature ?? 0.7}
              onChange={(e) => updateField('temperature', parseFloat(e.target.value))}
              className="w-full accent-indigo-500"
            />
          )}
        </div>
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox" checked={form.isReasoning}
              onChange={(e) => updateField('isReasoning', e.target.checked)}
              className="accent-indigo-500"
            />
            <span className="text-xs text-dark-400">Reasoning model</span>
          </label>
          <p className="text-[11px] text-dark-500 mt-1">Uses 'developer' role instead of 'system', disables temperature</p>
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Max Tokens <span className="text-dark-500">(output)</span></label>
          <input
            type="number" value={form.maxTokens}
            onChange={(e) => updateField('maxTokens', parseInt(e.target.value) || 128000)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">
            Context Length (Ollama) <span className="text-dark-500">0 = 8192 par défaut</span>
          </label>
          <input
            type="number" value={form.contextLength}
            onChange={(e) => updateField('contextLength', parseInt(e.target.value) || 0)}
            placeholder="8192"
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Color</label>
          <input
            type="color" value={form.color}
            onChange={(e) => updateField('color', e.target.value)}
            className="h-9 w-full rounded-lg border border-dark-600 cursor-pointer bg-dark-800"
          />
        </div>
      </div>

      {/* Metrics */}
      <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <h4 className="text-xs font-medium text-dark-300 mb-2">Metrics</h4>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <p className="text-dark-500">Messages</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalMessages || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Tokens In</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalTokensIn || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Tokens Out</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalTokensOut || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Errors</p>
            <p className="font-mono text-dark-200">{agent.metrics?.errors || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Last Active</p>
            <p className="font-mono text-dark-200 text-[10px]">
              {agent.metrics?.lastActiveAt ? new Date(agent.metrics.lastActiveAt).toLocaleTimeString() : 'Never'}
            </p>
          </div>
          <div>
            <p className="text-dark-500">Created</p>
            <p className="font-mono text-dark-200 text-[10px]">
              {new Date(agent.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        >
          {saving ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : saved ? (
            <>
              <span className="text-emerald-300">✓</span> Saved!
            </>
          ) : (
            <>
              <Save className="w-4 h-4" /> Save Changes
            </>
          )}
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-sm font-medium transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
