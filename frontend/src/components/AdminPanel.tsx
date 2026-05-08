import { useState, useEffect, useCallback } from 'react';
import {
  X, Users, Plus, Trash2, Edit3, Shield, ShieldCheck, ShieldAlert,
  UserCheck, Eye, Save, AlertCircle, Crown, Settings, ToggleLeft, ToggleRight,
  Cpu, Bell, RotateCcw, LayoutGrid, GripVertical, Bot, ListTodo
} from 'lucide-react';
import { api } from '../api';
import LlmConfigModal from './LlmConfigModal';

function timeAgo(date: string | null): string {
  if (!date) return 'never';
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const ROLE_CONFIG = {
  admin: { label: 'Admin', icon: ShieldAlert, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/30' },
  advanced: { label: 'Advanced', icon: ShieldCheck, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' },
  basic: { label: 'Basic', icon: Shield, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/30' },
};

export default function AdminPanel({ onClose, onImpersonate, showToast }) {
  const [activeTab, setActiveTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [createForm, setCreateForm] = useState({ username: '', password: '', role: 'basic', displayName: '' });
  const [editForm, setEditForm] = useState({ username: '', role: '', displayName: '', password: '' });

  // Settings tab state
  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [customCurrency, setCustomCurrency] = useState('');

  // Reminder config state
  const [reminderConfig, setReminderConfig] = useState(null);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderSaving, setReminderSaving] = useState(false);

  // Reset instructions state
  const [resetRole, setResetRole] = useState('');
  const [resetRoles, setResetRoles] = useState([]);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  // LLM Configs tab state
  const [llmConfigs, setLlmConfigs] = useState([]);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmForm, setLlmForm] = useState(null); // null = closed, {} = new, {id} = editing
  const [llmSaving, setLlmSaving] = useState(false);

  // Boards tab state
  const [boardsList, setBoardsList] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [boardsAgentCounts, setBoardsAgentCounts] = useState({});
  const [boardsTaskCounts, setBoardsTaskCounts] = useState({});
  const [boardEditingId, setBoardEditingId] = useState(null);
  const [boardForm, setBoardForm] = useState({ name: '', columns: [] });
  const [boardCreating, setBoardCreating] = useState(false);
  const [boardSaving, setBoardSaving] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      showToast?.(`Failed to load users: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const loadSettings = useCallback(async () => {
    try {
      setSettingsLoading(true);
      const data = await api.getSettings();
      setSettings(data);
      const known = ['$', '€', '£'];
      if (data.currency && !known.includes(data.currency)) {
        setCustomCurrency(data.currency);
      }
    } catch (err) {
      showToast?.(`Failed to load settings: ${err.message}`, 'error');
    } finally {
      setSettingsLoading(false);
    }
  }, [showToast]);

  const loadReminderConfig = useCallback(async () => {
    try {
      setReminderLoading(true);
      const data = await api.getReminderConfig();
      setReminderConfig(data);
    } catch (err) {
      showToast?.(`Failed to load reminder config: ${err.message}`, 'error');
    } finally {
      setReminderLoading(false);
    }
  }, [showToast]);

  const loadResetRoles = useCallback(async () => {
    try {
      const templates = await api.getTemplates();
      const roles = [...new Set(templates.map(t => t.role).filter(Boolean))];
      setResetRoles(roles);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (activeTab === 'settings') { loadSettings(); loadReminderConfig(); loadResetRoles(); } }, [activeTab, loadSettings, loadReminderConfig, loadResetRoles]);

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

  useEffect(() => { if (activeTab === 'boards') loadBoards(); }, [activeTab, loadBoards]);

  const loadLlmConfigs = useCallback(async () => {
    try {
      setLlmLoading(true);
      const data = await api.getLlmConfigs();
      setLlmConfigs(data);
    } catch (err) {
      showToast?.(`Failed to load LLM configs: ${err.message}`, 'error');
    } finally {
      setLlmLoading(false);
    }
  }, [showToast]);

  useEffect(() => { if (activeTab === 'llm') loadLlmConfigs(); }, [activeTab, loadLlmConfigs]);

  const handleSaveLlmConfig = async (formData) => {
    try {
      setLlmSaving(true);
      if (formData.id) {
        await api.updateLlmConfig(formData.id, formData);
      } else {
        await api.createLlmConfig(formData);
      }
      setLlmForm(null);
      showToast?.(formData.id ? 'LLM config updated' : 'LLM config created', 'success');
      loadLlmConfigs();
    } catch (err) {
      showToast?.(`Failed to save LLM config: ${err.message}`, 'error');
    } finally {
      setLlmSaving(false);
    }
  };

  const handleDeleteLlmConfig = async (config) => {
    if (!confirm(`Delete LLM config "${config.name}"? Agents using it will fall back to legacy settings.`)) return;
    try {
      await api.deleteLlmConfig(config.id);
      showToast?.('LLM config deleted', 'success');
      loadLlmConfigs();
    } catch (err) {
      showToast?.(`Failed to delete: ${err.message}`, 'error');
    }
  };

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
    });
  };

  const startBoardEdit = (board) => {
    setBoardEditingId(board.id);
    setBoardCreating(false);
    const cols = board.workflow?.columns || [];
    setBoardForm({ name: board.name, columns: cols.map(c => ({ ...c })) });
  };

  const cancelBoardEdit = () => {
    setBoardEditingId(null);
    setBoardCreating(false);
  };

  const handleSaveBoard = async () => {
    try {
      setBoardSaving(true);
      const workflow = { columns: boardForm.columns };
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

  const handleSaveSettings = async () => {
    try {
      setSettingsSaving(true);
      const updated = await api.updateSettings(settings);
      setSettings(updated);
      if (reminderConfig) {
        setReminderSaving(true);
        const updatedReminder = await api.updateReminderConfig(reminderConfig);
        setReminderConfig(updatedReminder);
      }
      showToast?.('Settings saved', 'success');
    } catch (err) {
      showToast?.(`Failed to save settings: ${err.message}`, 'error');
    } finally {
      setSettingsSaving(false);
      setReminderSaving(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await api.createUser({
        username: createForm.username,
        password: createForm.password,
        role: createForm.role,
        displayName: createForm.displayName || createForm.username,
      });
      setCreateForm({ username: '', password: '', role: 'basic', displayName: '' });
      setShowCreateForm(false);
      showToast?.('User created', 'success');
      loadUsers();
    } catch (err) {
      showToast?.(`Failed to create user: ${err.message}`, 'error');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      const updates = {};
      if (editForm.username && editForm.username !== editingUser.username) updates.username = editForm.username;
      if (editForm.role && editForm.role !== editingUser.role) updates.role = editForm.role;
      if (editForm.displayName !== undefined) updates.displayName = editForm.displayName;
      if (editForm.password) updates.password = editForm.password;

      await api.updateUser(editingUser.id, updates);
      setEditingUser(null);
      showToast?.('User updated', 'success');
      loadUsers();
    } catch (err) {
      showToast?.(`Failed to update user: ${err.message}`, 'error');
    }
  };

  const handleDelete = async (user) => {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await api.deleteUser(user.id);
      showToast?.('User deleted', 'success');
      loadUsers();
    } catch (err) {
      showToast?.(`Failed to delete user: ${err.message}`, 'error');
    }
  };

  const handleImpersonate = async (user) => {
    try {
      const data = await api.impersonate(user.id);
      onImpersonate?.(data);
      onClose();
    } catch (err) {
      showToast?.(`Failed to impersonate: ${err.message}`, 'error');
    }
  };

  const startEdit = (user) => {
    setEditingUser(user);
    setEditForm({
      username: user.username,
      role: user.role,
      displayName: user.display_name || '',
      password: '',
    });
    setShowCreateForm(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div
        className="bg-dark-900 border border-dark-700 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-dark-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center">
              <Crown className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-dark-100">Admin Settings</h2>
              <p className="text-xs text-dark-400">Administration & Configuration</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-dark-700">
          <button
            onClick={() => setActiveTab('users')}
            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === 'users'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-dark-400 hover:text-dark-200'
            }`}
          >
            <Users className="w-4 h-4" />
            Users
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === 'settings'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-dark-400 hover:text-dark-200'
            }`}
          >
            <Settings className="w-4 h-4" />
            Settings
          </button>
          <button
            onClick={() => setActiveTab('llm')}
            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === 'llm'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-dark-400 hover:text-dark-200'
            }`}
          >
            <Cpu className="w-4 h-4" />
            LLM Models
          </button>
          <button
            onClick={() => setActiveTab('boards')}
            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === 'boards'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-dark-400 hover:text-dark-200'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            Boards
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 space-y-6">

        {/* ─── Settings Tab ────────────────────────────────────────── */}
        {activeTab === 'settings' && (
          settingsLoading ? (
            <div className="text-center py-8">
              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : settings ? (
            <div className="space-y-6">
              {/* Currency */}
              <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
                <div>
                  <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
                    <span className="text-lg">💱</span> Currency
                  </h4>
                  <p className="text-xs text-dark-400 mt-1">
                    Currency symbol used across the Budget dashboard and cost displays.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { value: '$', label: 'USD ($)' },
                    { value: '€', label: 'EUR (€)' },
                    { value: '£', label: 'GBP (£)' },
                    { value: '¥', label: 'JPY (¥)' },
                    { value: 'CHF', label: 'CHF' },
                    { value: 'custom', label: 'Custom…' },
                  ].map(opt => {
                    const isCustom = opt.value === 'custom';
                    const isActive = isCustom
                      ? !['$', '€', '£', '¥', 'CHF'].includes(settings.currency)
                      : settings.currency === opt.value;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => {
                          if (isCustom) {
                            setSettings(s => ({ ...s, currency: customCurrency || '₿' }));
                          } else {
                            setSettings(s => ({ ...s, currency: opt.value }));
                            setCustomCurrency('');
                          }
                        }}
                        className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          isActive
                            ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                            : 'bg-dark-900 border-dark-600 text-dark-400 hover:text-dark-200 hover:border-dark-500'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                {!['$', '€', '£', '¥', 'CHF'].includes(settings.currency) && (
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-dark-400">Custom symbol:</label>
                    <input
                      type="text"
                      value={settings.currency || ''}
                      onChange={e => {
                        const v = e.target.value.slice(0, 5);
                        setSettings(s => ({ ...s, currency: v }));
                        setCustomCurrency(v);
                      }}
                      className="w-24 px-3 py-1.5 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      placeholder="₿"
                    />
                    <span className="text-xs text-dark-500">Preview: {settings.currency}1,234.56</span>
                  </div>
                )}
              </div>

              {/* Task Reminders */}
              <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
                <div>
                  <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
                    <Bell className="w-4 h-4 text-amber-400" />
                    Task Reminders
                  </h4>
                  <p className="text-xs text-dark-400 mt-1">
                    Configure how agents are reminded to complete their active tasks.
                  </p>
                </div>
                {reminderLoading ? (
                  <div className="text-center py-4">
                    <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
                  </div>
                ) : reminderConfig ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs text-dark-400 mb-1">Interval (minutes)</label>
                      <input
                        type="number"
                        min="1"
                        max="60"
                        value={reminderConfig.intervalMinutes ?? 10}
                        onChange={e => setReminderConfig(c => ({ ...c, intervalMinutes: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                        className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      />
                      <p className="text-[10px] text-dark-500 mt-1">Time between each reminder</p>
                    </div>
                    <div>
                      <label className="block text-xs text-dark-400 mb-1">Max reminders</label>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={reminderConfig.maxReminders ?? 12}
                        onChange={e => setReminderConfig(c => ({ ...c, maxReminders: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                        className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      />
                      <p className="text-[10px] text-dark-500 mt-1">Max attempts before giving up</p>
                    </div>
                    <div>
                      <label className="block text-xs text-dark-400 mb-1">Cooldown (minutes)</label>
                      <input
                        type="number"
                        min="0"
                        max="30"
                        value={reminderConfig.cooldownMinutes ?? 2}
                        onChange={e => setReminderConfig(c => ({ ...c, cooldownMinutes: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                        className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      />
                      <p className="text-[10px] text-dark-500 mt-1">Min wait after a reminder before next</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-dark-500">Failed to load reminder configuration</div>
                )}
                {reminderConfig?.envOverride && (
                  <div className="text-xs px-3 py-2 rounded-lg bg-amber-900/20 text-amber-400 border border-amber-800/30">
                    Interval is overridden by the TASK_REMINDER_INTERVAL_MINUTES environment variable.
                  </div>
                )}
              </div>

              {/* Reset Agent Instructions */}
              <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
                <div>
                  <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
                    <RotateCcw className="w-4 h-4 text-orange-400" />
                    Reset Agent Instructions
                  </h4>
                  <p className="text-xs text-dark-400 mt-1">
                    Reset instructions of all agents with a given role back to the default template.
                  </p>
                </div>
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-xs text-dark-400 mb-1">Agent Role</label>
                    <select
                      value={resetRole}
                      onChange={e => { setResetRole(e.target.value); setResetConfirm(false); }}
                      className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">Select a role…</option>
                      {resetRoles.map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  {!resetConfirm ? (
                    <button
                      onClick={() => setResetConfirm(true)}
                      disabled={!resetRole || resetLoading}
                      className="flex items-center gap-2 px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 border border-orange-500/40 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          setResetLoading(true);
                          try {
                            const res = await api.resetInstructionsByRole(resetRole);
                            showToast?.(`Reset ${res.resetCount} agent(s) with role "${resetRole}" to default instructions`, 'success');
                            setResetConfirm(false);
                          } catch (err) {
                            showToast?.(`Reset failed: ${err.message}`, 'error');
                          } finally {
                            setResetLoading(false);
                          }
                        }}
                        disabled={resetLoading}
                        className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        {resetLoading ? (
                          <div className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5" />
                        )}
                        Confirm Reset
                      </button>
                      <button
                        onClick={() => setResetConfirm(false)}
                        className="px-3 py-2 text-dark-400 hover:text-dark-200 text-sm transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
                {resetConfirm && resetRole && (
                  <div className="text-xs px-3 py-2 rounded-lg bg-red-900/20 text-red-400 border border-red-800/30">
                    This will overwrite the instructions of <strong>all agents</strong> with role "{resetRole}" — this cannot be undone.
                  </div>
                )}
              </div>

              {/* Save button */}
              <div className="flex justify-end">
                <button
                  onClick={handleSaveSettings}
                  disabled={settingsSaving || reminderSaving}
                  className="flex items-center gap-2 px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {settingsSaving || reminderSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-dark-400">Failed to load settings</div>
          )
        )}

        {/* ─── Users Tab ───────────────────────────────────────────── */}
        {activeTab === 'users' && (<>
          {/* Header bar */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-dark-300 uppercase tracking-wider flex items-center gap-2">
              <Users className="w-4 h-4" />
              Users ({users.length})
            </h3>
            <button
              onClick={() => { setShowCreateForm(!showCreateForm); setEditingUser(null); }}
              className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New User
            </button>
          </div>

          {/* Create Form */}
          {showCreateForm && (
            <form onSubmit={handleCreate} className="p-4 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
              <h4 className="text-sm font-semibold text-dark-200">Create New User</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Username</label>
                  <input
                    type="text"
                    value={createForm.username}
                    onChange={e => setCreateForm(p => ({ ...p, username: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    required
                    minLength={2}
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Display Name</label>
                  <input
                    type="text"
                    value={createForm.displayName}
                    onChange={e => setCreateForm(p => ({ ...p, displayName: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="Same as username if empty"
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Password</label>
                  <input
                    type="password"
                    value={createForm.password}
                    onChange={e => setCreateForm(p => ({ ...p, password: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    required
                    minLength={4}
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Role</label>
                  <select
                    value={createForm.role}
                    onChange={e => setCreateForm(p => ({ ...p, role: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="basic">Basic</option>
                    <option value="advanced">Advanced</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowCreateForm(false)} className="px-3 py-1.5 text-sm text-dark-400 hover:text-dark-200">
                  Cancel
                </button>
                <button type="submit" className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors">
                  <Plus className="w-3.5 h-3.5" />
                  Create
                </button>
              </div>
            </form>
          )}

          {/* Edit Form */}
          {editingUser && (
            <form onSubmit={handleUpdate} className="p-4 bg-dark-800 rounded-xl border border-indigo-500/30 space-y-4">
              <h4 className="text-sm font-semibold text-dark-200">Edit: {editingUser.username}</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Username</label>
                  <input
                    type="text"
                    value={editForm.username}
                    onChange={e => setEditForm(p => ({ ...p, username: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    minLength={2}
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Display Name</label>
                  <input
                    type="text"
                    value={editForm.displayName}
                    onChange={e => setEditForm(p => ({ ...p, displayName: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">New Password (leave blank to keep)</label>
                  <input
                    type="password"
                    value={editForm.password}
                    onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="Leave empty to keep current"
                    minLength={4}
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Role</label>
                  <select
                    value={editForm.role}
                    onChange={e => setEditForm(p => ({ ...p, role: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="basic">Basic</option>
                    <option value="advanced">Advanced</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setEditingUser(null)} className="px-3 py-1.5 text-sm text-dark-400 hover:text-dark-200">
                  Cancel
                </button>
                <button type="submit" className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors">
                  <Save className="w-3.5 h-3.5" />
                  Save
                </button>
              </div>
            </form>
          )}

          {/* User List */}
          {loading ? (
            <div className="text-center py-8">
              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : (
            <div className="space-y-1">
              {users.map(user => {
                const rc = ROLE_CONFIG[user.role] || ROLE_CONFIG.basic;
                const RoleIcon = rc.icon;
                return (
                  <div
                    key={user.id}
                    className="flex items-center justify-between px-3 py-2 bg-dark-800 rounded-lg border border-dark-700 hover:border-dark-600 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="relative flex-shrink-0">
                        <RoleIcon className={`w-4 h-4 ${rc.color}`} />
                        <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-dark-800 ${user.is_online ? 'bg-green-400' : 'bg-dark-600'}`} />
                      </div>
                      <span className="text-sm font-medium text-dark-100 truncate">{user.display_name || user.username}</span>
                      {user.display_name && user.display_name !== user.username && (
                        <span className="text-xs text-dark-500 hidden sm:inline">@{user.username}</span>
                      )}
                      <span className={`text-[10px] px-1 py-0.5 rounded ${rc.bg} ${rc.color}`}>{rc.label}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-[11px] ${user.is_online ? 'text-green-400' : 'text-dark-500'}`}>
                        {user.is_online ? 'online' : timeAgo(user.last_seen)}
                      </span>
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={() => handleImpersonate(user)}
                          className="p-1.5 text-dark-400 hover:text-emerald-400 hover:bg-dark-700 rounded transition-colors"
                          title={`Impersonate ${user.username}`}
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => startEdit(user)}
                          className="p-1.5 text-dark-400 hover:text-indigo-400 hover:bg-dark-700 rounded transition-colors"
                          title="Edit"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(user)}
                          className="p-1.5 text-dark-400 hover:text-red-400 hover:bg-dark-700 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Role Legend */}
          <div className="p-4 bg-dark-800/50 rounded-xl border border-dark-700">
            <h4 className="text-xs font-semibold text-dark-400 uppercase tracking-wider mb-3">Role Permissions</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-red-400" />
                  <span className="text-sm font-medium text-red-400">Admin</span>
                </div>
                <ul className="text-xs text-dark-400 space-y-0.5 ml-5">
                  <li>Full access to all features</li>
                  <li>User management</li>
                  <li>Impersonate users</li>
                  <li>See all agents</li>
                </ul>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-amber-400" />
                  <span className="text-sm font-medium text-amber-400">Advanced</span>
                </div>
                <ul className="text-xs text-dark-400 space-y-0.5 ml-5">
                  <li>Create & configure agents</li>
                  <li>Manage settings</li>
                  <li>Access all features</li>
                  <li>Own agents only</li>
                </ul>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-blue-400" />
                  <span className="text-sm font-medium text-blue-400">Basic</span>
                </div>
                <ul className="text-xs text-dark-400 space-y-0.5 ml-5">
                  <li>Chat with agents</li>
                  <li>View dashboards</li>
                  <li>Cannot create/edit agents</li>
                  <li>Cannot modify settings</li>
                </ul>
              </div>
            </div>
          </div>
        </>)}

        {/* ─── LLM Models Tab ─────────────────────────────────────── */}
        {activeTab === 'llm' && (<>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-dark-300 uppercase tracking-wider flex items-center gap-2">
              <Cpu className="w-4 h-4" />
              LLM Configurations ({llmConfigs.length})
            </h3>
            <button
              onClick={() => setLlmForm({ name: '', provider: 'anthropic', model: '', endpoint: '', apiKey: '', isReasoning: false, managesContext: false, temperature: null, contextSize: null, maxOutputTokens: null, costPerInputToken: null, costPerOutputToken: null })}
              className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New LLM
            </button>
          </div>

          {/* LLM Create/Edit Modal */}
          {llmForm && (
            <LlmConfigModal
              config={llmForm}
              onSave={handleSaveLlmConfig}
              onClose={() => setLlmForm(null)}
              saving={llmSaving}
            />
          )}

          {/* LLM Config List */}
          {llmLoading ? (
            <div className="text-center py-8">
              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : llmConfigs.length === 0 ? (
            <div className="text-center py-12 text-dark-400">
              <Cpu className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No LLM configurations yet.</p>
              <p className="text-xs mt-1">Create one to make it available for your agents.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {llmConfigs.map(config => (
                <div key={config.id} className="flex items-center justify-between p-4 bg-dark-800 rounded-xl border border-dark-700 hover:border-dark-600 transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-dark-100">{config.name}</span>
                      {config.isReasoning && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400">Reasoning</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-dark-400 capitalize">{config.provider}</span>
                      <span className="text-xs text-dark-500">{config.model}</span>
                      {config.managesContext && (
                        <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-teal-500/10 text-teal-400 border border-teal-500/20">Managed Context</span>
                      )}
                      {config.endpoint && <span className="text-xs text-dark-600 truncate max-w-[200px]">{config.endpoint}</span>}
                      {config.contextSize && <span className="text-xs text-dark-500">{(config.contextSize / 1000).toFixed(0)}k ctx</span>}
                      {config.maxOutputTokens && <span className="text-xs text-dark-500">{(config.maxOutputTokens / 1000).toFixed(0)}k out</span>}
                      {config.temperature != null && <span className="text-xs text-dark-500">temp {config.temperature}</span>}
                      {config.costPerInputToken != null && (
                        <span className="text-xs text-dark-500">${config.costPerInputToken}/{config.costPerOutputToken} per 1M</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => setLlmForm({ ...config })}
                      className="p-2 text-dark-400 hover:text-indigo-400 hover:bg-dark-700 rounded-lg transition-colors" title="Edit">
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDeleteLlmConfig(config)}
                      className="p-2 text-dark-400 hover:text-red-400 hover:bg-dark-700 rounded-lg transition-colors" title="Delete">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="p-4 bg-dark-800/50 rounded-xl border border-dark-700">
            <p className="text-xs text-dark-400">
              LLM configurations are shared across the team. When you assign an LLM to an agent, it uses the provider, model, and API key from this configuration.
              Agents can still override the API key in their own settings.
            </p>
          </div>
        </>)}

        {/* ─── Boards Tab ─────────────────────────────────────────── */}
        {activeTab === 'boards' && (<>
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
        </>)}
        </div>
      </div>
    </div>
  );
}
