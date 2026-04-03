import { useState, useEffect, useRef } from 'react';
import { X, Users, Shield, Eye, Edit3, Crown, Trash2, UserPlus, Loader2 } from 'lucide-react';
import { api } from '../api';

const PERMISSION_LEVELS = [
  { value: 'read',  label: 'Read',  icon: Eye,     desc: 'Can view tasks',       cls: 'text-blue-400 bg-blue-500/10' },
  { value: 'edit',  label: 'Edit',  icon: Edit3,   desc: 'Can modify tasks',     cls: 'text-amber-400 bg-amber-500/10' },
  { value: 'admin', label: 'Admin', icon: Shield,  desc: 'Can share & manage',   cls: 'text-purple-400 bg-purple-500/10' },
];

export default function ShareBoardModal({ board, onClose, currentUserId }) {
  const [shares, setShares] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState('read');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const modalRef = useRef(null);
  const inputRef = useRef(null);

  const isOwner = board.user_id === currentUserId;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [sharesData, usersData] = await Promise.all([
          api.getBoardShares(board.id),
          api.getBoardUsers(),
        ]);
        if (!cancelled) {
          setShares(sharesData || []);
          setAllUsers(usersData || []);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [board.id]);

  useEffect(() => {
    const handler = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Filter out already shared users and the owner
  const availableUsers = allUsers.filter(u =>
    u.id !== currentUserId &&
    u.id !== board.user_id &&
    !shares.find(s => s.user_id === u.id)
  );

  const filteredSuggestions = username.trim()
    ? availableUsers.filter(u =>
        u.username.toLowerCase().includes(username.toLowerCase()) ||
        (u.display_name || '').toLowerCase().includes(username.toLowerCase())
      ).slice(0, 5)
    : [];

  const handleShare = async (e) => {
    e?.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await api.shareBoardWith(board.id, trimmed, permission);
      // Reload shares
      const updated = await api.getBoardShares(board.id);
      setShares(updated || []);
      setUsername('');
      setPermission('read');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdatePermission = async (userId, newPermission) => {
    try {
      await api.updateBoardShare(board.id, userId, newPermission);
      setShares(prev => prev.map(s => s.user_id === userId ? { ...s, permission: newPermission } : s));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRevoke = async (userId, displayName) => {
    if (!confirm(`Remove ${displayName}'s access to this board?`)) return;
    try {
      await api.removeBoardShare(board.id, userId);
      setShares(prev => prev.filter(s => s.user_id !== userId));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        ref={modalRef}
        className="bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-dark-100">Share "{board.name}"</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Owner info */}
          <div className="flex items-center gap-3 px-3 py-2.5 bg-dark-800/60 rounded-lg border border-dark-700/50">
            <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center">
              <Crown className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-dark-200 font-medium truncate">
                {isOwner ? 'You' : (board.owner_username || 'Owner')}
              </div>
              <div className="text-xs text-dark-500">Owner</div>
            </div>
          </div>

          {/* Add user form */}
          {isOwner && (
            <form onSubmit={handleShare} className="space-y-2">
              <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide">
                <UserPlus className="inline w-3 h-3 mr-1" />
                Invite User
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="Username..."
                    className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
                      placeholder-dark-500 focus:outline-none focus:border-indigo-500 transition-colors"
                    autoComplete="off"
                  />
                  {/* Suggestions dropdown */}
                  {filteredSuggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-dark-800 border border-dark-600 rounded-lg shadow-xl py-1 max-h-40 overflow-y-auto">
                      {filteredSuggestions.map(u => (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => { setUsername(u.username); inputRef.current?.focus(); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700 flex items-center gap-2"
                        >
                          <span className="font-medium">{u.username}</span>
                          {u.display_name && <span className="text-dark-500">({u.display_name})</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <select
                  value={permission}
                  onChange={e => setPermission(e.target.value)}
                  className="px-2 py-2 bg-dark-800 border border-dark-700 rounded-lg text-xs text-dark-200
                    focus:outline-none focus:border-indigo-500"
                >
                  {PERMISSION_LEVELS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={!username.trim() || saving}
                  className="px-3 py-2 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed
                    text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                  Share
                </button>
              </div>
            </form>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
              {error}
            </div>
          )}

          {/* Shared users list */}
          <div>
            <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-2">
              Shared with ({shares.length})
            </label>
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-5 h-5 text-dark-400 animate-spin" />
              </div>
            ) : shares.length === 0 ? (
              <div className="text-center py-6 text-xs text-dark-500">
                This board is not shared with anyone yet.
              </div>
            ) : (
              <div className="space-y-2">
                {shares.map(share => {
                  const permLevel = PERMISSION_LEVELS.find(p => p.value === share.permission) || PERMISSION_LEVELS[0];
                  const Icon = permLevel.icon;
                  return (
                    <div key={share.user_id} className="flex items-center gap-3 px-3 py-2.5 bg-dark-800/40 rounded-lg border border-dark-700/30">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${permLevel.cls}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-dark-200 font-medium truncate">
                          {share.display_name || share.username}
                        </div>
                        <div className="text-xs text-dark-500">{share.username}</div>
                      </div>
                      {isOwner ? (
                        <div className="flex items-center gap-1.5">
                          <select
                            value={share.permission}
                            onChange={e => handleUpdatePermission(share.user_id, e.target.value)}
                            className="px-2 py-1 bg-dark-800 border border-dark-700 rounded text-xs text-dark-300
                              focus:outline-none focus:border-indigo-500"
                          >
                            {PERMISSION_LEVELS.map(p => (
                              <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleRevoke(share.user_id, share.display_name || share.username)}
                            className="p-1.5 rounded text-dark-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Revoke access"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${permLevel.cls}`}>
                          {permLevel.label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Permission legend */}
          <div className="pt-2 border-t border-dark-700/50">
            <div className="text-[10px] text-dark-500 uppercase tracking-wider mb-1.5">Permission levels</div>
            <div className="grid grid-cols-3 gap-2">
              {PERMISSION_LEVELS.map(p => {
                const Icon = p.icon;
                return (
                  <div key={p.value} className="text-center">
                    <Icon className={`w-3.5 h-3.5 mx-auto mb-0.5 ${p.cls.split(' ')[0]}`} />
                    <div className="text-[10px] text-dark-400 font-medium">{p.label}</div>
                    <div className="text-[9px] text-dark-600">{p.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end px-5 py-3 border-t border-dark-700">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-sm text-dark-400 hover:bg-dark-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
