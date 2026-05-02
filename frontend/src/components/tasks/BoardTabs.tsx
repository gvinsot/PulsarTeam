import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Trash2, Edit3, ChevronDown, Plus, KanbanSquare, Users, Share2,
} from 'lucide-react';

export default function BoardTabs({ boards, activeBoardId, onSelect, onCreate, onRename, onDelete, onShare }) {
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const renameRef = useRef(null);
  const contextRef = useRef(null);
  const triggerRefs = useRef({});

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e) => {
      if (contextRef.current && !contextRef.current.contains(e.target)) setContextMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  const handleRenameSubmit = (boardId) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== (boards || []).find(b => b.id === boardId)?.name) {
      onRename(boardId, trimmed);
    }
    setRenaming(null);
  };

  const openContextMenu = (boardId, triggerEl) => {
    if (contextMenu === boardId) {
      setContextMenu(null);
      return;
    }
    if (triggerEl) {
      const rect = triggerEl.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
    setContextMenu(boardId);
  };

  return (
    <div className="flex items-center gap-2 px-6 py-3 border-b border-dark-700/50 bg-dark-900/50 overflow-x-auto scrollbar-hide relative z-20">
      {(boards || []).map(board => (
        <div key={board.id} className="relative flex-shrink-0">
          {renaming === board.id ? (
            <input
              ref={renameRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={() => handleRenameSubmit(board.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRenameSubmit(board.id);
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="px-3 py-1.5 bg-dark-800 border border-indigo-500/50 rounded-lg text-sm text-dark-200
                focus:outline-none focus:border-indigo-500 w-36"
            />
          ) : (
            <button
              ref={el => { triggerRefs.current[board.id] = el; }}
              onClick={() => onSelect(board.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                openContextMenu(board.id, e.currentTarget);
              }}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all
                ${activeBoardId === board.id
                  ? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30'
                  : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800 border border-transparent'
                }`}
            >
              <KanbanSquare className="w-3.5 h-3.5" />
              {board.name}
              {board.share_permission && (
                <span className="text-[10px] text-dark-500 bg-dark-700/50 px-1 py-0.5 rounded" title={`Shared by ${board.owner_username || 'owner'} (${board.share_permission})`}>
                  <Users className="w-3 h-3 inline" />
                </span>
              )}
              <ChevronDown
                className="w-3.5 h-3.5 opacity-50 hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); openContextMenu(board.id, triggerRefs.current[board.id]); }}
              />
            </button>
          )}
          {contextMenu === board.id && createPortal(
            <div ref={contextRef}
              style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
              className="z-[200] bg-dark-800 border border-dark-600 rounded-lg shadow-xl py-1 min-w-[140px]">
              <button
                onClick={() => {
                  setRenameValue(board.name);
                  setRenaming(board.id);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700 flex items-center gap-2"
              >
                <Edit3 className="w-3 h-3" /> Rename
              </button>
              <button
                onClick={() => { onShare(board); setContextMenu(null); }}
                className="w-full text-left px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700 flex items-center gap-2"
              >
                <Share2 className="w-3 h-3" /> {board.share_permission ? 'Members' : 'Share'}
              </button>
              {boards.length > 1 && !board.share_permission && (
                <button
                  onClick={() => { onDelete(board.id); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-dark-700 flex items-center gap-2"
                >
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              )}
            </div>,
            document.body
          )}
        </div>
      ))}
      <button
        onClick={onCreate}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-dark-500
          hover:text-indigo-400 hover:bg-dark-800 transition-colors flex-shrink-0"
        title="Create new board"
      >
        <Plus className="w-3.5 h-3.5" />
        New Board
      </button>
    </div>
  );
}
