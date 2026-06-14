import { useState, useEffect, useCallback } from 'react';
import {
  Users, Plus, Trash2, Edit3, Shield, ShieldCheck, ShieldAlert, Eye, Save,
} from 'lucide-react';
import { api } from '../../api';

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

export default function UsersTab({ showToast, onImpersonate, onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [createForm, setCreateForm] = useState({ username: '', password: '', role: 'basic', displayName: '' });
  const [editForm, setEditForm] = useState({ username: '', role: '', displayName: '', password: '' });

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
      const updates: { username?: string; role?: string; displayName?: string; password?: string } = {};
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

  return (<>
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
  </>);
}
