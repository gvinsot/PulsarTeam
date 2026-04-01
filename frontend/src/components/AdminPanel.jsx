import { useState, useEffect, useCallback } from 'react';
import {
  X, Users, Plus, Trash2, Edit3, Shield, ShieldCheck, ShieldAlert,
  UserCheck, Eye, Save, AlertCircle, Crown, Settings, ToggleLeft, ToggleRight,
  Cpu, EyeOff
} from 'lucide-react';
import { api } from '../api';

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

  // LLM Configs tab state
  const [llmConfigs, setLlmConfigs] = useState([]);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmForm, setLlmForm] = useState(null); // null = closed, {} = new, {id} = editing
  const [llmSaving, setLlmSaving] = useState(false);
  const [showLlmApiKey, setShowLlmApiKey] = useState({});

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

  useEffect(() => { if (activeTab === 'settings') loadSettings(); }, [activeTab, loadSettings]);

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

  const PROVIDER_OPTIONS = ['anthropic', 'claude-paid', 'openai', 'google', 'deepseek', 'mistral', 'openrouter', 'vllm', 'ollama'];
  const PROVIDER_LABELS = { 'claude-paid': 'Anthropic Paid Plan' };

  const handleSaveLlmConfig = async (e) => {
    e.preventDefault();
    if (!llmForm) return;
    try {
      setLlmSaving(true);
      if (llmForm.id) {
        await api.updateLlmConfig(llmForm.id, llmForm);
      } else {
        await api.createLlmConfig(llmForm);
      }
      setLlmForm(null);
      showToast?.(llmForm.id ? 'LLM config updated' : 'LLM config created', 'success');
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

  const handleSaveSettings = async () => {
    try {
      setSettingsSaving(true);
      const updated = await api.updateSettings(settings);
      setSettings(updated);
      showToast?.('Settings saved', 'success');
    } catch (err) {
      showToast?.(`Failed to save settings: ${err.message}`, 'error');
    } finally {
      setSettingsSaving(false);
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
              {/* Jira Integration */}
              <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
                      <span className="text-lg">🔗</span> Jira Integration
                    </h4>
                    <p className="text-xs text-dark-400 mt-1">
                      Synchronize tasks with Jira boards. Requires JIRA_BOARD_URL, JIRA_API_KEY, and JIRA_USER_EMAIL environment variables.
                    </p>
                  </div>
                  <button
                    onClick={() => setSettings(s => ({ ...s, jiraEnabled: s.jiraEnabled === 'true' ? 'false' : 'true' }))}
                    className="flex-shrink-0"
                  >
                    {settings.jiraEnabled === 'true' ? (
                      <ToggleRight className="w-10 h-10 text-green-400" />
                    ) : (
                      <ToggleLeft className="w-10 h-10 text-dark-500" />
                    )}
                  </button>
                </div>
                <div className={`text-xs px-3 py-2 rounded-lg ${
                  settings.jiraEnabled === 'true'
                    ? 'bg-green-900/20 text-green-400 border border-green-800/30'
                    : 'bg-dark-900 text-dark-500 border border-dark-600'
                }`}>
                  {settings.jiraEnabled === 'true' ? 'Jira sync is enabled — tasks will be synchronized with your Jira board' : 'Jira sync is disabled — no data will be exchanged with Jira'}
                </div>
              </div>

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

              {/* Save button */}
              <div className="flex justify-end">
                <button
                  onClick={handleSaveSettings}
                  disabled={settingsSaving}
                  className="flex items-center gap-2 px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {settingsSaving ? 'Saving...' : 'Save Settings'}
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
            <div className="space-y-2">
              {users.map(user => {
                const rc = ROLE_CONFIG[user.role] || ROLE_CONFIG.basic;
                const RoleIcon = rc.icon;
                return (
                  <div
                    key={user.id}
                    className="flex items-center justify-between p-4 bg-dark-800 rounded-xl border border-dark-700 hover:border-dark-600 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${rc.bg}`}>
                        <RoleIcon className={`w-5 h-5 ${rc.color}`} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-dark-100 truncate">{user.display_name || user.username}</span>
                          {user.display_name && user.display_name !== user.username && (
                            <span className="text-xs text-dark-500">@{user.username}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${rc.bg} ${rc.color}`}>
                            {rc.label}
                          </span>
                          <span className="text-xs text-dark-500">
                            Created {new Date(user.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleImpersonate(user)}
                        className="p-2 text-dark-400 hover:text-emerald-400 hover:bg-dark-700 rounded-lg transition-colors"
                        title={`Impersonate ${user.username}`}
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => startEdit(user)}
                        className="p-2 text-dark-400 hover:text-indigo-400 hover:bg-dark-700 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(user)}
                        className="p-2 text-dark-400 hover:text-red-400 hover:bg-dark-700 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
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

          {/* Create/Edit Form */}
          {llmForm && (
            <form onSubmit={handleSaveLlmConfig} className={`p-4 bg-dark-800 rounded-xl border space-y-4 ${llmForm.id ? 'border-indigo-500/30' : 'border-dark-700'}`}>
              <h4 className="text-sm font-semibold text-dark-200">{llmForm.id ? 'Edit LLM Config' : 'New LLM Config'}</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Name</label>
                  <input type="text" value={llmForm.name || ''} onChange={e => setLlmForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="e.g. Claude Opus 4" required />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Provider</label>
                  <select value={llmForm.provider || ''} onChange={e => {
                      const prov = e.target.value;
                      const updates = { provider: prov, model: '' };
                      if (prov === 'claude-paid') { updates.endpoint = 'http://coder-service:8000'; updates.apiKey = ''; }
                      setLlmForm(f => ({ ...f, ...updates }));
                    }}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500" required>
                    <option value="">Select provider...</option>
                    {PROVIDER_OPTIONS.map(p => <option key={p} value={p}>{PROVIDER_LABELS[p] || p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Model ID</label>
                  <input type="text" value={llmForm.model || ''} onChange={e => setLlmForm(f => ({ ...f, model: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="e.g. claude-opus-4-20250514" required />
                </div>
                {llmForm.provider !== 'claude-paid' && (
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Endpoint <span className="text-dark-500">(vLLM/Ollama only)</span></label>
                  <input type="text" value={llmForm.endpoint || ''} onChange={e => setLlmForm(f => ({ ...f, endpoint: e.target.value }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="http://localhost:8000/v1" />
                </div>
                )}
                {llmForm.provider === 'claude-paid' && (
                <div className="sm:col-span-2">
                  <div className="px-3 py-2 bg-dark-900/50 border border-dark-700 rounded-lg text-xs text-dark-400">
                    🔒 Authentication is handled via OAuth per agent (coder-service). No API key needed.
                    Endpoint is auto-configured to <code className="text-indigo-400">coder-service:8000</code>.
                  </div>
                </div>
                )}
                {llmForm.provider !== 'claude-paid' && (
                <div className="relative">
                  <label className="block text-xs text-dark-400 mb-1">API Key</label>
                  <input type={showLlmApiKey[llmForm.id || '_new'] ? 'text' : 'password'}
                    autoComplete="off"
                    value={llmForm.apiKey || ''} onChange={e => setLlmForm(f => ({ ...f, apiKey: e.target.value }))}
                    className="w-full px-3 py-2 pr-10 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="API key for this LLM" />
                  <button type="button" onClick={() => setShowLlmApiKey(p => ({ ...p, [llmForm.id || '_new']: !p[llmForm.id || '_new'] }))}
                    className="absolute right-2 top-7 text-dark-400 hover:text-dark-200">
                    {showLlmApiKey[llmForm.id || '_new'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                )}
                <div className="flex items-center gap-4 pt-5">
                  <label className="flex items-center gap-2 text-sm text-dark-300 cursor-pointer">
                    <input type="checkbox" checked={llmForm.isReasoning || false} onChange={e => setLlmForm(f => ({ ...f, isReasoning: e.target.checked }))}
                      className="rounded border-dark-600 bg-dark-900 text-indigo-500 focus:ring-indigo-500" />
                    Reasoning model
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm text-dark-300 cursor-pointer">
                  <input type="checkbox" checked={llmForm.managesContext || false} onChange={e => setLlmForm(f => ({ ...f, managesContext: e.target.checked }))}
                    className="rounded border-dark-600 bg-dark-900 text-teal-500 focus:ring-teal-500" />
                  Manages own context
                </label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Context Size <span className="text-dark-500">(tokens)</span></label>
                  <input type="number" min="1" value={llmForm.contextSize ?? ''} onChange={e => setLlmForm(f => ({ ...f, contextSize: e.target.value ? Number(e.target.value) : null }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="e.g. 200000" />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Max Output Tokens</label>
                  <input type="number" min="1" value={llmForm.maxOutputTokens ?? ''} onChange={e => setLlmForm(f => ({ ...f, maxOutputTokens: e.target.value ? Number(e.target.value) : null }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="e.g. 16384" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <input
                      type="checkbox" checked={llmForm.temperature != null}
                      onChange={e => setLlmForm(f => ({ ...f, temperature: e.target.checked ? 0.7 : null }))}
                      className="rounded border-dark-600 bg-dark-900 text-indigo-500 focus:ring-indigo-500"
                    />
                    <label className="text-xs text-dark-400">
                      Temperature{llmForm.temperature != null ? `: ${llmForm.temperature}` : ' (disabled — model default)'}
                    </label>
                  </div>
                  {llmForm.temperature != null && (
                    <input type="range" min="0" max="1" step="0.1" value={llmForm.temperature}
                      onChange={e => setLlmForm(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
                      className="w-full accent-indigo-500" />
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Cost / 1M input tokens ($)</label>
                  <input type="number" step="0.01" min="0" value={llmForm.costPerInputToken ?? ''} onChange={e => setLlmForm(f => ({ ...f, costPerInputToken: e.target.value ? Number(e.target.value) : null }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="e.g. 15.00" />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1">Cost / 1M output tokens ($)</label>
                  <input type="number" step="0.01" min="0" value={llmForm.costPerOutputToken ?? ''} onChange={e => setLlmForm(f => ({ ...f, costPerOutputToken: e.target.value ? Number(e.target.value) : null }))}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="e.g. 75.00" />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setLlmForm(null)} className="px-3 py-1.5 text-sm text-dark-400 hover:text-dark-200">Cancel</button>
                <button type="submit" disabled={llmSaving}
                  className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                  <Save className="w-3.5 h-3.5" />
                  {llmSaving ? 'Saving...' : llmForm.id ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
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
        </div>
      </div>
    </div>
  );
}
