import { useState, useRef, useEffect } from 'react';
import {
  Trash2, Clock, AlertTriangle, User, GitCommit, Repeat, Loader2, Square,
  Flag, Sun, Play, Hand, Pause,
} from 'lucide-react';
import { SOURCE_META, TASK_TYPE_MAP, PRIORITY_MAP, isToday, timeAgo } from './taskConstants';

export default function TaskCard({ task, onDelete, onStop, onResume, onClearStopped, onOpen, showAgent, showCreator, showProject, showTaskType, onTouchDrop, onNavigateToAgent, onOpenCommits }) {
  const isError = task.status === 'error';
  const isStopped = task.executionStatus === 'stopped';
  const today = isToday(task.createdAt);
  const isDraggingRef = useRef(false);
  const touchDragRef = useRef(null);
  const cardRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressArmedRef = useRef(false);
  const autoScrollRef = useRef(null);
  // Refs for native touch listeners (avoid stale closures)
  const onTouchDropRef = useRef(onTouchDrop);
  const taskRef = useRef(task);
  useEffect(() => { onTouchDropRef.current = onTouchDrop; }, [onTouchDrop]);
  useEffect(() => { taskRef.current = task; }, [task]);

  const sourceMeta = task.source ? (SOURCE_META[task.source.type] || SOURCE_META.api) : null;

  // Find which column contains a given viewport coordinate using bounding rects.
  // More reliable on mobile than elementFromPoint (no z-index / pointer-events issues).
  function getColumnAtPoint(x, y) {
    const cols = document.querySelectorAll('[data-column-id]');
    for (const col of cols) {
      const r = col.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return col;
      }
    }
    return null;
  }

  function highlightColumn(colEl) {
    document.querySelectorAll('[data-column-id]').forEach(c => c.classList.remove('touch-drag-over'));
    if (colEl) colEl.classList.add('touch-drag-over');
  }

  // Shared drop cleanup + execution (used by both touchend and touchcancel)
  function finalizeTouchDrop(touchX, touchY) {
    const t = taskRef.current;
    if (!touchDragRef.current) return;
    if (!touchDragRef.current.started) { isDraggingRef.current = false; touchDragRef.current = null; return; }

    // Determine target column BEFORE removing the ghost (ghost has pointerEvents:none
    // so it doesn't interfere, but we want all DOM state stable during lookup).
    //
    // Priority: lastColumnId (updated reliably on every touchmove) > changedTouches
    // coordinates (which can be stale/wrong on mobile — some browsers report the
    // touchstart position instead of the final finger position).
    let dropColId = touchDragRef.current.lastColumnId || null;
    if (!dropColId) {
      const fx = touchX ?? touchDragRef.current.lastTouchX ?? null;
      const fy = touchY ?? touchDragRef.current.lastTouchY ?? null;
      if (fx != null && fy != null) {
        const col = getColumnAtPoint(fx, fy);
        if (col) dropColId = col.getAttribute('data-column-id');
      }
    }

    // Now clean up visuals
    if (touchDragRef.current.ghost) touchDragRef.current.ghost.remove();
    highlightColumn(null);

    if (dropColId) {
      onTouchDropRef.current(t.agentId, t.id, dropColId);
    }
    setTimeout(() => { isDraggingRef.current = false; }, 50);
    touchDragRef.current = null;
  }

  // Document-level touchmove blocker — active only while drag is armed.
  const docTouchBlocker = useRef(null);
  function installDocTouchBlocker() {
    if (docTouchBlocker.current) return;
    const handler = (e) => {
      if (longPressArmedRef.current || touchDragRef.current) {
        e.preventDefault();
      }
    };
    document.addEventListener('touchmove', handler, { passive: false });
    docTouchBlocker.current = handler;
  }
  function removeDocTouchBlocker() {
    if (!docTouchBlocker.current) return;
    document.removeEventListener('touchmove', docTouchBlocker.current);
    docTouchBlocker.current = null;
  }

  // Document-level touchend/touchcancel — registered when the long-press arms.
  // This guarantees drop detection even if the finger is released far from the card.
  const docTouchEndRef = useRef(null);
  function installDocTouchEnd() {
    if (docTouchEndRef.current) return;
    const handleEnd = (e) => {
      if (!touchDragRef.current) return;
      const wasDragging = touchDragRef.current.started;
      const originEl = touchDragRef.current.originEl;
      cleanupTouchState();
      if (wasDragging) e.preventDefault();
      const touch = e.changedTouches?.[0];
      finalizeTouchDrop(touch?.clientX ?? null, touch?.clientY ?? null);
      if (originEl) originEl.style.opacity = '';
    };
    const handleCancel = () => {
      if (!touchDragRef.current) return;
      const originEl = touchDragRef.current.originEl;
      cleanupTouchState();
      finalizeTouchDrop(null, null);
      if (originEl) originEl.style.opacity = '';
    };
    document.addEventListener('touchend', handleEnd, { passive: false });
    document.addEventListener('touchcancel', handleCancel);
    docTouchEndRef.current = { handleEnd, handleCancel };
  }
  function removeDocTouchEnd() {
    if (!docTouchEndRef.current) return;
    document.removeEventListener('touchend', docTouchEndRef.current.handleEnd);
    document.removeEventListener('touchcancel', docTouchEndRef.current.handleCancel);
    docTouchEndRef.current = null;
  }

  function cleanupTouchState() {
    if (autoScrollRef.current) { cancelAnimationFrame(autoScrollRef.current); autoScrollRef.current = null; }
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    removeDocTouchBlocker();
    removeDocTouchEnd();
    if (cardRef.current) {
      cardRef.current.style.transform = '';
      cardRef.current.style.transition = '';
      cardRef.current.style.opacity = '';
    }
    longPressArmedRef.current = false;
  }

  // Attach native touch listeners for drag-and-drop.
  // touchstart/touchmove on the card element; touchend/touchcancel on DOCUMENT
  // to guarantee they fire even when the finger is released far from the card
  // (mobile browsers sometimes don't deliver touchend to the original element).
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const handleTouchStart = (e) => {
      if (taskRef.current?.actionRunning) return;
      const touch = e.touches[0];
      const startX = touch.clientX;
      const startY = touch.clientY;
      longPressArmedRef.current = false;
      longPressTimerRef.current = setTimeout(() => {
        longPressArmedRef.current = true;
        touchDragRef.current = {
          startX,
          startY,
          started: false,
          ghost: null,
          lastColumnId: null,
          lastTouchX: startX,
          lastTouchY: startY,
          originEl: el,
        };
        installDocTouchBlocker();
        installDocTouchEnd();
        if (navigator.vibrate) navigator.vibrate(30);
        if (cardRef.current) {
          cardRef.current.style.transform = 'scale(0.97)';
          cardRef.current.style.transition = 'transform 0.15s ease';
        }
      }, 500);
    };

    const handleTouchMove = (e) => {
      if (longPressTimerRef.current && !longPressArmedRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
        return;
      }
      if (!touchDragRef.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchDragRef.current.startX;
      const dy = touch.clientY - touchDragRef.current.startY;

      touchDragRef.current.lastTouchX = touch.clientX;
      touchDragRef.current.lastTouchY = touch.clientY;

      e.preventDefault();

      if (!touchDragRef.current.started) {
        if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
        touchDragRef.current.started = true;
        isDraggingRef.current = true;

        const ghost = el.cloneNode(true);
        ghost.style.position = 'fixed';
        ghost.style.zIndex = '9999';
        ghost.style.pointerEvents = 'none';
        ghost.style.opacity = '0.85';
        ghost.style.width = el.offsetWidth + 'px';
        ghost.style.transform = 'rotate(2deg) scale(1.02)';
        ghost.style.boxShadow = '0 8px 32px rgba(0,0,0,0.4)';
        document.body.appendChild(ghost);
        touchDragRef.current.ghost = ghost;

        touchDragRef.current.scrollContainer = el.closest('.overflow-auto');
        el.style.opacity = '0.4';
      }

      if (touchDragRef.current.ghost) {
        touchDragRef.current.ghost.style.left = (touch.clientX - el.offsetWidth / 2) + 'px';
        touchDragRef.current.ghost.style.top = (touch.clientY - 30) + 'px';
      }

      const scrollEl = touchDragRef.current.scrollContainer;
      if (scrollEl) {
        const rect = scrollEl.getBoundingClientRect();
        const edgeZone = 60;
        const scrollSpeed = 12;

        if (autoScrollRef.current) {
          cancelAnimationFrame(autoScrollRef.current);
          autoScrollRef.current = null;
        }

        const touchX = touch.clientX;
        const touchY = touch.clientY;
        const startAutoScroll = (direction) => {
          const tick = () => {
            scrollEl.scrollLeft += direction * scrollSpeed;
            const col2 = getColumnAtPoint(touchX, touchY);
            if (col2 && touchDragRef.current) {
              highlightColumn(col2);
              touchDragRef.current.lastColumnId = col2.getAttribute('data-column-id');
            }
            autoScrollRef.current = requestAnimationFrame(tick);
          };
          autoScrollRef.current = requestAnimationFrame(tick);
        };

        if (touch.clientX > rect.right - edgeZone) {
          startAutoScroll(1);
        } else if (touch.clientX < rect.left + edgeZone) {
          startAutoScroll(-1);
        }
      }

      const colUnder = getColumnAtPoint(touch.clientX, touch.clientY);
      highlightColumn(colUnder);
      if (colUnder) {
        touchDragRef.current.lastColumnId = colUnder.getAttribute('data-column-id');
      }
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      cleanupTouchState();
      // Unmounting mid-drag (e.g. a task:updated event removed the card):
      // finalizeTouchDrop will never run, so remove the ghost clone and the
      // column highlight here and reset the drag refs.
      if (touchDragRef.current?.ghost) touchDragRef.current.ghost.remove();
      highlightColumn(null);
      touchDragRef.current = null;
      isDraggingRef.current = false;
    };
  }, []);

  return (
    <div
      ref={cardRef}
      draggable={!task.actionRunning}
      onDragStart={(e) => {
        if (task.actionRunning) { e.preventDefault(); return; }
        isDraggingRef.current = true;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify({ agentId: task.agentId, taskId: task.id }));
        setTimeout(() => (e.target as HTMLElement).classList.add('opacity-40'), 0);
      }}
      onDragEnd={(e) => {
        (e.target as HTMLElement).classList.remove('opacity-40');
        // Reset after a tick so click doesn't fire after drop
        setTimeout(() => { isDraggingRef.current = false; }, 50);
      }}
      onClick={() => { if (!isDraggingRef.current) onOpen(task); }}
      className={`group/card bg-dark-800 rounded-lg border p-3 cursor-pointer
        transition-all hover:shadow-lg hover:shadow-black/20
        ${isError
          ? 'border-red-500/40 bg-red-500/5 hover:border-red-500/60'
          : isStopped
            ? 'border-yellow-500/40 bg-yellow-500/5 hover:border-yellow-500/60 ring-1 ring-yellow-500/20'
            : task.isManual
              ? 'border-orange-500/40 bg-orange-500/5 hover:border-orange-500/60 ring-1 ring-orange-500/20'
              : today
                ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60 ring-1 ring-amber-500/20'
                : 'border-dark-700 hover:border-dark-500'
        }`}
    >
      {/* Task text */}
      <p className={`text-sm leading-snug mb-2.5 ${isError ? 'text-red-300' : 'text-dark-200'}`}
        style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {task.title || task.text}
      </p>

      {isError && task.error && (
        <div className="flex items-start gap-1.5 mb-2 p-1.5 rounded bg-red-500/10 border border-red-500/20">
          <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-400/80 leading-tight"
            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {task.error}
          </p>
        </div>
      )}

      {isStopped && !isError && (
        <div className="flex items-center gap-1.5 mb-2 p-1.5 rounded bg-yellow-500/10 border border-yellow-500/20">
          <Pause className="w-3 h-3 text-yellow-400 flex-shrink-0" />
          <p className="text-xs text-yellow-400/80">Stopped</p>
        </div>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-1 mb-2.5">
        {task.priority && PRIORITY_MAP[task.priority] && (
          <span className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ring-1 ${PRIORITY_MAP[task.priority].cls}`}>
            <Flag className="w-2.5 h-2.5" />
            {PRIORITY_MAP[task.priority].label}
          </span>
        )}
        {showProject && task.project && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20">
            {task.project}
          </span>
        )}
        {task.repoFullName && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20" title={`Repo: ${task.repoFullName}`}>
            {task.repoFullName.split('/').pop()}
          </span>
        )}
        {Array.isArray(task.secondaryRepos) && task.secondaryRepos.length > 0 && (
          <span
            className="text-xs px-1.5 py-0.5 rounded font-medium bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20"
            title={`Secondary repos:\n${task.secondaryRepos.map(r => r.fullName).join('\n')}`}
          >
            +{task.secondaryRepos.length}
          </span>
        )}
        {task.environment && task.environment !== 'prod' && (
          <span
            className="text-xs px-1.5 py-0.5 rounded font-medium bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20 uppercase tracking-wide"
            title={`Created on ${task.environment} environment`}
          >
            {task.environment}
          </span>
        )}
        {task.storagePath && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20" title={`Storage: ${task.storagePath}`}>
            {task.storagePath.split('/').filter(Boolean).pop() || task.storagePath}
          </span>
        )}
        {showTaskType && task.taskType && TASK_TYPE_MAP[task.taskType] && (() => {
          const tt = TASK_TYPE_MAP[task.taskType];
          const Icon = tt.icon;
          return (
            <span className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ring-1 ${tt.cls}`}>
              <Icon className="w-2.5 h-2.5" />
              {tt.label}
            </span>
          );
        })()}
        {showCreator && sourceMeta && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ring-1 ${sourceMeta.cls}`}>
            {sourceMeta.label(task.source)}
          </span>
        )}
        {showAgent && task.assigneeName && (
          <span
            className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/20${task.assignee && onNavigateToAgent ? ' cursor-pointer hover:bg-cyan-500/20 transition-colors' : ''}`}
            onClick={task.assignee && onNavigateToAgent ? (e) => { e.stopPropagation(); onNavigateToAgent(task.assignee); } : undefined}
            title={task.assignee && onNavigateToAgent ? `Open ${task.assigneeName}'s chat` : undefined}
          >
            <User className="w-2.5 h-2.5" />
            {`${task.assigneeIcon || ''} ${task.assigneeName}`.trim()}
          </span>
        )}
        {task.commits && task.commits.length > 0 && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20 cursor-pointer hover:bg-amber-500/20 transition-colors" onClick={(e) => { e.stopPropagation(); onOpenCommits?.(task); }}>
            <GitCommit className="w-2.5 h-2.5" />
            {task.commits.length}
          </span>
        )}
        {task.recurrence?.enabled && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-teal-500/10 text-teal-400 ring-1 ring-teal-500/20">
            <Repeat className="w-2.5 h-2.5" />
            {task.recurrence.period === 'custom' ? `${task.recurrence.intervalMinutes}m` : task.recurrence.period}
          </span>
        )}
        {task.isManual && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20">
            <Hand className="w-2.5 h-2.5" />
            Manual
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs text-dark-500">
          <Clock className="w-3 h-3" />
          {timeAgo(task.createdAt)}
          {today && (
            <span className="flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/25">
              <Sun className="w-2.5 h-2.5" />
              Today
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {task.actionRunning && (
            <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
          )}
          <div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity">
            {task.actionRunning ? (
              <button
                onClick={(e) => { e.stopPropagation(); onStop(task); }}
                className="p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                title="Stop action"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </button>
            ) : (
              <>
                {isStopped && !task.assignee && onClearStopped && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onClearStopped(task); }}
                    className="p-1.5 rounded text-yellow-500 hover:text-yellow-400 hover:bg-yellow-500/10 transition-colors"
                    title="Clear stopped status"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                )}
                {task.assignee && onResume && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onResume(task); }}
                    className="p-1.5 rounded text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                    title="Resume task"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(task); }}
                  className="p-1.5 rounded text-dark-500 hover:text-red-400 hover:bg-dark-700 transition-colors"
                  title="Delete task"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
