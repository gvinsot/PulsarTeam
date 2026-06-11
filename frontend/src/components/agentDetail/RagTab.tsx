import { useState } from 'react';
import { Plus, Trash2, FileText } from 'lucide-react';
import { api } from '../../api';

export default function RagTab({ agent, onRefresh }) {
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
      const text = ev.target.result;
      // readAsText always yields a string; guard narrows the type.
      if (typeof text !== 'string') return;
      setDocName(file.name);
      setDocContent(text);
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
