import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  Search, X, GitCommit, Plus, Settings, ArrowUpDown, Archive, Puzzle,
} from 'lucide-react';
import { api, deleteTask as deleteTaskById, updateTask as updateTaskById, reorderTasks, clearTaskStopped } from '../api';
import AllCommitsDiffModal from './AllCommitsDiffModal';
import GitHubActivityModal from './GitHubActivityModal';
import ShareBoardModal from './ShareBoardModal';
import { getSocket } from '../socket';
import { WsEvents } from '../socketEvents';
import { safeGet, safeSet } from '../lib/safeStorage';

import { buildColumns, buildStatusOptions, sortTasks, SORT_OPTIONS } from './tasks/taskConstants';
import CreateTaskModal from './tasks/CreateTaskModal';
import TaskDetailModal from './tasks/TaskDetailModal';
import InstructionsEditModal from './tasks/InstructionsEditModal';
import KanbanColumn from './tasks/KanbanColumn';
import WorkflowEditor from './tasks/WorkflowEditor';
import DeletedTasksPanel from './tasks/DeletedTasksPanel';
import BoardTabs from './tasks/BoardTabs';
import BoardPluginsTab from './tasks/BoardPluginsTab';

// ── TasksBoard (multi-board) ────────────────────────────────────────────────

export default function TasksBoard({ agents, onRefresh, user, onNavigateToAgent, onBoardChange, projectFilter = '' }) {
  const [repoFilter, setRepoFilter] = useState(() => safeGet('tasks_repoFilter') || '');
  const [agentFilter, setAgentFilter] = useState(() => safeGet('tasks_agentFilter') || '');
  const [search, setSearch] = useState(() => safeGet('tasks_search') || '');
  const [sortBy, setSortBy] = useState(() => safeGet('tasks_sortBy') || 'manual');
  const [selectedTask, setSelectedTask] = useState(null);
  const [commitModalTask, setCommitModalTask] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefaultStatus, setCreateDefaultStatus] = useState(null);
  const [showWorkflowEditor, setShowWorkflowEditor] = useState(false);
  const [editInstructionsCol, setEditInstructionsCol] = useState(null);
  const [showDeletedTasks, setShowDeletedTasks] = useState(false);
  const [shareBoard, setShareBoard] = useState(null);
  const [activityTarget, setActivityTarget] = useState(null);
  const [showBoardPlugins, setShowBoardPlugins] = useState(false);
  const boardScrollRef = useRef(null);

  // Multi-board state
  const [boards, setBoards] = useState([]);
  const [activeBoardId, setActiveBoardId] = useState(null);
  const [boardsLoaded, setBoardsLoaded] = useState(false);

  // Load boards on mount
  useEffect(() => {
    let cancelled = false;
    async function loadBoards() {
      try {
        const boardList = await api.getBoards();
        if (cancelled) return;
        if (boardList.length > 0) {
          setBoards(boardList);
          // Restore last active board from localStorage or use first
          const lastBoardId = safeGet('activeBoardId');
          const validBoard = boardList.find(b => b.id === lastBoardId);
          setActiveBoardId(validBoard ? validBoard.id : boardList[0].id);
        } else {
          // No boards yet — create with clean default (backend provides Todo/In Progress/Done)
          const board = await api.createBoard('My board', undefined, undefined);
          if (cancelled) return;
          setBoards([board]);
          setActiveBoardId(board.id);
        }
      } catch (err) {
        console.error('Failed to load boards:', err);
      } finally {
        if (!cancelled) setBoardsLoaded(true);
      }
    }
    loadBoards();
    return () => { cancelled = true; };
  }, []);

  // Persist active board selection and notify parent
  useEffect(() => {
    if (activeBoardId) {
      safeSet('activeBoardId', activeBoardId);
      onBoardChange?.(activeBoardId);
    }
  }, [activeBoardId, onBoardChange]);

  // Persist filter state
  useEffect(() => { safeSet('tasks_repoFilter', repoFilter); }, [repoFilter]);
  useEffect(() => { safeSet('tasks_agentFilter', agentFilter); }, [agentFilter]);
  useEffect(() => { safeSet('tasks_search', search); }, [search]);
  useEffect(() => { safeSet('tasks_sortBy', sortBy); }, [sortBy]);

  // When a global project filter is set, only show boards attached to that project
  const visibleBoards = useMemo(() => {
    if (!projectFilter) return boards;
    return (boards || []).filter(b => b.project_id === projectFilter);
  }, [boards, projectFilter]);

  // If the currently active board is hidden by the project filter, jump to the
  // first visible board (or clear if none).
  useEffect(() => {
    if (!boardsLoaded) return;
    if (visibleBoards.length === 0) {
      if (activeBoardId !== null) setActiveBoardId(null);
      return;
    }
    if (!visibleBoards.some(b => b.id === activeBoardId)) {
      setActiveBoardId(visibleBoards[0].id);
    }
  }, [visibleBoards, activeBoardId, boardsLoaded]);

  // Active board data — resolved against the full boards list so we keep state
  // even if a board is temporarily hidden by the filter.
  const activeBoard = useMemo(() => boards.find(b => b.id === activeBoardId) || null, [boards, activeBoardId]);

  // Permission checks for shared boards
  const boardPermission = activeBoard?.share_permission || 'admin';
  const isReadOnly = boardPermission === 'read';
  const canEdit = boardPermission === 'edit' || boardPermission === 'admin';

  // Get workflow from the active board
  const workflow = useMemo(
    () => (activeBoard?.workflow?.columns ? activeBoard.workflow : null),
    [activeBoard]
  );

  const columns = useMemo(() => workflow ? buildColumns(workflow.columns) : [], [workflow]);
  const statusOptions = useMemo(() => workflow ? buildStatusOptions(workflow.columns) : [], [workflow]);

  // Map column IDs to their "Instructions/Execute (agent)" actions from transitions
  const columnInstructionsMap = useMemo(() => {
    if (!workflow?.transitions) return {};
    const map = {};
    workflow.transitions.forEach((tr, tIdx) => {
      (tr.actions || []).forEach((act, aIdx) => {
        if (act.type === 'run_agent' && (act.mode === 'decide' || act.mode === 'execute')) {
          const colId = tr.from;
          if (!map[colId]) map[colId] = [];
          map[colId].push({
            instructions: act.instructions || '',
            role: act.role || '',
            transitionIdx: tIdx,
            actionIdx: aIdx,
          });
        }
      });
    });
    return map;
  }, [workflow]);

  // Fetch tasks directly from the tasks table via API.
  // We MERGE results with current state by updatedAt so a slow GET /tasks
  // (whose SELECT may run on a pool connection in parallel with in-flight
  // UPDATEs) cannot overwrite a more recent task:updated received via socket.
  const [dbTasks, setDbTasks] = useState([]);
  // Tracks tasks with an in-flight optimistic mutation. Protects them from
  // being clobbered by a stale GET /tasks SELECT that ran before the PUT
  // committed. We use this instead of stamping client-clock timestamps on
  // the optimistic copy: client/server clock skew would make server-emitted
  // task:updated events look "older" than the optimistic copy and get
  // rejected, leaving the UI stuck (e.g. no actionRunning spinner) until
  // a manual page refresh.
  const inFlightTaskIds = useRef(new Set());
  const loadTasks = useCallback(async () => {
    if (!activeBoardId) return; // Wait until a board is selected
    try {
      const tasks = await api.getAllTasks({ board_id: activeBoardId });
      // The user may have switched boards while this request was in flight —
      // a stale response would replace the new board's tasks with the old
      // board's list, so drop it.
      if (activeBoardId !== activeBoardIdRef.current) return;
      setDbTasks(prev => {
        const prevById = new Map(prev.map(t => [t.id, t]));
        const serverIds = new Set(tasks.map(t => t.id));

        const merged = tasks.map(serverTask => {
          const local = prevById.get(serverTask.id);
          if (!local) return serverTask;
          // Protect tasks with an in-flight optimistic mutation: the GET
          // may have raced ahead of the PUT's COMMIT and would otherwise
          // revert the optimistic change.
          if (inFlightTaskIds.current.has(serverTask.id)) return local;
          // Prefer local if it has a strictly newer updatedAt — that means a
          // task:updated event arrived after the server's SELECT snapshot.
          const localTs = local.updatedAt ? Date.parse(local.updatedAt) : 0;
          const serverTs = serverTask.updatedAt ? Date.parse(serverTask.updatedAt) : 0;
          if (localTs > serverTs) return local;
          return serverTask;
        });

        // Preserve optimistically-inserted tasks that the server doesn't
        // know about yet (the saveTaskToDb INSERT may not have committed
        // by the time this GET /tasks query ran). We keep local-only tasks
        // created in the last 10 seconds to cover the race window.
        const now = Date.now();
        for (const local of prev) {
          if (!serverIds.has(local.id) && local.createdAt) {
            const age = now - Date.parse(local.createdAt);
            if (age < 10_000) {
              merged.push(local);
            }
          }
        }

        return merged;
      });
    } catch (err) {
      console.error('[TasksBoard] Failed to load tasks:', err.message);
    }
  }, [activeBoardId]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  // Re-fetch tasks when agents update (status changes, etc.)
  const agentRevision = agents.map(a => `${a.id}:${a.status}`).join(',');
  useEffect(() => { loadTasks(); }, [agentRevision]);

  // Re-fetch tasks and board data when the browser tab becomes visible again
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadTasks();
        api.getBoards().then(boardList => {
          if (boardList.length > 0) setBoards(boardList);
        }).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadTasks]);

  // Keep a ref to activeBoardId so the WebSocket handler can filter new tasks
  // without re-subscribing on every board change.
  const activeBoardIdRef = useRef(activeBoardId);
  useEffect(() => { activeBoardIdRef.current = activeBoardId; }, [activeBoardId]);

  // Real-time task updates via WebSocket.
  // Handles both updates to existing tasks AND insertion of newly created tasks.
  // For existing tasks, we only accept the incoming data if its updatedAt >= local copy.
  useEffect(() => {
    const handler = ({ task }) => {
      if (!task?.id) return;
      setDbTasks(prev => {
        const idx = prev.findIndex(t => t.id === task.id);
        if (idx === -1) {
          // New task — add it only if it belongs to the currently active board and is not deleted
          if (task.boardId && task.boardId === activeBoardIdRef.current && !task.deletedAt) {
            return [...prev, task];
          }
          return prev;
        }
        // If the task was deleted, remove it from the local list
        if (task.deletedAt) {
          return prev.filter(t => t.id !== task.id);
        }
        // Existing task — update in place (reject stale data)
        const existing = prev[idx];
        const localTs = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
        const incomingTs = task.updatedAt ? Date.parse(task.updatedAt) : 0;
        if (incomingTs && localTs && incomingTs < localTs) return prev;
        const updated = [...prev];
        updated[idx] = { ...existing, ...task };
        return updated;
      });
    };
    // The socket may not exist yet at mount (it's created after login data
    // loads) and gets REPLACED on impersonation/stop-impersonation, so track
    // the instance for the component's whole lifetime and re-attach the
    // handler whenever it changes.
    let attached = null;
    const sync = () => {
      const sock = getSocket();
      if (sock === attached) return;
      if (attached) attached.off(WsEvents.TASK_UPDATED, handler);
      attached = sock;
      if (attached) attached.on(WsEvents.TASK_UPDATED, handler);
    };
    sync();
    const interval = setInterval(sync, 1000);
    return () => {
      clearInterval(interval);
      if (attached) attached.off(WsEvents.TASK_UPDATED, handler);
    };
  }, []);

  // Wrap onRefresh to also reload tasks.
  // When called with a newly created task, optimistically insert it into
  // state so it appears immediately — even if the DB write hasn't committed
  // by the time the subsequent loadTasks() query runs.
  const refreshAll = useCallback((newTask?: { id?: string }) => {
    if (newTask?.id) {
      setDbTasks(prev => {
        if (prev.some(t => t.id === newTask.id)) return prev;
        return [...prev, newTask];
      });
    }
    loadTasks();
    onRefresh();
  }, [loadTasks, onRefresh]);

  const allTasks = dbTasks;

  // Keep modal task in sync with live data
  const liveSelectedTask = useMemo(() => {
    if (!selectedTask) return null;
    return allTasks.find(t => t.id === selectedTask.id) || null;
  }, [selectedTask, allTasks]);

  // Repos in use on the active board — derived from tasks (distinct repoFullName)
  const boardRepos = useMemo(() => {
    const seen = new Map();
    for (const t of allTasks) {
      if (t.deletedAt || !t.repoFullName) continue;
      if (!seen.has(t.repoFullName)) {
        seen.set(t.repoFullName, { fullName: t.repoFullName, provider: t.repoProvider || 'github' });
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [allTasks]);

  const boardProjectsWithGithub = useMemo(() => {
    return boardRepos
      .filter(r => r.provider === 'github' && r.fullName)
      .map(r => {
        const [owner, repo] = r.fullName.split('/');
        return { name: r.fullName, github: { fullName: r.fullName, owner, repo } };
      });
  }, [boardRepos]);

  // Active board's project name (derived). Used by CreateTaskModal as the read-only label.
  const activeProjectName = useMemo(() => {
    const fromTask = allTasks.find(t => !t.deletedAt && t.project)?.project;
    return fromTask || activeBoard?.project_name || null;
  }, [allTasks, activeBoard]);

  // Last repo used on this board — pre-fills the repo picker on new tasks.
  const lastRepoFullName = useMemo(() => {
    const candidate = allTasks
      .filter(t => !t.deletedAt && t.repoFullName && t.createdAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return candidate?.repoFullName || null;
  }, [allTasks]);

  // Last storage used on this board — pre-fills the storage picker on new tasks.
  const lastStoragePath = useMemo(() => {
    const candidate = allTasks
      .filter(t => !t.deletedAt && t.storagePath && t.createdAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return candidate?.storagePath || null;
  }, [allTasks]);

  // Filtered tasks. The text search is purely client-side and matches every
  // field a user can see on a task card — title, details, the assigned
  // agent's name, repo and storage path — so any visible text is searchable.
  const agentNameById = useMemo(() => {
    const m = new Map();
    for (const a of agents) m.set(a.id, a.name || '');
    return m;
  }, [agents]);
  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTasks.filter(t => {
      if (agentFilter && t.agentId !== agentFilter) return false;
      if (repoFilter && t.repoFullName !== repoFilter) return false;
      if (q) {
        const agentName = agentNameById.get(t.agentId) || '';
        const haystack = [
          t.text,
          t.details,
          t.repoFullName,
          t.storagePath,
          t.project,
          agentName,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allTasks, agentFilter, repoFilter, search, agentNameById]);

  // Resolve which column a task should appear in. Used by both the kanban
  // grouping AND the drag/drop handlers so the two stay in lock-step (otherwise
  // a task can render in column A via fallback but the drop handler thinks it
  // belongs to column B, treating a same-column drop as a column move).
  //
  // SAFETY NET: a task MUST always land in some column. Without this, a task
  // whose status (or errorFromStatus) doesn't match any column id silently
  // disappears from the board — the API still returns it, but the user can't
  // see it. This happens e.g. when a workflow column is renamed/deleted, or
  // when a buggy backend path sets errorFromStatus to 'error' itself. We
  // always fall back to the first column, logging once so the underlying
  // data bug can still be diagnosed.
  const resolveTaskColumnId = useCallback((t) => {
    const fallbackColId = columns[0]?.id;
    const validColIds = new Set(columns.map(c => c.id));
    // For tasks whose status maps to a column (col.statuses = [col.id] in
    // taskConstants.buildColumns), pick that column.
    if (t.status !== 'error' && validColIds.has(t.status)) return t.status;
    // Errored tasks render in their originating column.
    if (t.status === 'error' && t.errorFromStatus && validColIds.has(t.errorFromStatus)) {
      return t.errorFromStatus;
    }
    if (fallbackColId) {
      console.warn(
        `[TasksBoard] Task ${t.id} has unresolvable column ` +
        `(status="${t.status}", errorFromStatus="${t.errorFromStatus}") — ` +
        `pinning to fallback column "${fallbackColId}" so it stays visible.`
      );
      return fallbackColId;
    }
    return null;
  }, [columns]);

  // Group by column — error is an internal state, not a workflow column.
  // Use errorFromStatus to keep error tasks visible in their originating column.
  const tasksByColumn = useMemo(() => {
    const groups = {};
    const buckets = new Map();
    for (const t of filteredTasks) {
      const colId = resolveTaskColumnId(t);
      if (!colId) continue;
      if (!buckets.has(colId)) buckets.set(colId, []);
      buckets.get(colId).push(t);
    }
    columns.forEach(col => {
      groups[col.id] = sortTasks(buckets.get(col.id) || [], sortBy);
    });
    return groups;
  }, [filteredTasks, columns, sortBy, resolveTaskColumnId]);

  const handleDelete = useCallback(async (task) => {
    await deleteTaskById(task.id);
    refreshAll();
  }, [refreshAll]);

  const handleStopAction = useCallback(async (task) => {
    const agentId = task.actionRunningAgentId || task.assignee;
    try {
      if (agentId) {
        await api.stopAgent(agentId);
      } else {
        // No executor recorded — fall back to a direct task-level stop so
        // the user isn't stuck staring at a Stop button that does nothing.
        await api.stopTask(task.id);
      }
    } catch (err) {
      // Executor may have been recycled (404) or permission denied — try
      // the task-level stop as a fallback so the user can always unstick.
      console.warn('stopAgent failed, falling back to stopTask:', err);
      try { await api.stopTask(task.id); } catch (e) { console.warn('stopTask failed:', e); }
    }
    refreshAll();
  }, [refreshAll]);

  const handleResumeTask = useCallback((task) => {
    const socket = getSocket();
    const agentId = task.agentId || task.assignee;
    if (!socket || !agentId) return;
    socket.emit(WsEvents.REQ_TASK_EXECUTE, { agentId, taskId: task.id });
  }, []);

  const handleClearStopped = useCallback(async (task) => {
    await clearTaskStopped(task.id);
  }, []);

  // Helper: reorder tasks in a column after a drop, updating positions via API
  const reorderColumnTasks = useCallback(async (colId, draggedTaskId, dropIdx) => {
    // Get current tasks in this column (sorted by current sort)
    const currentTasks = tasksByColumn[colId] || [];
    // When dragging downward within the same column, the dragged card is still
    // in the DOM so computeDropIndex counts it. After removing it from the array,
    // all items below the original position shift up by one — compensate here.
    const originalIdx = currentTasks.findIndex(t => t.id === draggedTaskId);
    let adjustedDropIdx = dropIdx;
    if (originalIdx !== -1 && originalIdx < dropIdx) {
      adjustedDropIdx = dropIdx - 1;
    }
    // Remove the dragged task if already in this column
    const without = currentTasks.filter(t => t.id !== draggedTaskId);
    // Insert at the drop index (clamp)
    const idx = Math.min(Math.max(0, adjustedDropIdx), without.length);
    const reordered = [...without.slice(0, idx), { id: draggedTaskId }, ...without.slice(idx)];
    const orderedIds = reordered.map(t => t.id);
    // Optimistic UI: update positions in local state
    setDbTasks(prev => {
      const posMap = new Map(orderedIds.map((id, i) => [id, i]));
      return prev.map(t => posMap.has(t.id) ? { ...t, position: posMap.get(t.id) } : t);
    });
    // Persist
    try {
      await reorderTasks(orderedIds);
    } catch (err) {
      console.error('[TasksBoard] Reorder failed:', err.message);
      refreshAll();
    }
  }, [tasksByColumn, refreshAll]);

  // Optimistic cross-column move shared by mouse and touch drops. Same-column
  // handling stays in the callers (drop reorders, touch drop is a no-op), as
  // do the isReadOnly/actionRunning guards and the outer try/catch.
  const moveTaskToColumn = useCallback(async (task, col, insertIdx, errLabel) => {
    const taskId = task.id;
    const prevStatus = task.status;
    // Optimistic: change status only. Don't stamp updatedAt with the
    // client clock — server-emitted task:updated events use server time
    // and would be rejected by the timestamp merge if the client clock
    // is ahead, leaving the UI stuck (no actionRunning spinner, etc.).
    inFlightTaskIds.current.add(taskId);
    setDbTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, status: col.dropStatus } : t
    ));
    try {
      const updated = await updateTaskById(taskId, { column: col.dropStatus });
      // Apply server's authoritative response so updatedAt is server-sourced.
      if (updated?.id) {
        setDbTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...updated } : t));
      }
      // After status change, reorder within the target column at the drop position
      if (insertIdx !== undefined) {
        await reorderColumnTasks(col.id, taskId, insertIdx);
      }
      refreshAll();
    } catch (apiErr) {
      console.error(`[TasksBoard] ${errLabel} API failed, reverting:`, apiErr.message);
      setDbTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, status: prevStatus } : t
      ));
    } finally {
      // Hold the in-flight guard briefly to cover the window where
      // task:updated events from workflow processing are still arriving.
      setTimeout(() => inFlightTaskIds.current.delete(taskId), 2000);
    }
  }, [reorderColumnTasks, refreshAll]);

  const handleDrop = useCallback(async (e, col, dropIdx) => {
    if (isReadOnly) return;
    let agentId, taskId;
    try {
      ({ agentId, taskId } = JSON.parse(e.dataTransfer.getData('application/json')));
    } catch { return; }
    try {
      let task = allTasks.find(t => t.id === taskId && t.agentId === agentId);
      if (!task) task = allTasks.find(t => t.id === taskId);
      if (!task) return;
      if (task.actionRunning) return;

      if (resolveTaskColumnId(task) === col.id) {
        // Same column — just reorder
        if (dropIdx !== undefined) {
          await reorderColumnTasks(col.id, taskId, dropIdx);
        }
        return;
      }

      await moveTaskToColumn(task, col, dropIdx, 'Drop');
    } catch (err) {
      console.error('[TasksBoard] Drop status change failed:', err.message);
    }
  }, [allTasks, columns, isReadOnly, reorderColumnTasks, resolveTaskColumnId, moveTaskToColumn]);

  // Touch drag-and-drop handler
  const handleTouchDrop = useCallback(async (agentId, taskId, targetColumnId) => {
    if (isReadOnly) return;
    try {
      let task = allTasks.find(t => t.id === taskId && t.agentId === agentId);
      if (!task) task = allTasks.find(t => t.id === taskId);
      if (!task) {
        console.warn('[TasksBoard] Touch drop: task not found', { agentId, taskId });
        return;
      }
      if (task.actionRunning) return;
      const col = columns.find(c => c.id === targetColumnId);
      if (!col) {
        console.warn('[TasksBoard] Touch drop: column not found', targetColumnId);
        return;
      }
      // Same column — silent no-op (no reorder on touch)
      if (resolveTaskColumnId(task) === col.id) return;

      // Touch drop appends to end of target column
      await moveTaskToColumn(task, col, (tasksByColumn[col.id] || []).length, 'Touch drop');
    } catch (err) {
      console.error('[TasksBoard] Touch drop failed:', err.message);
    }
  }, [allTasks, columns, isReadOnly, tasksByColumn, resolveTaskColumnId, moveTaskToColumn]);

  // Batch move all tasks from one column to another
  const handleBatchMove = useCallback(async (sourceColId, targetColId, tasks) => {
    if (isReadOnly || !tasks.length) return;
    const targetCol = columns.find(c => c.id === targetColId);
    if (!targetCol) return;
    // Optimistic update — see handleDrop for why we don't stamp client-clock updatedAt.
    const taskIds = tasks.map(t => t.id);
    taskIds.forEach(id => inFlightTaskIds.current.add(id));
    setDbTasks(prev => prev.map(t =>
      taskIds.includes(t.id) ? { ...t, status: targetCol.dropStatus } : t
    ));
    try {
      await Promise.all(tasks.map(t => updateTaskById(t.id, { column: targetCol.dropStatus })));
      refreshAll();
    } catch (err) {
      console.error('[TasksBoard] Batch move failed:', err.message);
      refreshAll();
    } finally {
      setTimeout(() => taskIds.forEach(id => inFlightTaskIds.current.delete(id)), 2000);
    }
  }, [columns, refreshAll, isReadOnly]);

  const handleBatchDelete = useCallback(async (colId, tasks) => {
    if (isReadOnly || !tasks.length) return;
    const taskIds = tasks.map(t => t.id);
    setDbTasks(prev => prev.filter(t => !taskIds.includes(t.id)));
    try {
      await Promise.all(tasks.map(t => deleteTaskById(t.id)));
      refreshAll();
    } catch (err) {
      console.error('[TasksBoard] Batch delete failed:', err.message);
      refreshAll();
    }
  }, [refreshAll, isReadOnly]);

  const activeFilters = [agentFilter, repoFilter, search].filter(Boolean).length;

  // ── Board management handlers ──
  const handleCreateBoard = useCallback(async () => {
    try {
      // New boards always start with a clean 3-column workflow
      const board = await api.createBoard(`Board ${boards.length + 1}`, undefined, undefined);
      setBoards(prev => [...prev, board]);
      setActiveBoardId(board.id);
    } catch (err) {
      console.error('Failed to create board:', err.message);
    }
  }, [boards.length]);

  const handleRenameBoard = useCallback(async (boardId, newName) => {
    try {
      const updated = await api.updateBoard(boardId, { name: newName });
      setBoards(prev => prev.map(b => b.id === boardId ? updated : b));
    } catch (err) {
      console.error('Failed to rename board:', err.message);
    }
  }, []);

  const handleDeleteBoard = useCallback(async (boardId) => {
    if (boards.length <= 1) return;
    try {
      await api.deleteBoard(boardId);
      setBoards(prev => {
        const remaining = prev.filter(b => b.id !== boardId);
        if (activeBoardId === boardId && remaining.length > 0) {
          setActiveBoardId(remaining[0].id);
        }
        return remaining;
      });
    } catch (err) {
      console.error('Failed to delete board:', err.message);
    }
  }, [boards.length, activeBoardId]);

  const handleSaveWorkflow = useCallback(async (updated) => {
    if (!activeBoardId) return;
    const updatedBoard = await api.updateBoardWorkflow(activeBoardId, updated);
    setBoards(prev => prev.map(b => b.id === activeBoardId ? updatedBoard : b));
  }, [activeBoardId]);

  // Track which column is being dragged (for column reorder, distinct from task drag)
  const [draggingColumnId, setDraggingColumnId] = useState(null);

  // Reorder columns within the workflow (does not edit any other workflow setting)
  const handleReorderColumns = useCallback(async (draggedColId, targetColId, position) => {
    if (!workflow || !activeBoardId) return;
    if (draggedColId === targetColId) return;
    const cols = workflow.columns;
    const fromIdx = cols.findIndex(c => c.id === draggedColId);
    const targetIdx = cols.findIndex(c => c.id === targetColId);
    if (fromIdx === -1 || targetIdx === -1) return;
    const without = cols.filter(c => c.id !== draggedColId);
    let insertIdx = without.findIndex(c => c.id === targetColId);
    if (position === 'after') insertIdx += 1;
    const reordered = [...without.slice(0, insertIdx), cols[fromIdx], ...without.slice(insertIdx)];
    if (reordered.map(c => c.id).join('|') === cols.map(c => c.id).join('|')) return;
    const updated = {
      columns: reordered,
      transitions: workflow.transitions,
      version: workflow.version,
    };
    // Optimistic update on local boards state
    setBoards(prev => prev.map(b => b.id === activeBoardId
      ? { ...b, workflow: { ...(b.workflow || {}), ...updated } }
      : b));
    try {
      await handleSaveWorkflow(updated);
    } catch (err) {
      console.error('[TasksBoard] Column reorder failed:', err.message);
      // Reload boards on failure
      try {
        const list = await api.getBoards();
        if (list.length > 0) setBoards(list);
      } catch { /* no-op */ }
    }
  }, [workflow, activeBoardId, handleSaveWorkflow]);

  const handleAddColumn = useCallback(async () => {
    if (!workflow || !activeBoardId) return;
    const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'step';
    const baseName = 'New Step';
    let name = baseName;
    let suffix = 2;
    const existingIds = new Set(workflow.columns.map(c => c.id));
    while (existingIds.has(slugify(name))) {
      name = `${baseName} ${suffix++}`;
    }
    const newCol = { id: slugify(name), label: name, color: '#6b7280' };
    const newTransition = {
      from: newCol.id,
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { type: 'run_agent', mode: 'decide', role: '', instructions: '' },
        { type: 'change_status', target: '__next__' },
      ],
    };
    const updated = {
      columns: [...workflow.columns, newCol],
      transitions: [...workflow.transitions, newTransition],
      version: workflow.version,
    };
    try {
      await handleSaveWorkflow(updated);
    } catch (err) {
      console.error('[TasksBoard] Add column failed:', err.message);
    }
  }, [workflow, activeBoardId, handleSaveWorkflow]);

  if (!boardsLoaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Board Tabs */}
      {visibleBoards.length > 0 && (
        <BoardTabs
          boards={visibleBoards}
          activeBoardId={activeBoardId}
          onSelect={(id) => { setActiveBoardId(id); setAgentFilter(''); }}
          onCreate={handleCreateBoard}
          onRename={handleRenameBoard}
          onDelete={handleDeleteBoard}
          onShare={setShareBoard}
        />
      )}
      {projectFilter && visibleBoards.length === 0 && boardsLoaded && (
        <div className="px-4 py-8 text-center text-sm text-dark-400">
          No boards attached to the selected project. Attach a board from the Projects view to see its tasks here.
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-dark-700 bg-dark-900/30 overflow-x-auto scrollbar-hide">
        {/* Search */}
        <div className="relative flex-shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tasks..."
            title="Search across title, details, agent name, repo and storage path of visible tasks"
            className="pl-8 pr-7 py-1.5 w-48 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
              placeholder-dark-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-400 hover:text-dark-200">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
            focus:outline-none focus:border-indigo-500 transition-colors flex-shrink-0"
        >
          <option value="">All agents</option>
          {agents.filter(a => a.enabled !== false && a.boardId === activeBoardId).map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        {/* Repo filter */}
        {boardRepos.length > 0 && (
          <select
            value={repoFilter}
            onChange={e => setRepoFilter(e.target.value)}
            className="px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
              focus:outline-none focus:border-indigo-500 transition-colors flex-shrink-0"
          >
            <option value="">All repos</option>
            {boardRepos.map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
          </select>
        )}

        {/* Sort */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <ArrowUpDown className="w-3.5 h-3.5 text-dark-400" />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
              focus:outline-none focus:border-indigo-500 transition-colors"
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Clear filters */}
        {activeFilters > 0 && (
          <button
            onClick={() => { setAgentFilter(''); setRepoFilter(''); setSearch(''); }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-amber-400 bg-amber-500/10
              border border-amber-500/20 rounded-lg hover:bg-amber-500/20 transition-colors flex-shrink-0 whitespace-nowrap"
          >
            <X className="w-3 h-3" />
            Clear filters ({activeFilters})
          </button>
        )}

        <div className="ml-auto" />

        {/* Deleted tasks */}
        <button
          onClick={() => setShowDeletedTasks(true)}
          className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors flex-shrink-0"
          title="View deleted tasks"
        >
          <Archive className="w-3.5 h-3.5" />
        </button>

        {/* GitHub Activity per project */}
        {boardProjectsWithGithub.map(p => (
          <button
            key={p.name}
            onClick={() => setActivityTarget(p.github)}
            className="flex items-center gap-1 px-1.5 py-1 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors flex-shrink-0"
            title={`GitHub activity — ${p.name}`}
          >
            <GitCommit className="w-3.5 h-3.5" />
            <span className="text-[10px] max-w-[80px] truncate">{p.name}</span>
          </button>
        ))}

        {/* Board plugins */}
        {canEdit && activeBoard && (
          <button
            onClick={() => setShowBoardPlugins(true)}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors flex-shrink-0"
            title="Board plugins"
          >
            <Puzzle className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Workflow settings */}
        {canEdit && (
          <button
            onClick={() => setShowWorkflowEditor(true)}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors flex-shrink-0"
            title="Board workflow settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Create Task */}
        {!isReadOnly && (
          <button
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white
              bg-indigo-500 hover:bg-indigo-600 rounded-lg transition-colors flex-shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            New Task
          </button>
        )}
      </div>

      {/* Board */}
      <div
        ref={boardScrollRef}
        className="flex-1 min-h-0 overflow-auto scrollbar-always-visible"
      >
        <div className="flex gap-4 p-6 min-w-max items-stretch">
          {columns.map((col, colIdx) => (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={tasksByColumn[col.id] || []}
              onDelete={handleDelete}
              onStop={handleStopAction}
              onResume={handleResumeTask}
              onClearStopped={handleClearStopped}
              onDrop={handleDrop}
              onOpen={setSelectedTask}
              onAddTask={isReadOnly ? undefined : () => { setCreateDefaultStatus(col.id); setCreateOpen(true); }}
              onEditInstructions={setEditInstructionsCol}
              hasInstructions={!!columnInstructionsMap[col.id]}
              showAgent={col.showAgent}
              showCreator={col.showCreator}
              showProject={col.showProject}
              showTaskType={col.showTaskType}
              onTouchDrop={handleTouchDrop}
              onNavigateToAgent={onNavigateToAgent}
              onOpenCommits={setCommitModalTask}
              columns={columns}
              onBatchMove={isReadOnly ? undefined : handleBatchMove}
              onBatchDelete={isReadOnly ? undefined : handleBatchDelete}
              canReorderColumns={canEdit}
              draggingColumnId={draggingColumnId}
              onColumnDragStart={setDraggingColumnId}
              onColumnDragEnd={() => setDraggingColumnId(null)}
              onColumnReorder={handleReorderColumns}
              isFirstColumn={colIdx === 0}
              isLastColumn={colIdx === columns.length - 1}
            />
          ))}
          {canEdit && (
            <div className="flex flex-col min-w-[120px] w-[120px] flex-shrink-0">
              <button
                onClick={handleAddColumn}
                className="flex items-center justify-center gap-1.5 h-[52px] border-2 border-dashed border-dark-700
                  rounded-xl text-xs text-dark-500 hover:text-indigo-400 hover:border-indigo-500/30 transition-colors"
                title="Add a new column"
              >
                <Plus className="w-3.5 h-3.5" /> Column
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Instructions edit modal */}
      {editInstructionsCol && columnInstructionsMap[editInstructionsCol] && (
        <InstructionsEditModal
          columnLabel={columns.find(c => c.id === editInstructionsCol)?.label || editInstructionsCol}
          instructions={columnInstructionsMap[editInstructionsCol]}
          agents={agents.filter(a => a.boardId === activeBoardId)}
          onClose={() => setEditInstructionsCol(null)}
          onSave={async (updatedEntries, newLabel) => {
            if (!workflow) return;
            const updated = JSON.parse(JSON.stringify(workflow));
            for (const entry of updatedEntries) {
              const action = updated.transitions[entry.transitionIdx]?.actions?.[entry.actionIdx];
              if (action) {
                action.instructions = entry.instructions;
                if (entry.role !== undefined) action.role = entry.role;
              }
            }
            // Persist the (possibly edited) column display name. Only the label
            // changes — the column id stays stable so existing tasks and
            // transitions keep referencing the same column.
            const trimmed = (newLabel || '').trim();
            if (trimmed) {
              const col = updated.columns.find(c => c.id === editInstructionsCol);
              if (col) col.label = trimmed;
            }
            await handleSaveWorkflow(updated);
            setEditInstructionsCol(null);
          }}
        />
      )}

      {/* Task detail modal */}
      {liveSelectedTask && (
        <TaskDetailModal
          task={liveSelectedTask}
          agents={agents}
          statusOptions={statusOptions}
          onClose={() => setSelectedTask(null)}
          onRefresh={refreshAll}
          onDelete={handleDelete}
          onStop={handleStopAction}
          onResume={handleResumeTask}
          onClearStopped={handleClearStopped}
          onNavigateToAgent={onNavigateToAgent}
          boards={boards}
          activeBoardId={activeBoardId}
        />
      )}

      {/* Create task modal */}
      {createOpen && (
        <CreateTaskModal
          agents={agents}
          projectName={activeProjectName}
          defaultRepoFullName={lastRepoFullName}
          defaultStoragePath={lastStoragePath}
          statusOptions={statusOptions}
          defaultStatus={createDefaultStatus}
          boardId={activeBoardId}
          onClose={() => { setCreateOpen(false); setCreateDefaultStatus(null); }}
          onCreated={refreshAll}
        />
      )}

      {/* Workflow editor modal */}
      {showWorkflowEditor && workflow && (
        <WorkflowEditor
          workflow={workflow}
          agents={agents.filter(a => a.boardId === activeBoardId)}
          onClose={() => setShowWorkflowEditor(false)}
          onSave={handleSaveWorkflow}
        />
      )}

      {/* Deleted tasks panel */}
      {showDeletedTasks && (
        <DeletedTasksPanel
          onClose={() => setShowDeletedTasks(false)}
          onRestored={refreshAll}
        />
      )}

      {/* Share board modal */}
      {shareBoard && (
        <ShareBoardModal
          board={shareBoard}
          onClose={() => setShareBoard(null)}
          currentUserId={user?.userId}
        />
      )}

      {/* Commit diff modal from card badge */}
      {commitModalTask && commitModalTask.commits?.length > 0 && (
        <AllCommitsDiffModal
          taskId={commitModalTask.id}
          commits={commitModalTask.commits}
          onClose={() => setCommitModalTask(null)}
          initialHash={null}
          agentId={commitModalTask.agentId}
          project={commitModalTask.project}
        />
      )}

      {/* GitHub Activity modal */}
      {activityTarget && (
        <GitHubActivityModal
          owner={activityTarget.owner}
          repo={activityTarget.repo}
          boardId={activeBoardId}
          onClose={() => setActivityTarget(null)}
        />
      )}

      {/* Board Plugins modal */}
      {showBoardPlugins && activeBoard && (
        <BoardPluginsTab
          board={activeBoard}
          onClose={() => setShowBoardPlugins(false)}
        />
      )}
    </div>
  );
}
