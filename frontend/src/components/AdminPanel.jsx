import { useState, useEffect, useCallback } from 'react';
import {
  X, Users, Plus, Trash2, Edit3, Shield, ShieldCheck, ShieldAlert,
  UserCheck, Eye, Save, AlertCircle, Crown, Settings, ToggleLeft, ToggleRight
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-dark-900 border border-dark-700 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-dark-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center">
              <Crown className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-dark-100">Control Panel</h2>
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
        </div>
      </div>
    </div>
  );
}
