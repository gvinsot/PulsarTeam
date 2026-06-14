import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Edit3, Save, LayoutGrid, GripVertical, Bot, ListTodo } from 'lucide-react';
import { api } from '../../api';

// `active` flips true when the Boards tab is selected; each activation
// re-fetches the boards and their agent/task counts.
export default function BoardsTab({ active, showToast }) {
  const [boardsList, setBoardsList] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [boardsAgentCounts, setBoardsAgentCounts] = useState({});
  const [boardsTaskCounts, setBoardsTaskCounts] = useState({});
  const [boardEditingId, setBoardEditingId] = useState(null);
  const [boardForm, setBoardForm] = useState({ name: '', columns: [], transitions: [] });
  const [boardCreating, setBoardCreating] = useState(false);
  const [boardSaving, setBoardSaving] = useState(false);

  const loadBoards = useCallback(async () => {
    try {
      setBoardsLoading(true);
      const [boards, agents, tasks] = await Promise.all([
        api.getAllBoardsAdmin(),
        api.getAgents(),
        api.getAllTasks(),
      ]);
      setBoardsList(boards);
      // Count agents per board
      const agentCounts = {};
      (agents || []).forEach(a => {
        const bid = a.boardId || '__none__';
        agentCounts[bid] = (agentCounts[bid] || 0) + 1;
      });
      setBoardsAgentCounts(agentCounts);
      // Count tasks per board
      const taskCounts = {};
      (tasks || []).forEach(t => {
        const bid = t.boardId || '__none__';
        taskCounts[bid] = (taskCounts[bid] || 0) + 1;
      });
      setBoardsTaskCounts(taskCounts);
    } catch (err) {
      showToast?.(`Failed to load boards: ${err.message}`, 'error');
    } finally {
      setBoardsLoading(false);
    }
  }, [showToast]);

  useEffect(() => { if (active) loadBoards(); }, [active, loadBoards]);

  // Board handlers
  const startBoardCreate = () => {
    setBoardCreating(true);
    setBoardEditingId(null);
    setBoardForm({
      name: '',
      columns: [
        { id: 'backlog', label: 'Backlog', color: '#6b7280' },
        { id: 'in_progress', label: 'In Progress', color: '#eab308' },
        { id: 'done', label: 'Done', color: '#22c55e' },
      ],
      transitions: [
        {
          from: 'in_progress',
          trigger: 'on_enter',
          conditions: [],
          actions: [
            { type: 'run_agent', mode: 'decide', role: '', instructions: 'Execute the task fully, and when you are finished, update the task to next state.' },
            { type: 'change_status', target: '__next__' },
          ],
        },
      ],
    });
  };

  const startBoardEdit = (board) => {
    setBoardEditingId(board.id);
    setBoardCreating(false);
    const cols = board.workflow?.columns || [];
    setBoardForm({ name: board.name, columns: cols.map(c => ({ ...c })), transitions: board.workflow?.transitions || [] });
  };

  const cancelBoardEdit = () => {
    setBoardEditingId(null);
    setBoardCreating(false);
  };

  const handleSaveBoard = async () => {
    try {
      setBoardSaving(true);
      const workflow = { columns: boardForm.columns, transitions: boardForm.transitions || [] };
      if (boardCreating) {
        await api.createBoard(boardForm.name || 'New Board', workflow, {});
        showToast?.('Board created', 'success');
      } else if (boardEditingId) {
        await api.updateBoard(boardEditingId, { name: boardForm.name, workflow });
        showToast?.('Board updated', 'success');
      }
      cancelBoardEdit();
      loadBoards();
    } catch (err) {
      showToast?.(`Failed to save board: ${err.message}`, 'error');
    } finally {
      setBoardSaving(false);
    }
  };

  const handleDeleteBoard = async (board) => {
    if (!confirm(`Delete board "${board.name}"? All tasks in this board will be lost. This cannot be undone.`)) return;
    try {
      await api.deleteBoard(board.id);
      showToast?.('Board deleted', 'success');
      loadBoards();
    } catch (err) {
      showToast?.(`Failed to delete: ${err.message}`, 'error');
    }
  };

  const addBoardColumn = () => {
    const id = `col_${Date.now()}`;
    setBoardForm(f => ({ ...f, columns: [...f.columns, { id, label: 'New Column', color: '#6b7280' }] }));
  };

  const updateBoardColumn = (idx, field, value) => {
    setBoardForm(f => ({
      ...f,
      columns: f.columns.map((c, i) => i === idx ? { ...c, [field]: value } : c),
    }));
  };

  const removeBoardColumn = (idx) => {
    setBoardForm(f => ({ ...f, columns: f.columns.filter((_, i) => i !== idx) }));
  };

  return (<>
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-dark-300 uppercase tracking-wider flex items-center gap-2">
        <LayoutGrid className="w-4 h-4" />
        Boards ({boardsList.length})
      </h3>
      <button
        onClick={startBoardCreate}
        className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors"
      >
        <Plus className="w-4 h-4" />
        New Board
      </button>
    </div>

    {/* Create / Edit Form */}
    {(boardCreating || boardEditingId) && (
      <div className="p-5 bg-dark-800 rounded-xl border border-indigo-500/30 space-y-4">
        <h4 className="text-sm font-semibold text-dark-200">
          {boardCreating ? 'Create New Board' : `Edit: ${boardForm.name}`}
        </h4>
        <div>
          <label className="block text-xs text-dark-400 mb-1">Board Name</label>
          <input
            type="text"
            value={boardForm.name}
            onChange={e => setBoardForm(f => ({ ...f, name: e.target.value }))}
            className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
            placeholder="My Board"
          />
        </div>

        {/* Columns editor */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-dark-400">Workflow Columns</label>
            <button
              onClick={addBoardColumn}
              className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-400 hover:bg-dark-700 rounded transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Column
            </button>
          </div>
          <div className="space-y-2">
            {boardForm.columns.map((col, idx) => (
              <div key={col.id} className="flex items-center gap-2 p-2 bg-dark-900 rounded-lg border border-dark-600">
                <GripVertical className="w-3.5 h-3.5 text-dark-600 flex-shrink-0" />
                <input
                  type="color"
                  value={col.color || '#6b7280'}
                  onChange={e => updateBoardColumn(idx, 'color', e.target.value)}
                  className="w-7 h-7 rounded border border-dark-600 bg-dark-800 cursor-pointer flex-shrink-0"
                />
                <input
                  type="text"
                  value={col.id}
                  onChange={e => updateBoardColumn(idx, 'id', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                  className="w-28 px-2 py-1 bg-dark-800 border border-dark-600 rounded text-xs text-dark-400 font-mono focus:outline-none focus:border-indigo-500"
                  placeholder="column_id"
                />
                <input
                  type="text"
                  value={col.label}
                  onChange={e => updateBoardColumn(idx, 'label', e.target.value)}
                  className="flex-1 px-2 py-1 bg-dark-800 border border-dark-600 rounded text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  placeholder="Column Label"
                />
                <button
                  onClick={() => removeBoardColumn(idx)}
                  className="p-1 text-dark-500 hover:text-red-400 rounded transition-colors flex-shrink-0"
                  title="Remove column"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {boardForm.columns.length === 0 && (
              <div className="text-center py-3 text-xs text-dark-500">No columns defined. Add at least one column.</div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={cancelBoardEdit} className="px-3 py-1.5 text-sm text-dark-400 hover:text-dark-200">
            Cancel
          </button>
          <button
            onClick={handleSaveBoard}
            disabled={boardSaving || boardForm.columns.length === 0}
            className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {boardSaving ? 'Saving...' : boardCreating ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    )}

    {/* Boards List */}
    {boardsLoading ? (
      <div className="text-center py-8">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    ) : boardsList.length === 0 ? (
      <div className="text-center py-12 text-dark-400">
        <LayoutGrid className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">No boards yet.</p>
        <p className="text-xs mt-1">Create a board to organize your tasks.</p>
      </div>
    ) : (
      <div className="space-y-2">
        {boardsList.map(board => {
          const cols = board.workflow?.columns || [];
          const agentCount = boardsAgentCounts[board.id] || 0;
          const taskCount = boardsTaskCounts[board.id] || 0;
          return (
            <div
              key={board.id}
              className="p-4 bg-dark-800 rounded-xl border border-dark-700 hover:border-dark-600 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-dark-100">{board.name}</span>
                    {board.is_default && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">Default</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="flex items-center gap-1 text-xs text-dark-400" title="Columns">
                      <LayoutGrid className="w-3 h-3" />
                      {cols.length} columns
                    </span>
                    <span className="flex items-center gap-1 text-xs text-dark-400" title="Agents">
                      <Bot className="w-3 h-3" />
                      {agentCount} agents
                    </span>
                    <span className="flex items-center gap-1 text-xs text-dark-400" title="Workflows">
                      <ListTodo className="w-3 h-3" />
                      {taskCount} workflows
                    </span>
                    {board.username && (
                      <span className="text-xs text-dark-500">
                        Owner: {board.display_name || board.username}
                      </span>
                    )}
                  </div>
                  {/* Column preview chips */}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {cols.map(col => (
                      <span
                        key={col.id}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-dark-300 bg-dark-900 border border-dark-600"
                      >
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: col.color || '#6b7280' }} />
                        {col.label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0 ml-4">
                  <button
                    onClick={() => startBoardEdit(board)}
                    className="p-2 text-dark-400 hover:text-indigo-400 hover:bg-dark-700 rounded-lg transition-colors"
                    title="Edit"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  {!board.is_default && (
                    <button
                      onClick={() => handleDeleteBoard(board)}
                      className="p-2 text-dark-400 hover:text-red-400 hover:bg-dark-700 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    )}

    <div className="p-4 bg-dark-800/50 rounded-xl border border-dark-700">
      <p className="text-xs text-dark-400">
        Boards organize tasks into workflow columns. Each board can have its own set of columns, transitions, and assigned agents.
        Agents attached to a board will only process tasks from that board.
      </p>
    </div>
  </>);
}
