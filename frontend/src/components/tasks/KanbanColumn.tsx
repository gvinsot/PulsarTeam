import { useState, useRef, useCallback, useEffect } from 'react';
import { Trash2, Edit3, Plus, ArrowRight } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import TaskCard from './TaskCard';

export default function KanbanColumn({ col, tasks, agents, onDelete, onStop, onResume, onClearStopped, onDrop, onOpen, onAddTask, onEditInstructions, hasInstructions, showAgent, showCreator, showProject, showTaskType, onTouchDrop, onNavigateToAgent, onOpenCommits, columns, onBatchMove, onBatchDelete }) {
  const { theme } = useTheme();
  const isLight = theme === 'light';
  const [dragOver, setDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [dropIndex, setDropIndex] = useState(-1);
  const [showBatchMenu, setShowBatchMenu] = useState(false);
  const [batchMoving, setBatchMoving] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const batchMenuRef = useRef(null);
  const dropZoneRef = useRef(null);

  // Close batch menu on outside click
  useEffect(() => {
    if (!showBatchMenu) return;
    const handleClick = (e) => {
      if (batchMenuRef.current && !batchMenuRef.current.contains(e.target)) {
        setShowBatchMenu(false);
        setConfirmTrash(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBatchMenu]);

  const handleBatchMove = useCallback(async (targetColId) => {
    if (!onBatchMove || batchMoving) return;
    setBatchMoving(true);
    setShowBatchMenu(false);
    try {
      await onBatchMove(col.id, targetColId, tasks);
    } finally {
      setBatchMoving(false);
    }
  }, [onBatchMove, col.id, tasks, batchMoving]);

  const handleBatchDelete = useCallback(async () => {
    if (!onBatchDelete || batchMoving) return;
    setBatchMoving(true);
    setShowBatchMenu(false);
    setConfirmTrash(false);
    try {
      await onBatchDelete(col.id, tasks);
    } finally {
      setBatchMoving(false);
    }
  }, [onBatchDelete, col.id, tasks, batchMoving]);

  // Compute which index the dragged item should be inserted at
  const computeDropIndex = useCallback((e) => {
    const container = dropZoneRef.current;
    if (!container) return tasks.length;
    const cards = container.querySelectorAll('[data-task-id]');
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) return i;
    }
    return tasks.length; // drop at end
  }, [tasks.length]);

  return (
    <div className="flex flex-col min-w-[300px] w-[300px] max-h-[2500px] flex-shrink-0 group"
      data-column-id={col.id}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {/* Column header */}
      <div className={`flex items-center justify-between px-3 py-2.5 rounded-t-xl border border-b-2
        transition-colors mb-0 flex-shrink-0
        ${dragOver
          ? `bg-dark-750 ${col.headerActive} border-b-2`
          : 'bg-dark-800/60 border-dark-700/50'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${col.dot}`} />
          <span className={`text-sm font-semibold ${isLight ? col.headerTextLight : col.headerText}`}>{col.label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {hasInstructions && (
            <button
              onClick={() => onEditInstructions(col.id)}
              className="p-1 rounded text-dark-500 hover:text-blue-400 hover:bg-dark-700 transition-colors"
              title="Edit agent instructions for this column"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="relative" ref={batchMenuRef}>
            <button
              onClick={() => { if (tasks.length > 0 && columns && (onBatchMove || onBatchDelete)) setShowBatchMenu(!showBatchMenu); }}
              className={`text-xs font-bold px-2 py-0.5 rounded-full transition-colors ${isLight ? col.countClsLight : col.countCls} ${tasks.length > 0 && columns && (onBatchMove || onBatchDelete) ? 'cursor-pointer hover:ring-1 hover:ring-white/30' : ''}`}
              title={tasks.length > 0 && columns && (onBatchMove || onBatchDelete) ? 'Batch actions on tasks' : ''}
            >
              {batchMoving ? '...' : tasks.length}
            </button>
            {showBatchMenu && columns && (
              <div className={`absolute right-0 top-full mt-1 z-50 rounded-lg shadow-xl border min-w-[180px] py-1 ${isLight ? 'bg-white border-gray-200' : 'bg-dark-800 border-dark-600'}`}>
                <div className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${isLight ? 'text-gray-400' : 'text-dark-500'}`}>
                  Move all to...
                </div>
                {columns.filter(c => c.id !== col.id).map(targetCol => (
                  <button
                    key={targetCol.id}
                    onClick={() => handleBatchMove(targetCol.id)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${isLight ? 'hover:bg-gray-100 text-gray-700' : 'hover:bg-dark-700 text-dark-300'}`}
                  >
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${targetCol.dot}`} />
                    <span className="truncate">{targetCol.label}</span>
                    <ArrowRight className="w-3 h-3 ml-auto opacity-40" />
                  </button>
                ))}
                {onBatchDelete && (
                  <>
                    <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-dark-600'}`} />
                    {!confirmTrash ? (
                      <button
                        onClick={() => setConfirmTrash(true)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${isLight ? 'hover:bg-red-50 text-red-600' : 'hover:bg-red-900/20 text-red-400'}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Trash all ({tasks.length})</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleBatchDelete}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left font-semibold transition-colors ${isLight ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-red-900/30 text-red-300 hover:bg-red-900/50'}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Confirm delete {tasks.length} tasks?</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Drop zone */}
      <div
        ref={dropZoneRef}
        className={`flex flex-col gap-2 p-2 rounded-b-xl border border-t-0
          transition-all duration-150 flex-1 min-h-0 overflow-y-auto
          ${dragOver
            ? `ring-2 ring-inset ${col.dropRing} border-dark-600`
            : 'bg-dark-800/20 border-dark-700/30'
          }`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOver(true);
          setDropIndex(computeDropIndex(e));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) {
            setDragOver(false);
            setDropIndex(-1);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const idx = computeDropIndex(e);
          setDragOver(false);
          setDropIndex(-1);
          onDrop(e, col, idx);
        }}
      >
        {tasks.map((task, i) => (
          <div key={`${task.agentId}-${task.id}`} data-task-id={task.id}>
            {dragOver && dropIndex === i && (
              <div className="h-1 rounded-full bg-indigo-500/60 mx-2 mb-1 transition-all" />
            )}
            <TaskCard
              task={task}
              agents={agents}
              onDelete={onDelete}
              onStop={onStop}
              onResume={onResume}
              onClearStopped={onClearStopped}
              onOpen={onOpen}
              showAgent={showAgent}
              showCreator={showCreator}
              showProject={showProject}
              showTaskType={showTaskType}
              onTouchDrop={onTouchDrop}
              onNavigateToAgent={onNavigateToAgent}
              onOpenCommits={onOpenCommits}
            />
          </div>
        ))}
        {dragOver && dropIndex >= tasks.length && (
          <div className="h-1 rounded-full bg-indigo-500/60 mx-2 transition-all" />
        )}
        {tasks.length === 0 && (
          <div className={`flex items-center justify-center text-xs py-4
            transition-colors ${dragOver ? 'text-dark-400' : 'text-dark-700'}`}>
            {dragOver ? '↓ Drop here' : 'No tasks'}
          </div>
        )}
        {onAddTask && (
          <button
            onClick={onAddTask}
            className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs
              transition-all duration-150 flex-shrink-0
              text-dark-400 hover:text-indigo-400 hover:bg-dark-700/50"
          >
            <Plus className="w-3 h-3" /> Add task
          </button>
        )}
      </div>
    </div>
  );
}
