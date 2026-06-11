import { useState, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { Plus, Trash2, FileText, ArrowRightLeft, AlertCircle, BarChart3, Globe, RefreshCw, Link, Save, ScrollText } from 'lucide-react';
import { api } from '../../api';
import { WsEvents } from '../../socketEvents';

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

// Handoff runs a full LLM generation server-side, so be generous before
// declaring the request lost.
const HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;

export default function ContextTab({ agent, agents, socket, onRefresh }) {
  // RAG state
  const [showAdd, setShowAdd] = useState(false);
  const [showAddUrl, setShowAddUrl] = useState(false);
  const [docName, setDocName] = useState('');
  const [docContent, setDocContent] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [refreshingDocId, setRefreshingDocId] = useState<string | null>(null);

  // System Instructions state
  const [instructions, setInstructions] = useState(agent.instructions || '');
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);

  useEffect(() => {
    setInstructions(agent.instructions || '');
    setInstructionsSaved(false);
  }, [agent.id]);

  const handleSaveInstructions = async () => {
    setInstructionsSaving(true);
    try {
      await api.updateAgent(agent.id, { instructions });
      setInstructionsSaved(true);
      setTimeout(() => setInstructionsSaved(false), 2000);
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setInstructionsSaving(false);
    }
  };

  // Handoff state
  const [targetId, setTargetId] = useState('');
  const [context, setContext] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  // Detaches the in-flight handoff's socket listeners + timeout, so they
  // don't leak (and fire setState) after unmount or consume a later handoff.
  const handoffCleanupRef = useRef(null);
  useEffect(() => () => { handoffCleanupRef.current?.(); }, []);

  const otherAgents = agents.filter(a => a.id !== agent.id && a.enabled !== false);

  // --- Stats ---
  const stats = useMemo(() => {
    const docs = agent.ragDocuments || [];
    const history = agent.conversationHistory || [];

    const docsChars = docs.reduce((sum, d) => sum + (d.content?.length || 0), 0);
    const docsTokens = estimateTokens('x'.repeat(docsChars));

    const historyChars = history.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      return sum + content.length;
    }, 0);
    const historyTokens = estimateTokens('x'.repeat(historyChars));

    const systemPromptEstimate = estimateTokens('x'.repeat(agent.systemPrompt?.length || 0));

    const urlCount = docs.filter(d => d.type === 'url').length;

    return {
      docsCount: docs.length,
      urlCount,
      docsChars,
      docsTokens,
      historyMessages: history.length,
      historyChars,
      historyTokens,
      systemPromptTokens: systemPromptEstimate,
      totalTokens: docsTokens + historyTokens + systemPromptEstimate,
    };
  }, [agent.ragDocuments, agent.conversationHistory, agent.systemPrompt]);

  // --- RAG handlers ---
  const handleAdd = async () => {
    if (!docName.trim() || !docContent.trim()) return;
    await api.addRagDoc(agent.id, docName.trim(), docContent.trim());
    setDocName('');
    setDocContent('');
    setShowAdd(false);
    onRefresh();
  };

  const handleAddUrl = async () => {
    if (!docName.trim() || !docUrl.trim()) return;
    setUrlLoading(true);
    setUrlError('');
    try {
      await api.addRagUrl(agent.id, docName.trim(), docUrl.trim());
      setDocName('');
      setDocUrl('');
      setShowAddUrl(false);
      onRefresh();
    } catch (err: any) {
      setUrlError(err.message || 'Failed to fetch URL');
    } finally {
      setUrlLoading(false);
    }
  };

  const handleRefreshUrl = async (docId: string) => {
    setRefreshingDocId(docId);
    try {
      await api.refreshRagDoc(agent.id, docId);
      onRefresh();
    } catch (err: any) {
      alert(`Refresh failed: ${err.message}`);
    } finally {
      setRefreshingDocId(null);
    }
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
      setDocContent(ev.target?.result as string);
      setShowAdd(true);
    };
    reader.readAsText(file);
  };

  // --- Handoff handler ---
  const handleHandoff = async () => {
    if (!targetId || !context.trim()) return;
    setSending(true);
    setResult(null);

    try {
      if (socket) {
        handoffCleanupRef.current?.();
        const fromId = agent.id;
        const toId = targetId;
        let timer = null;
        const cleanup = () => {
          socket.off(WsEvents.HANDOFF_COMPLETE, onComplete);
          socket.off(WsEvents.HANDOFF_ERROR, onError);
          if (timer) clearTimeout(timer);
          handoffCleanupRef.current = null;
        };
        const onComplete = (data) => {
          // Ignore completions belonging to a different handoff request.
          if (data?.fromId && data?.toId && (data.fromId !== fromId || data.toId !== toId)) return;
          cleanup();
          setResult({ success: true, response: data?.response });
          setSending(false);
        };
        const onError = (data) => {
          cleanup();
          setResult({ success: false, error: data?.error || 'Handoff failed' });
          setSending(false);
        };
        socket.on(WsEvents.HANDOFF_COMPLETE, onComplete);
        socket.on(WsEvents.HANDOFF_ERROR, onError);
        // If the server never responds (handler crash, reconnect between
        // request and response), unstick the button instead of spinning forever.
        timer = setTimeout(() => {
          cleanup();
          setResult({ success: false, error: 'Handoff timed out — no response from the server.' });
          setSending(false);
        }, HANDOFF_TIMEOUT_MS);
        handoffCleanupRef.current = cleanup;
        socket.emit(WsEvents.REQ_HANDOFF, { fromId, toId, context: context.trim() });
      } else {
        const res = await api.handoff(agent.id, targetId, context.trim());
        setResult({ success: true, response: res.response });
        setSending(false);
      }
    } catch (err: any) {
      setResult({ success: false, error: err.message });
      setSending(false);
    }
  };

  const formatNumber = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className="p-4 space-y-6">
      {/* System Instructions */}
      <div>
        <h3 className="font-medium text-dark-200 text-sm flex items-center gap-2 mb-3">
          <ScrollText className="w-4 h-4 text-indigo-400" />
          System Instructions
        </h3>
        <textarea
          value={instructions}
          onChange={(e) => { setInstructions(e.target.value); setInstructionsSaved(false); }}
          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono resize-none"
          rows={10}
          placeholder="Enter system instructions for this agent..."
        />
        <div className="flex items-center justify-between mt-2">
          <p className="text-[10px] text-dark-500">
            ~{formatNumber(estimateTokens(instructions))} tokens
          </p>
          <button
            onClick={handleSaveInstructions}
            disabled={instructionsSaving || instructions === (agent.instructions || '')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs font-medium disabled:opacity-40 transition-colors"
          >
            {instructionsSaving ? (
              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : instructionsSaved ? (
              <span className="text-emerald-300">&#10003; Saved</span>
            ) : (
              <><Save className="w-3 h-3" /> Save</>
            )}
          </button>
        </div>
      </div>

      {/* Context Stats */}
      <div>
        <h3 className="font-medium text-dark-200 text-sm flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-indigo-400" />
          Context Stats
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="p-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50 text-center">
            <p className="text-lg font-bold text-dark-100">{formatNumber(stats.totalTokens)}</p>
            <p className="text-[10px] text-dark-500 uppercase tracking-wider">Total tokens</p>
          </div>
          <div className="p-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50 text-center">
            <p className="text-lg font-bold text-indigo-400">{formatNumber(stats.docsTokens)}</p>
            <p className="text-[10px] text-dark-500 uppercase tracking-wider">Docs ({stats.docsCount}{stats.urlCount > 0 ? `, ${stats.urlCount} URL` : ''})</p>
          </div>
          <div className="p-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50 text-center">
            <p className="text-lg font-bold text-emerald-400">{formatNumber(stats.historyTokens)}</p>
            <p className="text-[10px] text-dark-500 uppercase tracking-wider">Chat ({stats.historyMessages} msgs)</p>
          </div>
          <div className="p-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50 text-center">
            <p className="text-lg font-bold text-amber-400">{formatNumber(stats.systemPromptTokens)}</p>
            <p className="text-[10px] text-dark-500 uppercase tracking-wider">System prompt</p>
          </div>
        </div>
      </div>

      {/* RAG Documents */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-dark-200 text-sm flex items-center gap-2">
            <FileText className="w-4 h-4 text-indigo-400" />
            Documents
            <span className="text-dark-400 font-normal">({agent.ragDocuments?.length || 0})</span>
          </h3>
          <div className="flex gap-2">
            <label className="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-xs cursor-pointer transition-colors">
              Upload File
              <input type="file" className="hidden" accept=".txt,.md,.json,.csv,.xml,.yaml,.yml" onChange={handleFileUpload} />
            </label>
            <button
              onClick={() => { setShowAddUrl(!showAddUrl); setShowAdd(false); }}
              className="flex items-center gap-1 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-xs transition-colors"
            >
              <Globe className="w-3 h-3" />
              URL
            </button>
            <button
              onClick={() => { setShowAdd(!showAdd); setShowAddUrl(false); }}
              className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {showAdd && (
          <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 space-y-3 animate-fadeIn mb-3">
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

        {showAddUrl && (
          <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 space-y-3 animate-fadeIn mb-3">
            <input
              type="text"
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
              placeholder="Document name (e.g. API Reference)"
            />
            <div className="flex items-center gap-2">
              <Link className="w-4 h-4 text-dark-400 flex-shrink-0" />
              <input
                type="url"
                value={docUrl}
                onChange={(e) => setDocUrl(e.target.value)}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
                placeholder="https://example.com/docs/api.md"
              />
            </div>
            <p className="text-[10px] text-dark-500">
              The URL content will be fetched now and automatically refreshed every hour during agent sessions.
            </p>
            {urlError && (
              <p className="text-xs text-red-400 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {urlError}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowAddUrl(false); setUrlError(''); }} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">
                Cancel
              </button>
              <button
                onClick={handleAddUrl}
                disabled={!docName.trim() || !docUrl.trim() || urlLoading}
                className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40 flex items-center gap-1.5"
              >
                {urlLoading ? (
                  <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Fetching...</>
                ) : (
                  <><Globe className="w-3 h-3" /> Add URL</>
                )}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {(agent.ragDocuments || []).map(doc => {
            const isUrl = doc.type === 'url';
            const isRefreshing = refreshingDocId === doc.id;
            return (
              <div key={doc.id} className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 group">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {isUrl ? <Globe className="w-4 h-4 text-cyan-400 flex-shrink-0" /> : <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0" />}
                    <span className="text-sm font-medium text-dark-200 truncate">{doc.name}</span>
                    {isUrl && (
                      <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-cyan-400/70 hover:text-cyan-400 truncate max-w-[200px]">
                        {doc.url}
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                    {isUrl && (
                      <button
                        onClick={() => handleRefreshUrl(doc.id)}
                        disabled={isRefreshing}
                        className="p-1 text-dark-500 hover:text-cyan-400 disabled:opacity-40"
                        title="Refresh from URL"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="p-1 text-dark-500 hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-dark-400 font-mono line-clamp-3">{doc.content}</p>
                <p className="text-[10px] text-dark-500 mt-1">
                  {doc.content?.length || 0} chars · ~{formatNumber(estimateTokens(doc.content || ''))} tokens · Added {new Date(doc.addedAt).toLocaleDateString()}
                  {isUrl && doc.lastFetched && <> · Fetched {new Date(doc.lastFetched).toLocaleString()}</>}
                </p>
              </div>
            );
          })}
        </div>

        {(!agent.ragDocuments || agent.ragDocuments.length === 0) && !showAdd && (
          <div className="text-center py-6">
            <FileText className="w-7 h-7 mx-auto mb-2 text-dark-500 opacity-30" />
            <p className="text-dark-500 text-sm">No documents attached</p>
            <p className="text-dark-600 text-xs mt-1">Add reference documents for context-aware responses</p>
          </div>
        )}
      </div>

      {/* Handoff */}
      <div>
        <h3 className="font-medium text-dark-200 text-sm flex items-center gap-2 mb-3">
          <ArrowRightLeft className="w-4 h-4 text-indigo-400" />
          Handoff Conversation
        </h3>
        <p className="text-xs text-dark-400 mb-3">
          Transfer the conversation context from <strong>{agent.name}</strong> to another agent.
        </p>

        {otherAgents.length === 0 ? (
          <div className="text-center py-6">
            <ArrowRightLeft className="w-7 h-7 mx-auto mb-2 text-dark-500 opacity-30" />
            <p className="text-dark-500 text-sm">No other agents available for handoff</p>
          </div>
        ) : (
          <div className="space-y-3">
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
          </div>
        )}
      </div>
    </div>
  );
}
