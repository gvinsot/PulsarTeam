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

export default function TasksBoard({ agents, onRefresh, user, onNavigateToAgent, githubProjects = [], projectContexts = [], onBoardChange }) {
  const [projectFilter, setProjectFilter] = useState(() => localStorage.getItem('tasks_projectFilter') || '');
  const [agentFilter, setAgentFilter] = useState(() => localStorage.getItem('tasks_agentFilter') || '');
  const [search, setSearch] = useState(() => localStorage.getItem('tasks_search') || '');
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('tasks_sortBy') || 'manual');
  const [selectedTask, setSelectedTask] = useState(null);
  const [commitModalTask, setCommitModalTask] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefaultStatus, setCreateDefaultStatus] = useState(null);
  const [showWorkflowEditor, setShowWorkflowEditor] = useState(false);
  const [editInstructionsCol, setEditInstructionsCol] = useState(null);
  const [jiraStatus, setJiraStatus] = useState(null);
  const [showDeletedTasks, setShowDeletedTasks] = useState(false);
  const [shareBoard, setShareBoard] = useState(null);
  const [activityTarget, setActivityTarget] = useState(null);
  const [showBoardPlugins, setShowBoardPlugins] = useState(false);
  const boardScrollRef = useRef(null);

  // Multi-board state
  const [boards, setBoards] = useState([]);
  const [activeBoardId, setActiveBoardId] = useState(null);
  const [boardsLoaded, setBoardsLoaded] = useState(false);

  // Fallback workflow for when no board exists yet (legacy compat)
  const [fallbackWorkflow, setFallbackWorkflow] = useState(null);

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
          const lastBoardId = localStorage.getItem('activeBoardId');
          const validBoard = boardList.find(b => b.id === lastBoardId);
          setActiveBoardId(validBoard ? validBoard.id : boardList[0].id);
        } else {
          // No boards yet — create with clean default (backend provides Todo/In Progress/Done)
          const board = await api.createBoard('My Board');
          if (cancelled) return;
          setBoards([board]);
          setActiveBoardId(board.id);
        }
      } catch {
        // Fallback to legacy single workflow
        try {
          const wf = await api.getWorkflow();
          if (!cancelled) setFallbackWorkflow(wf);
        } catch { /* no-op */ }
      } finally {
        if (!cancelled) setBoardsLoaded(true);
      }
    }
    loadBoards();
    api.getJiraStatus().then(setJiraStatus).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Persist active board selection and notify parent
  useEffect(() => {
    if (activeBoardId) {
      localStorage.setItem('activeBoardId', activeBoardId);
      onBoardChange?.(activeBoardId);
    }
  }, [activeBoardId, onBoardChange]);

  // Persist filter state
  useEffect(() => { localStorage.setItem('tasks_projectFilter', projectFilter); }, [projectFilter]);
  useEffect(() => { localStorage.setItem('tasks_agentFilter', agentFilter); }, [agentFilter]);
  useEffect(() => { localStorage.setItem('tasks_search', search); }, [search]);
  useEffect(() => { localStorage.setItem('tasks_sortBy', sortBy); }, [sortBy]);

  // Active board data
  const activeBoard = useMemo(() => boards.find(b => b.id === activeBoardId) || null, [boards, activeBoardId]);

  // Permission checks for shared boards
  const boardPermission = activeBoard?.share_permission || (activeBoard ? 'admin' : 'admin');
  const isReadOnly = boardPermission === 'read';
  const canEdit = boardPermission === 'edit' || boardPermission === 'admin';

  // Get workflow: from active board, or fallback
  const workflow = useMemo(() => {
    if (activeBoard?.workflow?.columns) return activeBoard.workflow;
    return fallbackWorkflow;
  }, [activeBoard, fallbackWorkflow]);

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
  const loadTasks = useCallback(async () => {
    if (!activeBoardId) return; // Wait until a board is selected
    try {
      const tasks = await api.getAllTasks({ board_id: activeBoardId });
      setDbTasks(prev => {
        const prevById = new Map(prev.map(t => [t.id, t]));
        const serverIds = new Set(tasks.map(t => t.id));

        const merged = tasks.map(serverTask => {
          const local = prevById.get(serverTask.id);
          if (!local) return serverTask;
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
    const sock = getSocket();
    if (!sock) return;
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
    sock.on(WsEvents.TASK_UPDATED, handler);
    return () => sock.off(WsEvents.TASK_UPDATED, handler);
  }, []);

  // Wrap onRefresh to also reload tasks.
  // When called with a newly created task, optimistically insert it into
  // state so it appears immediately — even if the DB write hasn't committed
  // by the time the subsequent loadTasks() query runs.
  const refreshAll = useCallback((newTask) => {
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
    return allTasks.find(t => t.id === selectedTask.id && t.agentId === selectedTask.agentId) || null;
  }, [selectedTask, allTasks]);

  // Unique projects for filter
  const allProjects = useMemo(() => {
    const ps = new Set(allTasks.filter(t => !t.deletedAt).map(t => t.project).filter(Boolean));
    return Array.from(ps).sort();
  }, [allTasks]);

  // GitHub lookup: map project name → { fullName, owner, repo }
  const githubLookup = useMemo(() => {
    const map = new Map();
    for (const gp of githubProjects) {
      if (gp.fullName) {
        const [owner, repo] = gp.fullName.split('/');
        map.set(gp.name, { fullName: gp.fullName, owner, repo });
      }
    }
    for (const ctx of projectContexts) {
      if (ctx.githubUrl && !map.has(ctx.name)) {
        const match = ctx.githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
        if (match) {
          map.set(ctx.name, { fullName: `${match[1]}/${match[2]}`, owner: match[1], repo: match[2] });
        }
      }
    }
    return map;
  }, [githubProjects, projectContexts]);

  // Projects on this board that have GitHub data
  const boardProjectsWithGithub = useMemo(() => {
    return allProjects
      .map(name => ({ name, github: githubLookup.get(name) }))
      .filter(p => p.github);
  }, [allProjects, githubLookup]);

  // Default project = project of the last task created by the user on this board
  const defaultProject = useMemo(() => {
    const userTasks = allTasks
      .filter(t => t.project && t.source?.type === 'user' && t.createdAt)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return userTasks[0]?.project || '';
  }, [allTasks]);

  // Filtered tasks
  const filteredTasks = useMemo(() => {
    const q = search.toLowerCase();
    return allTasks.filter(t => {
      if (agentFilter && t.agentId !== agentFilter) return false;
      if (projectFilter && t.project !== projectFilter) return false;
      if (q && !t.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allTasks, agentFilter, projectFilter, search]);

  // Group by column — error is an internal state, not a workflow column.
  // Use errorFromStatus to keep error tasks visible in their originating column.
  const tasksByColumn = useMemo(() => {
    const groups = {};
    const fallbackColId = columns[0]?.id;
    columns.forEach(col => {
      const colTasks = filteredTasks.filter(t => {
        if (t.status === 'error') {
          return (t.errorFromStatus || fallbackColId) === col.id;
        }
        return col.statuses.includes(t.status || fallbackColId);
      });
      groups[col.id] = sortTasks(colTasks, sortBy);
    });
    return groups;
  }, [filteredTasks, columns, sortBy]);

  const handleDelete = useCallback(async (task) => {
    await deleteTaskById(task.id);
    refreshAll();
  }, [refreshAll]);

  const handleStopAction = useCallback(async (task) => {
    const agentId = task.actionRunningAgentId || task.assignee;
    if (agentId) {
      await api.stopAgent(agentId);
      refreshAll();
    }
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
      const fallbackColId = columns[0]?.id;
      const isAlreadyInColumn = task.status === 'error'
        ? (task.errorFromStatus || fallbackColId) === col.id
        : col.statuses.includes(task.status || fallbackColId);

      if (isAlreadyInColumn) {
        // Same column — just reorder
        if (dropIdx !== undefined) {
          await reorderColumnTasks(col.id, taskId, dropIdx);
        }
        return;
      }

      // Moving to a different column
      const prevStatus = task.status;
      setDbTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, status: col.dropStatus, updatedAt: new Date().toISOString() } : t
      ));
      try {
        await updateTaskById(taskId, { column: col.dropStatus });
        // After status change, reorder within the target column at the drop position
        if (dropIdx !== undefined) {
          await reorderColumnTasks(col.id, taskId, dropIdx);
        }
        refreshAll();
      } catch (apiErr) {
        console.error('[TasksBoard] Drop API failed, reverting:', apiErr.message);
        setDbTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: prevStatus } : t
        ));
      }
    } catch (err) {
      console.error('[TasksBoard] Drop status change failed:', err.message);
    }
  }, [allTasks, columns, refreshAll, isReadOnly, reorderColumnTasks]);

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
      const fallbackColId = columns[0]?.id;
      const isAlreadyInColumn = task.status === 'error'
        ? (task.errorFromStatus || fallbackColId) === col.id
        : col.statuses.includes(task.status || fallbackColId);
      if (isAlreadyInColumn) return;

      const prevStatus = task.status;
      setDbTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, status: col.dropStatus, updatedAt: new Date().toISOString() } : t
      ));

      try {
        await updateTaskById(taskId, { column: col.dropStatus });
        // Touch drop appends to end of target column
        await reorderColumnTasks(col.id, taskId, (tasksByColumn[col.id] || []).length);
        refreshAll();
      } catch (apiErr) {
        console.error('[TasksBoard] Touch drop API failed, reverting:', apiErr.message);
        setDbTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: prevStatus } : t
        ));
      }
    } catch (err) {
      console.error('[TasksBoard] Touch drop failed:', err.message);
    }
  }, [allTasks, columns, refreshAll, isReadOnly, reorderColumnTasks, tasksByColumn]);

  // Batch move all tasks from one column to another
  const handleBatchMove = useCallback(async (sourceColId, targetColId, tasks) => {
    if (isReadOnly || !tasks.length) return;
    const targetCol = columns.find(c => c.id === targetColId);
    if (!targetCol) return;
    // Optimistic update
    const taskIds = tasks.map(t => t.id);
    setDbTasks(prev => prev.map(t =>
      taskIds.includes(t.id) ? { ...t, status: targetCol.dropStatus, updatedAt: new Date().toISOString() } : t
    ));
    try {
      await Promise.all(tasks.map(t => updateTaskById(t.id, { column: targetCol.dropStatus })));
      refreshAll();
    } catch (err) {
      console.error('[TasksBoard] Batch move failed:', err.message);
      refreshAll();
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

  const activeFilters = [agentFilter, projectFilter, search].filter(Boolean).length;

  const [copiedBoardId, setCopiedBoardId] = useState(false);
  const handleCopyBoardId = (e) => {
    e.stopPropagation();
    if (selectedBoard) {
      navigator.clipboard.writeText(selectedBoard).then(() => {
        setCopiedBoardId(true);
        setTimeout(() => setCopiedBoardId(false), 2000);
      });
    }
  };

  // ── Board management handlers ──
  const handleCreateBoard = useCallback(async () => {
    try {
      // New boards always start with a clean 3-column workflow
      const board = await api.createBoard(`Board ${boards.length + 1}`);
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
      {boards.length > 0 && (
        <BoardTabs
          boards={boards}
          activeBoardId={activeBoardId}
          onSelect={setActiveBoardId}
          onCreate={handleCreateBoard}
          onRename={handleRenameBoard}
          onDelete={handleDeleteBoard}
          onShare={setShareBoard}
        />
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
          {agents.filter(a => a.enabled !== false).map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        {/* Project filter */}
        {allProjects.length > 0 && (
          <select
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
            className="px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
              focus:outline-none focus:border-indigo-500 transition-colors flex-shrink-0"
          >
            <option value="">All projects</option>
            {allProjects.map(p => <option key={p} value={p}>{p}</option>)}
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
            onClick={() => { setAgentFilter(''); setProjectFilter(''); setSearch(''); }}
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
        {canEdit && activeBoard && !activeBoard.is_default && (
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
              agents={agents}
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
            />
          ))}
        </div>
      </div>

      {/* Instructions edit modal */}
      {editInstructionsCol && columnInstructionsMap[editInstructionsCol] && (
        <InstructionsEditModal
          columnLabel={columns.find(c => c.id === editInstructionsCol)?.label || editInstructionsCol}
          instructions={columnInstructionsMap[editInstructionsCol]}
          agents={agents.filter(a => a.boardId === activeBoardId)}
          onClose={() => setEditInstructionsCol(null)}
          onSave={async (updatedEntries) => {
            if (!workflow) return;
            const updated = JSON.parse(JSON.stringify(workflow));
            for (const entry of updatedEntries) {
              const action = updated.transitions[entry.transitionIdx]?.actions?.[entry.actionIdx];
              if (action) {
                action.instructions = entry.instructions;
                if (entry.role !== undefined) action.role = entry.role;
              }
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
          allProjects={allProjects}
          statusOptions={statusOptions}
          onClose={() => setSelectedTask(null)}
          onRefresh={refreshAll}
          onDelete={handleDelete}
          onNavigateToAgent={onNavigateToAgent}
          boards={boards}
          activeBoardId={activeBoardId}
        />
      )}

      {/* Create task modal */}
      {createOpen && (
        <CreateTaskModal
          agents={agents}
          allProjects={allProjects}
          defaultProject={defaultProject}
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
          jiraStatus={jiraStatus}
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
          agentId={commitModalTask.agentId}
          project={commitModalTask.project}
        />
      )}

      {/* GitHub Activity modal */}
      {activityTarget && (
        <GitHubActivityModal
          owner={activityTarget.owner}
          repo={activityTarget.repo}
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
